import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';

test('PostgreSQL access control, ownership, idempotency and chronology', async (t) => {
  const db = new PGlite({ extensions: { unaccent } });
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema storage;create schema extensions;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text unique,owner_id text);
      create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
      alter table storage.objects enable row level security;
      grant usage on schema public,auth,storage,extensions to anon,authenticated,service_role;
      grant select,insert,delete on storage.objects to authenticated;`);
    let migration = await readFile(
      new URL('../../supabase/migrations/202609130001_patika.sql', import.meta.url),
      'utf8',
    );
    // PGlite does not ship PostGIS. Only the unused spatial column/index is
    // omitted here; all production RLS policies, RPCs and constraints run as-is.
    migration = migration
      .replace('create extension if not exists postgis with schema extensions;', '')
      .replace(
        /  location extensions\.geography\(Point,4326\) generated always as[\s\S]*? stored,\n/,
        '',
      )
      .replace('create index parks_location on public.parks using gist(location);', '');
    await db.exec(migration);
    await db.exec(
      await readFile(
        new URL('../../supabase/migrations/202609130002_park_names.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.exec(
      await readFile(
        new URL('../../supabase/migrations/202609170001_location_verification.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.exec(
      await readFile(
        new URL('../../supabase/migrations/202609170002_points.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.exec(
      await readFile(
        new URL('../../supabase/migrations/202609170003_my_points.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.exec(
      await readFile(
        new URL('../../supabase/migrations/202609170004_points_integrity.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.exec(
      await readFile(
        new URL('../../supabase/migrations/202609180001_leaderboard.sql', import.meta.url),
        'utf8',
      ),
    );
    // Same PostGIS gap as migration 001: only the generated geography column
    // and its gist index are stripped here (table/RLS/GRANT are unaffected).
    // get_vets()'s body still references extensions.st_dwithin/st_makepoint —
    // whether that survives CREATE FUNCTION and an actual call in PGlite is
    // verified by the tests below, not assumed.
    await db.exec(
      (
        await readFile(
          new URL('../../supabase/migrations/202609180002_veterinarians.sql', import.meta.url),
          'utf8',
        )
      )
        .replace(
          /  location extensions\.geography\(Point,4326\) generated always as[\s\S]*? stored,\n/,
          '',
        )
        .replace('create index vets_location on public.veterinarians using gist(location);\n', ''),
    );
    // Same PostGIS gap as above: strip the generated geography column and its
    // gist index only. report_rescue_case never selects `location`, so unlike
    // get_vets it has no untested success-path gap from this stripping.
    await db.exec(
      (
        await readFile(
          new URL('../../supabase/migrations/202609180003_rescue_cases.sql', import.meta.url),
          'utf8',
        )
      )
        .replace(
          /  location extensions\.geography\(Point,4326\) generated always as[\s\S]*? stored,\n/,
          '',
        )
        .replace(
          'create index rescue_cases_location on public.rescue_cases using gist(location);\n',
          '',
        ),
    );
    await db.exec(
      await readFile(
        new URL('../../supabase/migrations/202609180004_rescue_case_claim.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.exec(
      await readFile(
        new URL('../../supabase/migrations/202609180005_rescue_case_status.sql', import.meta.url),
        'utf8',
      ),
    );
    const alice = '11111111-1111-4111-8111-111111111111',
      bob = '22222222-2222-4222-8222-222222222222',
      park = '33333333-3333-4333-8333-333333333333',
      point = '44444444-4444-4444-8444-444444444444',
      id = '55555555-5555-4555-8555-555555555555';
    await db.exec(
      `insert into auth.users values('${alice}','{"display_name":"Arda"}'),('${bob}','{"display_name":"Seyfi"}');insert into public.parks(id,name,latitude,longitude) values('${park}','Test Park',41,29);insert into public.feeding_points(id,park_id,latitude,longitude) values('${point}','${park}',41,29);`,
    );
    async function asUser(uid: string | null, fn: () => Promise<void>, moderator = false) {
      await db.exec(
        `set role ${uid ? 'authenticated' : 'anon'};select set_config('request.jwt.claim.sub','${uid ?? ''}',false);select set_config('request.jwt.claims','${moderator ? '{"app_metadata":{"role":"moderator"}}' : '{}'}',false);`,
      );
      try {
        await fn();
      } finally {
        await db.exec('reset role');
      }
    }
    const payload = {
      id,
      user_id: alice,
      point_id: point,
      park_id: park,
      food_type: 'dry',
      food_grams: 250,
      water_ml: 0,
      note: 'Test',
      photo_path: `${alice}/${id}.jpg`,
      occurred_at: new Date(Date.now() - 60000).toISOString(),
      reported_latitude: 41,
      reported_longitude: 29,
    };
    await t.test('anonymous reads summaries but cannot write', () =>
      asUser(null, async () => {
        const { rows } = await db.query<{ last_fed_at: string | null }>(
          'select * from public.get_park($1)',
          [park],
        );
        assert.equal(rows[0].last_fed_at, null);
        await assert.rejects(
          db.query('select public.submit_feeding($1::jsonb)', [JSON.stringify(payload)]),
          /permission denied/,
        );
      }),
    );
    await t.test('cannot write directly, spoof owner or upload to another owner folder', () =>
      asUser(bob, async () => {
        await assert.rejects(
          db.exec('insert into public.feeding_events(id) values(gen_random_uuid())'),
          /permission denied/,
        );
        await assert.rejects(
          db.query('select public.submit_feeding($1::jsonb)', [JSON.stringify(payload)]),
          /Oturum gerekli/,
        );
        await assert.rejects(
          db.query(
            "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
            [payload.photo_path, bob],
          ),
          /row-level security/,
        );
      }),
    );
    await t.test('requires an uploaded photo; repeat delivery creates one record', () =>
      asUser(alice, async () => {
        await assert.rejects(
          db.query('select public.submit_feeding($1::jsonb)', [JSON.stringify(payload)]),
          /fotoğrafını yükleyin/,
        );
        await db.query(
          "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
          [payload.photo_path, alice],
        );
        for (let i = 0; i < 2; i++)
          await db.query('select public.submit_feeding($1::jsonb)', [JSON.stringify(payload)]);
        const { rows } = await db.query<{ total_records: number }>(
          'select * from public.get_park($1)',
          [park],
        );
        assert.equal(rows[0].total_records, 1);
      }),
    );
    await t.test('cannot remove another user record or escalate moderation', () =>
      asUser(bob, async () => {
        await assert.rejects(db.query('select public.remove_feeding($1)', [id]), /yetkiniz yok/);
        await assert.rejects(
          db.query('select public.resolve_report($1,true)', [id]),
          /Moderatör yetkisi/,
        );
        await assert.rejects(
          db.query('insert into public.favorites values($1,$2,now())', [alice, park]),
          /row-level security/,
        );
      }),
    );
    await t.test('old offline event cannot replace recent last-feeding timestamp', () =>
      asUser(alice, async () => {
        const oldId = '66666666-6666-4666-8666-666666666666';
        const old = {
          ...payload,
          id: oldId,
          photo_path: `${alice}/${oldId}.jpg`,
          food_grams: 900,
          occurred_at: new Date(Date.now() - 14 * 86400000).toISOString(),
        };
        await db.query(
          "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
          [old.photo_path, alice],
        );
        await db.query('select public.submit_feeding($1::jsonb)', [JSON.stringify(old)]);
        const { rows } = await db.query<{ last_grams: number; total_records: number }>(
          'select * from public.get_park($1)',
          [park],
        );
        assert.equal(rows[0].last_grams, 250);
        assert.equal(rows[0].total_records, 2);
      }),
    );
    async function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
      const { rows } = await db.query<{ d: number }>(
        'select public.location_distance_meters($1,$2,$3,$4) as d',
        [lat1, lon1, lat2, lon2],
      );
      return rows[0].d;
    }
    // Dedicated park/point so these inserts never shift total_records counts
    // asserted elsewhere against the shared `park`/`point` fixture.
    const locPark = 'a1111111-1111-4111-8111-111111111111',
      locPoint = 'a2222222-2222-4222-8222-222222222222',
      // Same coordinates as locPoint, distinct ids: let tests exercise more
      // than one successful submit_observation at (41,29) without tripping
      // the per-(user,point) cooldown that now applies to locPoint itself.
      locPoint2 = 'a2222222-2222-4222-8222-222222222223',
      locPoint3 = 'a2222222-2222-4222-8222-222222222225';
    await db.query(
      'insert into public.parks(id,name,latitude,longitude) values($1,$2,41,29)',
      [locPark, 'Konum Testi Parkı'],
    );
    await db.query(
      `insert into public.feeding_points(id,park_id,name,latitude,longitude) values
        ($1,$4,'Konum Testi Noktası',41,29),($2,$4,'Konum Testi Noktası 2',41,29),
        ($3,$4,'Konum Testi Noktası 3',41,29)`,
      [locPoint, locPoint2, locPoint3, locPark],
    );
    await t.test(
      'submit_feeding rejects missing/out-of-range/far location and accepts within 200m',
      () =>
        asUser(alice, async () => {
          async function submitAt(
            customId: string,
            lat: number | string | null,
            lon: number | string | null,
          ) {
            const photoPath = `${alice}/${customId}.jpg`;
            await db.query(
              "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
              [photoPath, alice],
            );
            return db.query('select public.submit_feeding($1::jsonb)', [
              JSON.stringify({
                ...payload,
                id: customId,
                point_id: locPoint,
                park_id: locPark,
                photo_path: photoPath,
                reported_latitude: lat,
                reported_longitude: lon,
              }),
            ]);
          }
          await assert.rejects(
            submitAt('a0000000-0000-4000-8000-000000000001', null, null),
            /Konum bilgisi gerekli/,
          );
          await assert.rejects(
            submitAt('a0000000-0000-4000-8000-000000000002', 95, 29),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            submitAt('a0000000-0000-4000-8000-000000000003', 41, 200),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            submitAt('a0000000-0000-4000-8000-000000000008', -95, 29),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            submitAt('a0000000-0000-4000-8000-000000000009', 'NaN', 29),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            submitAt('a0000000-0000-4000-8000-000000000010', 'Infinity', 29),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            submitAt('a0000000-0000-4000-8000-000000000004', 41.01, 29),
            /Konumunu kontrol edip tekrar dene/,
          );
          await submitAt('a0000000-0000-4000-8000-000000000005', 41, 29);
          {
            const { rows } = await db.query<{
              reported_latitude: number;
              reported_longitude: number;
            }>(
              'select reported_latitude, reported_longitude from public.feeding_events where id=$1',
              ['a0000000-0000-4000-8000-000000000005'],
            );
            assert.equal(rows[0].reported_latitude, 41);
            assert.equal(rows[0].reported_longitude, 29);
          }
          const under = 41 + 199 / 111320;
          const over = 41 + 201 / 111320;
          const dUnder = await distanceMeters(under, 29, 41, 29);
          const dOver = await distanceMeters(over, 29, 41, 29);
          assert.ok(dUnder > 150 && dUnder <= 200, `expected ~200m, got ${dUnder}`);
          assert.ok(dOver > 200 && dOver < 250, `expected ~200m, got ${dOver}`);
          await submitAt('a0000000-0000-4000-8000-000000000006', under, 29);
          await assert.rejects(
            submitAt('a0000000-0000-4000-8000-000000000007', over, 29),
            /Konumunu kontrol edip tekrar dene/,
          );
        }),
    );
    await t.test(
      'submit_observation rejects missing/out-of-range/far location and accepts within 200m',
      async () => {
        let observedId = '';
        await asUser(alice, async () => {
          await assert.rejects(
            db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
              locPoint,
              'full',
              'full',
              '',
              null,
              null,
            ]),
            /Konum bilgisi gerekli/,
          );
          await assert.rejects(
            db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
              locPoint,
              'full',
              'full',
              '',
              41,
              -200,
            ]),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
              locPoint,
              'full',
              'full',
              '',
              -95,
              29,
            ]),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
              locPoint,
              'full',
              'full',
              '',
              'NaN',
              29,
            ]),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
              locPoint,
              'full',
              'full',
              '',
              'Infinity',
              29,
            ]),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
              locPoint,
              'full',
              'full',
              '',
              41.01,
              29,
            ]),
            /Konumunu kontrol edip tekrar dene/,
          );
          {
            const { rows } = await db.query<{ id: string }>(
              'select public.submit_observation($1,$2,$3,$4,$5,$6) as id',
              [locPoint, 'full', 'full', '', 41, 29],
            );
            observedId = rows[0].id;
          }
          const under = 41 + 199 / 111320;
          const over = 41 + 201 / 111320;
          const dUnder = await distanceMeters(under, 29, 41, 29);
          const dOver = await distanceMeters(over, 29, 41, 29);
          assert.ok(dUnder > 150 && dUnder <= 200, `expected ~200m, got ${dUnder}`);
          assert.ok(dOver > 200 && dOver < 250, `expected ~200m, got ${dOver}`);
          // locPoint2 (not locPoint): locPoint already has a fresh observation
          // above and would otherwise trip its own cooldown here.
          await db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
            locPoint2,
            'full',
            'full',
            '',
            under,
            29,
          ]);
          // locPoint3: a third point, so this distance-rejection check isn't
          // shadowed by locPoint2's cooldown from the call just above.
          await assert.rejects(
            db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
              locPoint3,
              'full',
              'full',
              '',
              over,
              29,
            ]),
            /Konumunu kontrol edip tekrar dene/,
          );
        });
        // observations has no client-facing SELECT grant (read-only via
        // get_parks/park_summaries), so verify the persisted row at the
        // ambient/superuser connection level, outside the authenticated role.
        const observed = await db.query<{
          reported_latitude: number;
          reported_longitude: number;
        }>(
          'select reported_latitude, reported_longitude from public.observations where id=$1',
          [observedId],
        );
        assert.equal(observed.rows[0].reported_latitude, 41);
        assert.equal(observed.rows[0].reported_longitude, 29);
      },
    );
    // feeding_points has no lat/lng CHECK constraint (unlike parks, which is
    // bounded to Turkey), so points can be placed at the exact range edges to
    // test the inclusive latitude/longitude boundary in isolation from the
    // 200m distance check (each point is reported at its own exact location).
    const boundaryPark = 'a3333333-3333-4333-8333-333333333333',
      northPole = 'a4444444-4444-4444-8444-444444444444',
      southPole = 'a5555555-5555-4555-8555-555555555555',
      dateline = 'a6666666-6666-4666-8666-666666666666',
      // Same coordinates as `dateline`, distinct id — the +180/-180 pair below
      // are two successful observations for the same user; using two point
      // ids (instead of one) avoids the per-(user,point) cooldown between them.
      dateline2 = 'a6666666-6666-4666-8666-666666666667';
    await db.query(
      'insert into public.parks(id,name,latitude,longitude) values($1,$2,41,29)',
      [boundaryPark, 'Sınır Testi Parkı'],
    );
    await db.query(
      `insert into public.feeding_points(id,park_id,name,latitude,longitude) values
        ($1,$5,'Kuzey Kutbu',90,0),($2,$5,'Güney Kutbu',-90,0),
        ($3,$5,'Tarih Değiştirme Hattı',0,180),($4,$5,'Tarih Değiştirme Hattı 2',0,180)`,
      [northPole, southPole, dateline, dateline2, boundaryPark],
    );
    await t.test(
      'exact range boundaries (latitude ±90, longitude ±180) are accepted',
      () =>
        asUser(alice, async () => {
          async function observeAt(pointId: string, lat: number, lon: number) {
            return db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
              pointId,
              'full',
              'full',
              '',
              lat,
              lon,
            ]);
          }
          await observeAt(northPole, 90, 0);
          await observeAt(southPole, -90, 0);
          await observeAt(dateline, 0, 180);
          // -180 and 180 are the same meridian, so this is still 0m from `dateline2`.
          await observeAt(dateline2, 0, -180);
        }),
    );
    await t.test('private favorites are isolated between users', async () => {
      await asUser(alice, async () => {
        await db.query('insert into public.favorites values($1,$2,now())', [alice, park]);
      });
      await asUser(bob, async () => {
        assert.equal((await db.query('select * from public.favorites')).rows.length, 0);
      });
    });
    await t.test('blocked users disappear from the public activity API', () =>
      asUser(bob, async () => {
        await db.query('select public.block_user($1)', [alice]);
        assert.equal((await db.query('select * from public.list_feedings()')).rows.length, 0);
      }),
    );
    await t.test('owner removal hides the record from other readers', async () => {
      await asUser(alice, async () => {
        await db.query('select public.remove_feeding($1)', [id]);
      });
      await asUser(null, async () => {
        const { rows } = await db.query<{ total_records: number }>(
          'select * from public.get_park($1)',
          [park],
        );
        assert.equal(rows[0].total_records, 1);
      });
    });
    await t.test('missing owner is rejected even with a valid session', () =>
      asUser(alice, async () => {
        await assert.rejects(
          db.query('select public.submit_feeding($1::jsonb)', [
            JSON.stringify({ ...payload, user_id: null }),
          ]),
          /Oturum gerekli/,
        );
      }),
    );
    await t.test('equal timestamps paginate without skipping records', async () => {
      const secondPark = '77777777-7777-4777-8777-777777777777';
      await db.query('insert into public.parks(id,name,latitude,longitude) values($1,$2,40,30)', [
        secondPark,
        'Sayfalama parkı',
      ]);
      await db.query(
        'insert into public.feeding_points(id,park_id,latitude,longitude) values($1,$1,40,30)',
        [secondPark],
      );
      await db.query(
        `insert into public.feeding_events(id,user_id,point_id,park_id,food_type,food_grams,water_ml,photo_path,occurred_at) select ('88888888-8888-4888-8888-'||lpad(n::text,12,'0'))::uuid,$1,$2,$2,'dry',100,0,'pagination/'||n,$3 from generate_series(1,31) as n`,
        [alice, secondPark, payload.occurred_at],
      );
      await asUser(null, async () => {
        const first = await db.query<{ id: string; occurred_at: string }>(
          'select * from public.list_feedings($1)',
          [secondPark],
        );
        assert.equal(first.rows.length, 30);
        const last = first.rows[29];
        const second = await db.query<{ id: string }>(
          'select * from public.list_feedings($1,false,$2,$3)',
          [secondPark, last.occurred_at, last.id],
        );
        assert.equal(second.rows.length, 1);
        assert.ok(!first.rows.some((e) => e.id === second.rows[0].id));
      });
    });
    await t.test(
      'park name suggestions enforce identity, private reads and moderation',
      async () => {
        const namePark = '99999999-9999-4999-8999-999999999999';
        await db.query(
          "insert into public.parks(id,name,name_status,latitude,longitude) values($1,'İsimsiz park','missing',41,29)",
          [namePark],
        );
        await asUser(null, async () => {
          await assert.rejects(
            db.query('select public.suggest_park_name($1,$2,$3)', [
              namePark,
              'Pınar Parkı',
              'Giriş tabelasındaki ad.',
            ]),
            /permission denied/,
          );
        });
        let proposal = '';
        await asUser(alice, async () => {
          for (const bad of ['ab', 'Park', '<script>Park</script>', 'https://park.example'])
            await assert.rejects(
              db.query('select public.suggest_park_name($1,$2,$3)', [
                namePark,
                bad,
                'Giriş tabelasındaki ad.',
              ]),
              /Geçerli/,
            );
          await assert.rejects(
            db.query('select public.suggest_park_name($1,$2,$3)', [
              namePark,
              'Pınar Parkı',
              'kısa',
            ]),
            /10–600/,
          );
          const submit = () =>
            db.query<{ id: string }>('select public.suggest_park_name($1,$2,$3) as id', [
              namePark,
              'Pınar Parkı',
              'Giriş tabelasındaki ad.',
            ]);
          proposal = (await submit()).rows[0].id;
          assert.equal((await submit()).rows[0].id, proposal);
          await assert.rejects(
            db.query('select public.suggest_park_name($1,$2,$3)', [
              namePark,
              'Başka Park',
              'Başka bir tabeladaki ad.',
            ]),
            /zaten/,
          );
          assert.equal(
            (await db.query('select * from public.list_park_name_suggestions($1)', [namePark])).rows
              .length,
            1,
          );
          await assert.rejects(
            db.query("update public.park_name_suggestions set status='approved' where id=$1", [
              proposal,
            ]),
            /permission denied/,
          );
          assert.equal(
            (await db.query<{ name: string }>('select * from public.get_park($1)', [namePark]))
              .rows[0].name,
            'İsimsiz park',
          );
        });
        await asUser(bob, async () => {
          assert.equal(
            (await db.query('select * from public.park_name_suggestions')).rows.length,
            0,
          );
          assert.equal(
            (await db.query('select * from public.list_park_name_suggestions($1)', [namePark])).rows
              .length,
            0,
          );
          await db.exec(
            `select set_config('request.jwt.claims','{"user_metadata":{"role":"moderator"}}',false)`,
          );
          await assert.rejects(
            db.query('select public.review_park_name($1,true,$2)', [
              proposal,
              'Belediye kaydı kontrol edildi.',
            ]),
            /Moderatör/,
          );
        });
        await asUser(
          alice,
          async () => {
            await assert.rejects(
              db.query('select public.review_park_name($1,true,$2)', [
                proposal,
                'Belediye kaydı kontrol edildi.',
              ]),
              /Kendi/,
            );
          },
          true,
        );
        await asUser(
          bob,
          async () => {
            await assert.rejects(
              db.query('select public.review_park_name($1,true,$2)', [proposal, 'kısa']),
              /inceleme notu/,
            );
            await db.query('select public.review_park_name($1,true,$2)', [
              proposal,
              'Belediye kaydı ve tabela kontrol edildi.',
            ]);
            await assert.rejects(
              db.query('select public.review_park_name($1,true,$2)', [
                proposal,
                'Yeniden kontrol edildi.',
              ]),
              /zaten incelenmiş/,
            );
          },
          true,
        );
        await asUser(null, async () => {
          const p = (
            await db.query<{ name: string; name_status: string }>(
              'select * from public.get_park($1)',
              [namePark],
            )
          ).rows[0];
          assert.equal(p.name, 'Pınar Parkı');
          assert.equal(p.name_status, 'community');
          assert.equal(
            (await db.query('select * from public.get_parks(40,42,28,30,$1)', ['Pınar Parkı'])).rows
              .length,
            1,
          );
        });
        // Re-importing OSM data preserves the accepted name and its attribution.
        await db.query(
          "update public.parks set name='İsimsiz park',name_status='missing',name_source='OpenStreetMap' where id=$1",
          [namePark],
        );
        assert.equal(
          (
            await db.query<{ name: string }>('select name from public.parks where id=$1', [
              namePark,
            ])
          ).rows[0].name,
          'Pınar Parkı',
        );
        await asUser(alice, async () => {
          const row = (
            await db.query<{ status: string; review_note: string }>(
              'select * from public.list_park_name_suggestions($1)',
              [namePark],
            )
          ).rows[0];
          assert.equal(row.status, 'approved');
          assert.match(row.review_note, /Belediye/);
        });
        let rejected = '';
        await asUser(alice, async () => {
          rejected = (
            await db.query<{ id: string }>('select public.suggest_park_name($1,$2,$3) as id', [
              namePark,
              'Yanlış Park',
              'Farklı kaynakta görülen ad.',
            ])
          ).rows[0].id;
        });
        await asUser(
          bob,
          async () => {
            await db.query('select public.review_park_name($1,false,$2)', [
              rejected,
              'Kaynak farklı bir parka ait.',
            ]);
          },
          true,
        );
        assert.equal(
          (
            await db.query<{ name: string }>('select name from public.parks where id=$1', [
              namePark,
            ])
          ).rows[0].name,
          'Pınar Parkı',
        );
        let stale = '';
        await asUser(alice, async () => {
          stale = (
            await db.query<{ id: string }>('select public.suggest_park_name($1,$2,$3) as id', [
              namePark,
              'Eski Öneri Parkı',
              'Eski kayıttan gelen bir öneri.',
            ])
          ).rows[0].id;
        });
        await db.query("update public.parks set name='Güncel Park' where id=$1", [namePark]);
        await asUser(
          bob,
          async () => {
            await assert.rejects(
              db.query('select public.review_park_name($1,true,$2)', [
                stale,
                'Eski kaynağı kontrol ettim.',
              ]),
              /Park adı değişti/,
            );
          },
          true,
        );
      },
    );
    await t.test('point_transactions: authenticated user cannot insert directly', () =>
      asUser(alice, async () => {
        await assert.rejects(
          db.query(
            "insert into public.point_transactions(user_id,source_type,source_id,points) values($1,'feeding',gen_random_uuid(),999)",
            [alice],
          ),
          /permission denied/,
        );
      }),
    );
    function feedingPayload(id: string, userId: string, photoPath: string, lat: number, lon: number) {
      return {
        id,
        user_id: userId,
        point_id: locPoint,
        park_id: locPark,
        food_type: 'dry',
        food_grams: 100,
        water_ml: 0,
        note: '',
        photo_path: photoPath,
        occurred_at: new Date().toISOString(),
        reported_latitude: lat,
        reported_longitude: lon,
      };
    }
    await t.test(
      'submit_feeding produces exactly one 10-point transaction; retry does not duplicate',
      () =>
        asUser(alice, async () => {
          const id = 'd0000000-0000-4000-8000-000000000001';
          const photoPath = `${alice}/${id}.jpg`;
          await db.query(
            "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
            [photoPath, alice],
          );
          const body = JSON.stringify(feedingPayload(id, alice, photoPath, 41, 29));
          await db.query('select public.submit_feeding($1::jsonb)', [body]);
          // Same id again: submit_feeding's own idempotency guard returns early,
          // so this must not add a second point_transactions row.
          await db.query('select public.submit_feeding($1::jsonb)', [body]);
          const { rows } = await db.query<{
            source_type: string;
            points: number;
            user_id: string;
          }>('select source_type, points, user_id from public.point_transactions where source_id=$1', [
            id,
          ]);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].source_type, 'feeding');
          assert.equal(rows[0].points, 10);
          assert.equal(rows[0].user_id, alice);
        }),
    );
    await t.test('submit_observation produces exactly one 2-point transaction', async () => {
      // A fresh, dedicated point: alice already has recent observations at
      // locPoint/locPoint2 from earlier tests and would trip the cooldown there.
      const pointId = 'a2222222-2222-4222-8222-222222222224';
      await db.query(
        'insert into public.feeding_points(id,park_id,name,latitude,longitude) values($1,$2,$3,41,29)',
        [pointId, locPark, 'Puan Testi Noktası'],
      );
      await asUser(alice, async () => {
        const { rows: submitted } = await db.query<{ id: string }>(
          'select public.submit_observation($1,$2,$3,$4,$5,$6) as id',
          [pointId, 'full', 'full', '', 41, 29],
        );
        const { rows } = await db.query<{ source_type: string; points: number }>(
          'select source_type, points from public.point_transactions where source_id=$1',
          [submitted[0].id],
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source_type, 'observation');
        assert.equal(rows[0].points, 2);
      });
    });
    await t.test('rejected feeding and observation produce no point_transactions', () =>
      asUser(alice, async () => {
        const countFor = async (userId: string) =>
          (
            await db.query<{ c: number }>(
              'select count(*)::int as c from public.point_transactions where user_id=$1',
              [userId],
            )
          ).rows[0].c;
        const before = await countFor(alice);
        const id = 'd0000000-0000-4000-8000-000000000002';
        const photoPath = `${alice}/${id}.jpg`;
        await db.query(
          "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
          [photoPath, alice],
        );
        // ~1.1km from locPoint (41,29) — rejected by T3's 200m check.
        await assert.rejects(
          db.query('select public.submit_feeding($1::jsonb)', [
            JSON.stringify(feedingPayload(id, alice, photoPath, 41.01, 29)),
          ]),
        );
        await assert.rejects(
          db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
            locPoint,
            'full',
            'full',
            '',
            41.01,
            29,
          ]),
        );
        assert.equal(await countFor(alice), before);
      }),
    );
    // A dedicated third user: `bob` is relied on elsewhere (e.g. "blocked
    // users disappear from the public activity API") to have never
    // published a feeding, so earning points here must not touch bob.
    const carol = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await db.query("insert into auth.users(id,raw_user_meta_data) values($1,'{\"display_name\":\"Carol\"}')", [
      carol,
    ]);
    await t.test('SUM(points) aggregates correctly for a user', () =>
      asUser(carol, async () => {
        const id = 'd0000000-0000-4000-8000-000000000003';
        const photoPath = `${carol}/${id}.jpg`;
        await db.query(
          "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
          [photoPath, carol],
        );
        await db.query('select public.submit_feeding($1::jsonb)', [
          JSON.stringify(feedingPayload(id, carol, photoPath, 41, 29)),
        ]);
        await db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
          locPoint,
          'full',
          'full',
          '',
          41,
          29,
        ]);
        const { rows } = await db.query<{ total: number }>(
          'select coalesce(sum(points),0)::int as total from public.point_transactions where user_id=$1',
          [carol],
        );
        // carol has no other point_transactions in this suite: 10 (feeding) + 2 (observation).
        assert.equal(rows[0].total, 12);
      }),
    );
    await t.test('point_transactions RLS: users see only their own rows', async () => {
      await asUser(alice, async () => {
        const { rows } = await db.query<{ user_id: string }>(
          'select user_id from public.point_transactions',
        );
        assert.ok(rows.length > 0);
        assert.ok(rows.every((r) => r.user_id === alice));
      });
      await asUser(carol, async () => {
        const { rows } = await db.query<{ user_id: string }>(
          'select user_id from public.point_transactions',
        );
        assert.ok(rows.length > 0);
        assert.ok(rows.every((r) => r.user_id === carol));
      });
      await asUser(null, async () => {
        await assert.rejects(
          db.query('select * from public.point_transactions'),
          /permission denied/,
        );
      });
    });
    await t.test('get_my_points returns the caller\'s own total', () =>
      asUser(carol, async () => {
        // carol earned exactly 10 (feeding) + 2 (observation) points earlier in this suite.
        const { rows } = await db.query<{ total: number }>(
          'select public.get_my_points() as total',
        );
        assert.equal(rows[0].total, 12);
      }),
    );
    await t.test('get_my_points returns 0 for a user with no transactions', () =>
      asUser(bob, async () => {
        const { rows } = await db.query<{ total: number }>(
          'select public.get_my_points() as total',
        );
        assert.equal(rows[0].total, 0);
      }),
    );
    await t.test('get_my_points is rejected for anon', () =>
      asUser(null, async () => {
        await assert.rejects(
          db.query('select public.get_my_points()'),
          /permission denied/,
        );
      }),
    );
    await t.test('point_transactions_active: RLS applies through the view', async () => {
      await asUser(alice, async () => {
        const { rows } = await db.query<{ user_id: string }>(
          'select user_id from public.point_transactions_active',
        );
        assert.ok(rows.length > 0);
        assert.ok(rows.every((r) => r.user_id === alice));
      });
      await asUser(carol, async () => {
        const { rows } = await db.query<{ user_id: string }>(
          'select user_id from public.point_transactions_active',
        );
        assert.ok(rows.length > 0);
        assert.ok(rows.every((r) => r.user_id === carol));
      });
      await asUser(null, async () => {
        await assert.rejects(
          db.query('select * from public.point_transactions_active'),
          /permission denied/,
        );
      });
    });
    await t.test(
      'deleted/hidden feeding keeps its point_transactions row but drops out of the active total',
      async () => {
        // asUser's cleanup only resets the role, not the JWT claim GUCs it sets —
        // nesting a second asUser(...) call inside this one would leak bob's
        // identity into auth.uid() for the rest of this callback. Every step
        // below is its own top-level asUser call instead, matching the
        // sequential (never nested) pattern already used for the moderation
        // flow in the "park name suggestions" test further down this file.
        const activeFeedId = 'e0000000-0000-4000-8000-000000000001';
        const deletedFeedId = 'e0000000-0000-4000-8000-000000000002';
        const hiddenFeedId = 'e0000000-0000-4000-8000-000000000003';
        let base = 0;
        let reportId = '';
        async function submitFeed(feedId: string) {
          const photoPath = `${alice}/${feedId}.jpg`;
          await db.query(
            "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
            [photoPath, alice],
          );
          await db.query('select public.submit_feeding($1::jsonb)', [
            JSON.stringify(feedingPayload(feedId, alice, photoPath, 41, 29)),
          ]);
        }
        await asUser(alice, async () => {
          base = (
            await db.query<{ total: number }>('select public.get_my_points() as total')
          ).rows[0].total;
          await submitFeed(activeFeedId);
          await submitFeed(deletedFeedId);
          assert.equal(
            (await db.query<{ total: number }>('select public.get_my_points() as total')).rows[0]
              .total,
            base + 20,
          );
          // remove_feeding soft-deletes: point_transactions must survive, active total must not.
          await db.query('select public.remove_feeding($1)', [deletedFeedId]);
        });
        const afterDelete = await db.query<{ c: number }>(
          'select count(*)::int as c from public.point_transactions where source_id=$1',
          [deletedFeedId],
        );
        assert.equal(afterDelete.rows[0].c, 1);
        await asUser(alice, async () => {
          assert.equal(
            (await db.query<{ total: number }>('select public.get_my_points() as total')).rows[0]
              .total,
            base + 10,
          );
          // Mixed state check: activeFeedId (published) still counts, deletedFeedId does not —
          // exactly the "published + deleted karışımı" scenario.
          await submitFeed(hiddenFeedId);
          await db.query('select public.report_item($1,$2,$3,$4)', [
            'abuse',
            'Test report for hide flow.',
            null,
            hiddenFeedId,
          ]);
          reportId = (
            await db.query<{ id: string }>(
              'select id from public.reports where feeding_id=$1 order by created_at desc limit 1',
              [hiddenFeedId],
            )
          ).rows[0].id;
        });
        await asUser(
          bob,
          async () => {
            await db.query('select public.resolve_report($1,true)', [reportId]);
          },
          true,
        );
        const afterHide = await db.query<{ c: number }>(
          'select count(*)::int as c from public.point_transactions where source_id=$1',
          [hiddenFeedId],
        );
        assert.equal(afterHide.rows[0].c, 1);
        await asUser(alice, async () => {
          assert.equal(
            (await db.query<{ total: number }>('select public.get_my_points() as total')).rows[0]
              .total,
            base + 10,
          );
        });
      },
    );
    await t.test('observation points still count toward the active total', async () => {
      const point = 'e4444444-4444-4444-8444-444444444444';
      await db.query(
        'insert into public.parks(id,name,latitude,longitude) values($1,$2,41,29)',
        ['e5555555-5555-4555-8555-555555555555', 'Puan Testi Parkı'],
      );
      await db.query(
        'insert into public.feeding_points(id,park_id,latitude,longitude) values($1,$2,41,29)',
        [point, 'e5555555-5555-4555-8555-555555555555'],
      );
      await asUser(alice, async () => {
        const before = (
          await db.query<{ total: number }>('select public.get_my_points() as total')
        ).rows[0].total;
        await db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
          point,
          'full',
          'full',
          '',
          41,
          29,
        ]);
        const after = (
          await db.query<{ total: number }>('select public.get_my_points() as total')
        ).rows[0].total;
        assert.equal(after, before + 2);
      });
    });
    await t.test('submit_observation cooldown: same user + same point within 30 minutes', async () => {
      const cooldownPark = 'e6666666-6666-4666-8666-666666666666',
        pointA = 'e7777777-7777-4777-8777-777777777777',
        pointB = 'e8888888-8888-4888-8888-888888888888';
      await db.query(
        'insert into public.parks(id,name,latitude,longitude) values($1,$2,41,29)',
        [cooldownPark, 'Cooldown Testi Parkı'],
      );
      await db.query(
        `insert into public.feeding_points(id,park_id,name,latitude,longitude) values
          ($1,$3,'Nokta A',41,29),($2,$3,'Nokta B',41,29)`,
        [pointA, pointB, cooldownPark],
      );
      await asUser(alice, async () => {
        await db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
          pointA,
          'full',
          'full',
          '',
          41,
          29,
        ]);
        // Same user, same point, within the cooldown window: rejected.
        await assert.rejects(
          db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
            pointA,
            'full',
            'full',
            '',
            41,
            29,
          ]),
          /Bu noktayı yakın zamanda kontrol ettin/,
        );
        // Same user, different point: not subject to pointA's cooldown.
        await db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
          pointB,
          'full',
          'full',
          '',
          41,
          29,
        ]);
      });
      // Backdate pointA's observation past the cooldown window (ambient role —
      // observations has no client-facing UPDATE grant) and retry: accepted.
      await db.query(
        "update public.observations set observed_at=now()-interval '31 minutes' where user_id=$1 and point_id=$2",
        [alice, pointA],
      );
      await asUser(alice, async () => {
        await db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
          pointA,
          'full',
          'full',
          '',
          41,
          29,
        ]);
      });
    });
    await t.test('submit_observation hourly rate limit still applies (regression)', async () => {
      // A brand new user with zero prior observations, so the 20/hour count is exact.
      const dave = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      await db.query(
        "insert into auth.users(id,raw_user_meta_data) values($1,'{\"display_name\":\"Dave\"}')",
        [dave],
      );
      const rateLimitPark = 'e9999999-9999-4999-8999-999999999999';
      await db.query(
        'insert into public.parks(id,name,latitude,longitude) values($1,$2,41,29)',
        [rateLimitPark, 'Rate Limit Testi Parkı'],
      );
      const points: string[] = [];
      for (let i = 0; i < 21; i++) {
        const pid = `ea000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        points.push(pid);
        await db.query(
          'insert into public.feeding_points(id,park_id,name,latitude,longitude) values($1,$2,$3,41,29)',
          [pid, rateLimitPark, `Nokta ${i}`],
        );
      }
      await asUser(dave, async () => {
        for (let i = 0; i < 20; i++) {
          await db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
            points[i],
            'full',
            'full',
            '',
            41,
            29,
          ]);
        }
        await assert.rejects(
          db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
            points[20],
            'full',
            'full',
            '',
            41,
            29,
          ]),
          /Gözlem sınırına ulaşıldı/,
        );
      });
    });
    await t.test(
      'get_leaderboard: only active points count (hidden/deleted feeding excluded, observation included), display_name visible cross-user',
      async () => {
        const erin = 'fd111111-1111-4111-8111-111111111111';
        await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)', [
          erin,
          JSON.stringify({ display_name: 'Erin Puan Testi' }),
        ]);
        const keptFeedId = 'fd222222-2222-4222-8222-222222222222';
        const deletedFeedId = 'fd333333-3333-4333-8333-333333333333';
        const hiddenFeedId = 'fd444444-4444-4444-8444-444444444444';
        let reportId = '';
        await asUser(erin, async () => {
          for (const feedId of [keptFeedId, deletedFeedId, hiddenFeedId]) {
            const photoPath = `${erin}/${feedId}.jpg`;
            await db.query(
              "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
              [photoPath, erin],
            );
            await db.query('select public.submit_feeding($1::jsonb)', [
              JSON.stringify(feedingPayload(feedId, erin, photoPath, 41, 29)),
            ]);
          }
          await db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
            locPoint,
            'full',
            'full',
            '',
            41,
            29,
          ]);
          await db.query('select public.remove_feeding($1)', [deletedFeedId]);
          await db.query('select public.report_item($1,$2,$3,$4)', [
            'abuse',
            'Test report for leaderboard hide flow.',
            null,
            hiddenFeedId,
          ]);
          reportId = (
            await db.query<{ id: string }>(
              'select id from public.reports where feeding_id=$1 order by created_at desc limit 1',
              [hiddenFeedId],
            )
          ).rows[0].id;
        });
        await asUser(
          bob,
          async () => {
            await db.query('select public.resolve_report($1,true)', [reportId]);
          },
          true,
        );
        // Queried as bob, not erin: also proves display_name is visible cross-user.
        await asUser(bob, async () => {
          const { rows } = await db.query<{
            user_id: string;
            display_name: string;
            total_points: number;
          }>('select * from public.get_leaderboard(100)');
          const row = rows.find((r) => r.user_id === erin);
          assert.ok(row, 'erin should appear in the leaderboard');
          assert.equal(row?.display_name, 'Erin Puan Testi');
          // kept feeding (10) + observation (2) = 12; deleted and hidden feedings excluded.
          assert.equal(row?.total_points, 12);
        });
      },
    );
    await t.test('get_leaderboard returns only user_id, display_name and total_points columns', () =>
      asUser(alice, async () => {
        const { rows } = await db.query<{
          user_id: string;
          display_name: string;
          total_points: number;
        }>('select * from public.get_leaderboard(5)');
        assert.ok(rows.length > 0);
        assert.deepEqual(Object.keys(rows[0]).sort(), ['display_name', 'total_points', 'user_id']);
      }),
    );
    await t.test('get_leaderboard is rejected for anon', () =>
      asUser(null, async () => {
        await assert.rejects(db.query('select public.get_leaderboard(10)'), /permission denied/);
      }),
    );
    await t.test('leaderboard_summary view cannot be selected directly by authenticated', () =>
      asUser(alice, async () => {
        await assert.rejects(
          db.query('select * from public.leaderboard_summary'),
          /permission denied/,
        );
      }),
    );
    await t.test('get_leaderboard clamps p_limit to [1,100]', async () => {
      // 105 synthetic scorers, one point_transactions row each — enough to prove
      // the upper clamp deterministically (total distinct scorers now exceeds 100).
      await db.exec(`
        insert into auth.users(id,raw_user_meta_data)
        select ('f'||lpad(to_hex(g),7,'0')||'-1111-4111-8111-111111111111')::uuid,
               jsonb_build_object('display_name','Puanlı Kullanıcı '||g)
        from generate_series(1,105) g;
        insert into public.point_transactions(user_id,source_type,source_id,points)
        select ('f'||lpad(to_hex(g),7,'0')||'-1111-4111-8111-111111111111')::uuid,
               'observation',gen_random_uuid(),1
        from generate_series(1,105) g;
      `);
      await asUser(alice, async () => {
        const over = await db.query('select public.get_leaderboard(1000)');
        assert.equal(over.rows.length, 100);
        const under = await db.query('select public.get_leaderboard(0)');
        assert.equal(under.rows.length, 1);
      });
    });
    await t.test('get_leaderboard orders ties by total_points desc, user_id asc', async () => {
      const tieA = 'fc111111-1111-4111-8111-111111111111';
      const tieB = 'fc222222-2222-4222-8222-222222222222';
      await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2),($3,$4)', [
        tieA,
        JSON.stringify({ display_name: 'Eşit Puan A' }),
        tieB,
        JSON.stringify({ display_name: 'Eşit Puan B' }),
      ]);
      await db.query(
        `insert into public.point_transactions(user_id,source_type,source_id,points) values
          ($1,'observation',gen_random_uuid(),500),($2,'observation',gen_random_uuid(),500)`,
        [tieA, tieB],
      );
      await asUser(alice, async () => {
        const { rows } = await db.query<{ user_id: string }>(
          'select user_id from public.get_leaderboard(2)',
        );
        assert.equal(rows[0].user_id, tieA);
        assert.equal(rows[1].user_id, tieB);
      });
    });
    const vetActive = 'fe111111-1111-4111-8111-111111111111',
      vetInactive = 'fe222222-2222-4222-8222-222222222222';
    await t.test('veterinarians: empty table returns no rows, no error', () =>
      asUser(null, async () => {
        const { rows } = await db.query('select * from public.veterinarians');
        assert.equal(rows.length, 0);
      }),
    );
    await db.query(
      `insert into public.veterinarians(id,name,latitude,longitude,active) values
        ($1,'Aktif Veteriner',41,29,true),($2,'Pasif Veteriner',41,29,false)`,
      [vetActive, vetInactive],
    );
    await t.test(
      'veterinarians: active=true is readable by anon and authenticated, active=false is not',
      async () => {
        for (const uid of [null, alice]) {
          await asUser(uid, async () => {
            const { rows } = await db.query<{ id: string }>(
              'select id from public.veterinarians',
            );
            assert.deepEqual(rows.map((r) => r.id), [vetActive]);
          });
        }
      },
    );
    await t.test('veterinarians: direct insert/update/delete are rejected for authenticated', () =>
      asUser(alice, async () => {
        await assert.rejects(
          db.query("insert into public.veterinarians(name,latitude,longitude) values('x',0,0)"),
          /permission denied/,
        );
        await assert.rejects(
          db.query('update public.veterinarians set active=false where id=$1', [vetActive]),
          /permission denied/,
        );
        await assert.rejects(
          db.query('delete from public.veterinarians where id=$1', [vetActive]),
          /permission denied/,
        );
      }),
    );
    await t.test(
      'get_vets: invalid coordinates and non-positive radius are rejected (real production validation path)',
      () =>
        asUser(null, async () => {
          await assert.rejects(
            db.query('select public.get_vets($1,$2,$3)', [91, 29, null]),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            db.query('select public.get_vets($1,$2,$3)', [41, 181, null]),
            /Geçersiz konum koordinatı/,
          );
          await assert.rejects(
            db.query('select public.get_vets($1,$2,$3)', [null, null, 0]),
            /Geçersiz yarıçap/,
          );
          await assert.rejects(
            db.query('select public.get_vets($1,$2,$3)', [null, null, -10]),
            /Geçersiz yarıçap/,
          );
        }),
    );
    await t.test(
      'get_vets: authenticated also reaches the validation path (EXECUTE grant is not the blocker)',
      () =>
        asUser(alice, async () => {
          await assert.rejects(
            db.query('select public.get_vets($1,$2,$3)', [null, null, -1]),
            /Geçersiz yarıçap/,
          );
        }),
    );
    // get_vets()'s data-returning path (empty result via RPC, active-only
    // filtering via RPC, radius clamp, proximity filter) is NOT exercised
    // above. PGlite has no PostGIS extension, so the stripped test schema has
    // no `location` column; any call whose arguments pass validation reaches
    // `return query ... v.location ...` and fails with
    // "column v.location does not exist" — confirmed while writing this
    // suite, not assumed. Only the pre-query validation branches (raised
    // before that statement runs) are real, tested production code paths
    // here. The success path needs a real Postgres+PostGIS instance (e.g.
    // `supabase start`) to verify; it is not covered by this repo's
    // automated tests.

    function rescuePhotoPath(uid: string, id: string) {
      return `${uid}/rescue-cases/${id}.jpg`;
    }
    async function insertRescuePhoto(uid: string, path: string) {
      await db.query(
        "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
        [path, uid],
      );
    }
    const rescueId = 'aa111111-1111-4111-8111-111111111111';
    await t.test('report_rescue_case: anon cannot call the RPC, cannot read rescue_cases', () =>
      asUser(null, async () => {
        await assert.rejects(
          db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            rescueId,
            41,
            29,
            'Test',
            'Yaralı',
            rescuePhotoPath(alice, rescueId),
          ]),
          /permission denied/,
        );
        await assert.rejects(db.query('select * from public.rescue_cases'), /permission denied/);
      }),
    );
    await t.test('rescue_cases: direct insert/update/delete are rejected for authenticated', () =>
      asUser(alice, async () => {
        await assert.rejects(
          db.query(
            "insert into public.rescue_cases(id,reporter_user_id,latitude,longitude,animal_condition,photo_path) values(gen_random_uuid(),$1,0,0,'x','x/rescue-cases/y.jpg')",
            [alice],
          ),
          /permission denied/,
        );
        await assert.rejects(
          db.query("update public.rescue_cases set status='resolved' where id=$1", [rescueId]),
          /permission denied/,
        );
        await assert.rejects(
          db.query('delete from public.rescue_cases where id=$1', [rescueId]),
          /permission denied/,
        );
      }),
    );
    await t.test('report_rescue_case requires an uploaded photo', () =>
      asUser(alice, async () => {
        await assert.rejects(
          db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            rescueId,
            41,
            29,
            'Yolun kenarında yatıyor.',
            'Bacağından yaralı',
            rescuePhotoPath(alice, rescueId),
          ]),
          /bildirim fotoğrafını yükleyin/,
        );
      }),
    );
    await t.test('report_rescue_case rejects out-of-range coordinates', () =>
      asUser(alice, async () => {
        const path = rescuePhotoPath(alice, rescueId);
        await insertRescuePhoto(alice, path);
        await assert.rejects(
          db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            rescueId,
            95,
            29,
            'Test',
            'Yaralı',
            path,
          ]),
          /Geçersiz konum koordinatı/,
        );
        await assert.rejects(
          db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            rescueId,
            41,
            -200,
            'Test',
            'Yaralı',
            path,
          ]),
          /Geçersiz konum koordinatı/,
        );
        await assert.rejects(
          db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            rescueId,
            null,
            29,
            'Test',
            'Yaralı',
            path,
          ]),
          /Konum bilgisi gerekli/,
        );
      }),
    );
    await t.test(
      'report_rescue_case: successful report is reported/unassigned; same id + same reporter retries as a no-op; same id from another user is rejected',
      async () => {
        const path = rescuePhotoPath(alice, rescueId);
        await asUser(alice, async () => {
          // Photo already uploaded by the previous (failed-then-fixed) test above —
          // this mirrors the real retry scenario: upload succeeds once, the RPC
          // call is what gets retried.
          const { rows: first } = await db.query<{ report_rescue_case: string }>(
            'select public.report_rescue_case($1,$2,$3,$4,$5,$6)',
            [rescueId, 41, 29, 'Yolun kenarında yatıyor.', 'Bacağından yaralı', path],
          );
          assert.equal(first[0].report_rescue_case, rescueId);
          const { rows: second } = await db.query<{ report_rescue_case: string }>(
            'select public.report_rescue_case($1,$2,$3,$4,$5,$6)',
            [rescueId, 41, 29, 'Yolun kenarında yatıyor.', 'Bacağından yaralı', path],
          );
          assert.equal(second[0].report_rescue_case, rescueId);
        });
        const { rows } = await db.query<{
          status: string;
          reporter_user_id: string;
          assigned_volunteer_id: string | null;
          assigned_vet_id: string | null;
        }>(
          'select status, reporter_user_id, assigned_volunteer_id, assigned_vet_id from public.rescue_cases where id=$1',
          [rescueId],
        );
        // Retry above must not have created a second row.
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'reported');
        assert.equal(rows[0].reporter_user_id, alice);
        assert.equal(rows[0].assigned_volunteer_id, null);
        assert.equal(rows[0].assigned_vet_id, null);
        await asUser(bob, async () => {
          const bobPath = rescuePhotoPath(bob, rescueId);
          await insertRescuePhoto(bob, bobPath);
          await assert.rejects(
            db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
              rescueId,
              41,
              29,
              'Başka birinin vakası',
              'Yaralı',
              bobPath,
            ]),
            /İşlem kimliği kullanılamıyor/,
          );
          // Authenticated users other than the reporter can still read the case.
          const { rows: readRows } = await db.query<{ id: string; reporter_user_id: string }>(
            'select id, reporter_user_id from public.rescue_cases where id=$1',
            [rescueId],
          );
          assert.equal(readRows.length, 1);
          assert.equal(readRows[0].reporter_user_id, alice);
        });
      },
    );
    await t.test('rescue_cases.assigned_vet_id is a real foreign key to veterinarians(id)', async () => {
      const { rows } = await db.query<{ table_name: string; column_name: string }>(
        `select ccu.table_name, ccu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu on kcu.constraint_name=tc.constraint_name and kcu.table_name=tc.table_name
         join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name
         where tc.table_name='rescue_cases' and tc.constraint_type='FOREIGN KEY' and kcu.column_name='assigned_vet_id'`,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].table_name, 'veterinarians');
      assert.equal(rows[0].column_name, 'id');
    });
    await t.test('rescue_cases: description/animal_condition length constraints are enforced', () =>
      asUser(alice, async () => {
        const tooLongDescription = 'fb000000-0000-4000-8000-000000000001';
        const p1 = rescuePhotoPath(alice, tooLongDescription);
        await insertRescuePhoto(alice, p1);
        await assert.rejects(
          db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            tooLongDescription,
            41,
            29,
            'x'.repeat(501),
            'Yaralı',
            p1,
          ]),
        );
        const emptyCondition = 'fb000000-0000-4000-8000-000000000002';
        const p2 = rescuePhotoPath(alice, emptyCondition);
        await insertRescuePhoto(alice, p2);
        await assert.rejects(
          db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            emptyCondition,
            41,
            29,
            'Test',
            '',
            p2,
          ]),
        );
        const tooLongCondition = 'fb000000-0000-4000-8000-000000000003';
        const p3 = rescuePhotoPath(alice, tooLongCondition);
        await insertRescuePhoto(alice, p3);
        await assert.rejects(
          db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            tooLongCondition,
            41,
            29,
            'Test',
            'x'.repeat(201),
            p3,
          ]),
        );
      }),
    );
    const finn = 'fa111111-1111-4111-8111-111111111111';
    await db.query(
      "insert into auth.users(id,raw_user_meta_data) values($1,'{\"display_name\":\"Finn\"}')",
      [finn],
    );
    await t.test('report_rescue_case daily rate limit: 10 accepted, 11th rejected', () =>
      asUser(finn, async () => {
        for (let i = 0; i < 10; i++) {
          const id = `fa000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
          const path = rescuePhotoPath(finn, id);
          await insertRescuePhoto(finn, path);
          await db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            id,
            41,
            29,
            'Test',
            'Yaralı',
            path,
          ]);
        }
        const overflowId = 'fa000000-0000-4000-8000-000000000010';
        const overflowPath = rescuePhotoPath(finn, overflowId);
        await insertRescuePhoto(finn, overflowPath);
        await assert.rejects(
          db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
            overflowId,
            41,
            29,
            'Test',
            'Yaralı',
            overflowPath,
          ]),
          /Günlük bildirim sınırına ulaşıldı/,
        );
      }),
    );
    await t.test(
      'rescue photo storage INSERT policy: own {uid}/rescue-cases/{id}.jpg accepted; other uid, wrong prefix, wrong extension rejected',
      () =>
        asUser(alice, async () => {
          await db.query(
            "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
            [rescuePhotoPath(alice, 'fc000000-0000-4000-8000-000000000001'), alice],
          );
          await assert.rejects(
            db.query(
              "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
              [rescuePhotoPath(bob, 'fc000000-0000-4000-8000-000000000002'), alice],
            ),
            /row-level security/,
          );
          await assert.rejects(
            db.query(
              "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
              [`${alice}/rescue/fc000000-0000-4000-8000-000000000003.jpg`, alice],
            ),
            /row-level security/,
          );
          await assert.rejects(
            db.query(
              "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
              [`${alice}/rescue-cases/fc000000-0000-4000-8000-000000000004.png`, alice],
            ),
            /row-level security/,
          );
        }),
    );
    await t.test(
      'rescue photo storage SELECT policy: any authenticated user can read a linked case photo, anon cannot',
      async () => {
        const path = rescuePhotoPath(alice, rescueId);
        await asUser(bob, async () => {
          const { rows } = await db.query('select name from storage.objects where name=$1', [
            path,
          ]);
          assert.equal(rows.length, 1);
        });
        await asUser(null, async () => {
          await assert.rejects(
            db.query('select name from storage.objects where name=$1', [path]),
            /permission denied/,
          );
        });
      },
    );
    await t.test(
      'photos_remove_orphan: a photo linked to a rescue_case cannot be deleted, even by its owner',
      () =>
        asUser(alice, async () => {
          const path = rescuePhotoPath(alice, rescueId);
          const before = await db.query('select 1 from storage.objects where name=$1', [path]);
          assert.equal(before.rows.length, 1);
          await db.query('delete from storage.objects where name=$1', [path]);
          const after = await db.query('select 1 from storage.objects where name=$1', [path]);
          assert.equal(after.rows.length, 1, 'rescue case photo must survive a delete attempt');
        }),
    );
    await t.test(
      'photos_remove_orphan: an unreferenced feeding photo can still be deleted by its owner (regression)',
      () =>
        asUser(alice, async () => {
          const path = `${alice}/fd000000-0000-4000-8000-000000000001.jpg`;
          await db.query(
            "insert into storage.objects(bucket_id,name,owner_id) values('feeding-photos',$1,$2)",
            [path, alice],
          );
          await db.query('delete from storage.objects where name=$1', [path]);
          const { rows } = await db.query('select 1 from storage.objects where name=$1', [path]);
          assert.equal(rows.length, 0);
        }),
    );

    // --- T10: claim_rescue_case ---
    // A dedicated reporter, kept separate from alice/bob/carol, so these
    // report_rescue_case calls (10 of them below) never compete with the
    // report_rescue_case daily-rate-limit budget already exercised by alice
    // and finn in the T9 tests above.
    const reporter = 'ac111111-1111-4111-8111-111111111111';
    await db.query(
      "insert into auth.users(id,raw_user_meta_data) values($1,'{\"display_name\":\"Reporter\"}')",
      [reporter],
    );
    async function createReportedCase(id: string) {
      const path = rescuePhotoPath(reporter, id);
      await insertRescuePhoto(reporter, path);
      await asUser(reporter, async () => {
        await db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
          id,
          41,
          29,
          'Test',
          'Yaralı',
          path,
        ]);
      });
    }
    await t.test('claim_rescue_case: anon cannot claim', async () => {
      const id = 'ab000000-0000-4000-8000-000000000001';
      await createReportedCase(id);
      await asUser(null, async () => {
        await assert.rejects(
          db.query('select public.claim_rescue_case($1)', [id]),
          /permission denied/,
        );
      });
    });
    await t.test('claim_rescue_case: a reported case can be claimed', async () => {
      const id = 'ab000000-0000-4000-8000-000000000002';
      // Must run before entering asUser(bob, ...) below: asUser's cleanup
      // resets ROLE but not the request.jwt.claim.sub GUC it set, so nesting
      // a second asUser call inside this one would leak identities across
      // the boundary (see the "deleted/hidden feeding..." test's comment on
      // the same hazard). createReportedCase does its own asUser(reporter, ...)
      // internally, so it must stay a sibling call, never nested inside one.
      await createReportedCase(id);
      await asUser(bob, async () => {
        const { rows } = await db.query<{ claim_rescue_case: string }>(
          'select public.claim_rescue_case($1)',
          [id],
        );
        assert.equal(rows[0].claim_rescue_case, id);
      });
      const { rows: caseRows } = await db.query<{
        status: string;
        assigned_volunteer_id: string;
      }>('select status, assigned_volunteer_id from public.rescue_cases where id=$1', [id]);
      assert.equal(caseRows[0].status, 'claimed');
      assert.equal(caseRows[0].assigned_volunteer_id, bob);
    });
    await t.test(
      "claim_rescue_case: a 'verifying' case can be claimed (schema-reserved state, currently never produced in practice — proves the client/backend contract holds anyway)",
      async () => {
        const id = 'ab000000-0000-4000-8000-000000000003';
        await createReportedCase(id);
        // No production RPC ever sets 'verifying' — set it directly here
        // (ambient role) purely to exercise claim_rescue_case's contract.
        await db.query("update public.rescue_cases set status='verifying' where id=$1", [id]);
        await asUser(bob, async () => {
          await db.query('select public.claim_rescue_case($1)', [id]);
        });
        const { rows } = await db.query<{ status: string }>(
          'select status from public.rescue_cases where id=$1',
          [id],
        );
        assert.equal(rows[0].status, 'claimed');
      },
    );
    await t.test(
      'claim_rescue_case: first claimant wins; a second, different user is rejected without changing state',
      async () => {
        const id = 'ab000000-0000-4000-8000-000000000004';
        await createReportedCase(id);
        await asUser(bob, async () => {
          await db.query('select public.claim_rescue_case($1)', [id]);
        });
        await asUser(carol, async () => {
          await assert.rejects(
            db.query('select public.claim_rescue_case($1)', [id]),
            /zaten üstlenilmiş/,
          );
        });
        const { rows } = await db.query<{
          status: string;
          assigned_volunteer_id: string;
        }>('select status, assigned_volunteer_id from public.rescue_cases where id=$1', [id]);
        // Carol's rejected attempt must not have touched bob's successful claim.
        assert.equal(rows[0].status, 'claimed');
        assert.equal(rows[0].assigned_volunteer_id, bob);
      },
    );
    await t.test(
      "claim_rescue_case: the same user retrying after already claiming succeeds idempotently — this is the SQL contract that also makes the concurrent-same-user case safe (a retry only ever observes its own already-committed claim, never a fresh race)",
      async () => {
        const id = 'ab000000-0000-4000-8000-000000000005';
        // Sibling call, not nested inside asUser(bob, ...) below — see the
        // comment on the same hazard in "a reported case can be claimed".
        await createReportedCase(id);
        await asUser(bob, async () => {
          const { rows: first } = await db.query<{ claim_rescue_case: string }>(
            'select public.claim_rescue_case($1)',
            [id],
          );
          assert.equal(first[0].claim_rescue_case, id);
          const { rows: second } = await db.query<{ claim_rescue_case: string }>(
            'select public.claim_rescue_case($1)',
            [id],
          );
          assert.equal(second[0].claim_rescue_case, id);
        });
        const { rows } = await db.query<{
          status: string;
          assigned_volunteer_id: string;
        }>('select status, assigned_volunteer_id from public.rescue_cases where id=$1', [id]);
        assert.equal(rows[0].status, 'claimed');
        assert.equal(rows[0].assigned_volunteer_id, bob);
      },
    );
    await t.test(
      'claim_rescue_case rejects cases already past the claimable window (claimed/en_route/resolved)',
      async () => {
        const cases: Array<[string, string]> = [
          ['ab000000-0000-4000-8000-000000000006', 'claimed'],
          ['ab000000-0000-4000-8000-000000000007', 'en_route'],
          ['ab000000-0000-4000-8000-000000000008', 'resolved'],
        ];
        for (const [id, status] of cases) {
          await createReportedCase(id);
          await db.query(
            'update public.rescue_cases set status=$2, assigned_volunteer_id=$3 where id=$1',
            [id, status, carol],
          );
          await asUser(bob, async () => {
            await assert.rejects(
              db.query('select public.claim_rescue_case($1)', [id]),
              /zaten üstlenilmiş/,
            );
          });
        }
      },
    );
    await t.test('claim_rescue_case: nonexistent case fails clearly', () =>
      asUser(bob, async () => {
        await assert.rejects(
          db.query('select public.claim_rescue_case($1)', [
            'ab000000-0000-4000-8000-000000000099',
          ]),
          /Vaka bulunamadı/,
        );
      }),
    );
    await t.test(
      'rescue_cases: direct UPDATE remains denied for authenticated, even to claim',
      async () => {
        const id = 'ab000000-0000-4000-8000-000000000010';
        // Sibling call, not nested inside asUser(alice, ...) below — see the
        // comment on the same hazard in "a reported case can be claimed".
        await createReportedCase(id);
        await asUser(alice, async () => {
          await assert.rejects(
            db.query("update public.rescue_cases set status='claimed' where id=$1", [id]),
            /permission denied/,
          );
        });
      },
    );
    await t.test(
      'claim_rescue_case: another authenticated user (not the reporter or claimant) sees the updated assignment/status',
      async () => {
        const id = 'ab000000-0000-4000-8000-000000000011';
        await createReportedCase(id);
        await asUser(bob, async () => {
          await db.query('select public.claim_rescue_case($1)', [id]);
        });
        await asUser(carol, async () => {
          const { rows } = await db.query<{
            status: string;
            assigned_volunteer_id: string;
          }>('select status, assigned_volunteer_id from public.rescue_cases where id=$1', [id]);
          assert.equal(rows[0].status, 'claimed');
          assert.equal(rows[0].assigned_volunteer_id, bob);
        });
      },
    );

    // --- T11: update_rescue_case_status ---
    // A second dedicated reporter, kept separate from `reporter` (T10's), so
    // these report_rescue_case calls never compete with a budget already
    // spent above — same reasoning as `reporter` itself.
    const reporter2 = 'ad111111-1111-4111-8111-111111111111';
    await db.query(
      "insert into auth.users(id,raw_user_meta_data) values($1,'{\"display_name\":\"Reporter2\"}')",
      [reporter2],
    );
    async function createClaimedCase(id: string, claimant: string) {
      const path = rescuePhotoPath(reporter2, id);
      await insertRescuePhoto(reporter2, path);
      await asUser(reporter2, async () => {
        await db.query('select public.report_rescue_case($1,$2,$3,$4,$5,$6)', [
          id,
          41,
          29,
          'Test',
          'Yaralı',
          path,
        ]);
      });
      await asUser(claimant, async () => {
        await db.query('select public.claim_rescue_case($1)', [id]);
      });
    }
    async function caseRow(id: string) {
      const { rows } = await db.query<{
        status: string;
        assigned_volunteer_id: string;
        updated_at: string;
      }>('select status, assigned_volunteer_id, updated_at from public.rescue_cases where id=$1', [
        id,
      ]);
      return rows[0];
    }
    await t.test('update_rescue_case_status: anon cannot call', async () => {
      const id = 'ae000000-0000-4000-8000-000000000001';
      await createClaimedCase(id, bob);
      await asUser(null, async () => {
        await assert.rejects(
          db.query('select public.update_rescue_case_status($1,$2)', [id, 'en_route']),
          /permission denied/,
        );
      });
    });
    await t.test(
      'update_rescue_case_status: the assigned volunteer can perform all 4 sequential transitions to resolved; another authenticated user sees the final state',
      async () => {
        const id = 'ae000000-0000-4000-8000-000000000002';
        await createClaimedCase(id, bob);
        for (const next of ['en_route', 'at_vet', 'treating', 'resolved']) {
          await asUser(bob, async () => {
            const { rows } = await db.query<{ update_rescue_case_status: string }>(
              'select public.update_rescue_case_status($1,$2)',
              [id, next],
            );
            assert.equal(rows[0].update_rescue_case_status, id);
          });
          assert.equal((await caseRow(id)).status, next);
        }
        // Cross-user read regression: carol (neither reporter nor claimant)
        // sees the fully-resolved state on the next fetch.
        await asUser(carol, async () => {
          const { rows } = await db.query<{ status: string }>(
            'select status from public.rescue_cases where id=$1',
            [id],
          );
          assert.equal(rows[0].status, 'resolved');
        });
      },
    );
    await t.test(
      "update_rescue_case_status: 'resolved' is terminal — a further call is rejected and the state is unchanged",
      async () => {
        const id = 'ae000000-0000-4000-8000-000000000002'; // already resolved above
        const before = await caseRow(id);
        await asUser(bob, async () => {
          await assert.rejects(
            db.query('select public.update_rescue_case_status($1,$2)', [id, 'treating']),
            /Bu geçiş şu anda yapılamaz/,
          );
        });
        const after = await caseRow(id);
        assert.equal(after.status, before.status);
        assert.equal(new Date(after.updated_at).getTime(), new Date(before.updated_at).getTime());
      },
    );
    await t.test(
      "update_rescue_case_status rejects skipping a state ('claimed' -> 'resolved' directly)",
      async () => {
        const id = 'ae000000-0000-4000-8000-000000000003';
        // Sibling call, not nested inside asUser(bob, ...) below — createClaimedCase
        // does its own asUser(reporter2, ...)/asUser(bob, ...) internally, so
        // nesting it would leak identities across the boundary (see T10's tests).
        await createClaimedCase(id, bob);
        await asUser(bob, async () => {
          await assert.rejects(
            db.query('select public.update_rescue_case_status($1,$2)', [id, 'resolved']),
            /Bu geçiş şu anda yapılamaz/,
          );
        });
        assert.equal((await caseRow(id)).status, 'claimed');
      },
    );
    await t.test(
      "update_rescue_case_status rejects going backwards ('en_route' -> 'claimed') and an arbitrary status value, leaving state unchanged",
      async () => {
        const id = 'ae000000-0000-4000-8000-000000000004';
        await createClaimedCase(id, bob);
        await asUser(bob, async () => {
          await db.query('select public.update_rescue_case_status($1,$2)', [id, 'en_route']);
          await assert.rejects(
            db.query('select public.update_rescue_case_status($1,$2)', [id, 'claimed']),
            /Geçersiz hedef durum/,
          );
          await assert.rejects(
            db.query('select public.update_rescue_case_status($1,$2)', [id, 'foo']),
            /Geçersiz hedef durum/,
          );
        });
        assert.equal((await caseRow(id)).status, 'en_route');
      },
    );
    await t.test(
      'update_rescue_case_status: a different, non-assigned, non-moderator authenticated user is rejected; state unchanged',
      async () => {
        const id = 'ae000000-0000-4000-8000-000000000005';
        await createClaimedCase(id, bob);
        await asUser(carol, async () => {
          await assert.rejects(
            db.query('select public.update_rescue_case_status($1,$2)', [id, 'en_route']),
            /Bu geçiş şu anda yapılamaz/,
          );
        });
        assert.equal((await caseRow(id)).status, 'claimed');
      },
    );
    await t.test(
      'update_rescue_case_status: a moderator can advance a case assigned to someone else',
      async () => {
        const id = 'ae000000-0000-4000-8000-000000000006';
        await createClaimedCase(id, bob);
        await asUser(
          carol,
          async () => {
            await db.query('select public.update_rescue_case_status($1,$2)', [id, 'en_route']);
          },
          true,
        );
        assert.equal((await caseRow(id)).status, 'en_route');
      },
    );
    await t.test(
      'update_rescue_case_status: the same transition retried by the assigned volunteer succeeds idempotently and does not re-bump updated_at',
      async () => {
        const id = 'ae000000-0000-4000-8000-000000000007';
        // Sibling call, not nested inside asUser(bob, ...) below — see the
        // comment on the same hazard in the "rejects skipping a state" test.
        await createClaimedCase(id, bob);
        let afterFirst: Awaited<ReturnType<typeof caseRow>>;
        await asUser(bob, async () => {
          const { rows: first } = await db.query<{ update_rescue_case_status: string }>(
            'select public.update_rescue_case_status($1,$2)',
            [id, 'en_route'],
          );
          assert.equal(first[0].update_rescue_case_status, id);
        });
        afterFirst = await caseRow(id);
        await asUser(bob, async () => {
          const { rows: second } = await db.query<{ update_rescue_case_status: string }>(
            'select public.update_rescue_case_status($1,$2)',
            [id, 'en_route'],
          );
          assert.equal(second[0].update_rescue_case_status, id);
        });
        const afterSecond = await caseRow(id);
        assert.equal(afterSecond.status, 'en_route');
        assert.equal(
          new Date(afterSecond.updated_at).getTime(),
          new Date(afterFirst.updated_at).getTime(),
        );
      },
    );
    await t.test(
      'rescue_cases: direct UPDATE remains denied for authenticated, even for a valid transition',
      async () => {
        const id = 'ae000000-0000-4000-8000-000000000008';
        await createClaimedCase(id, bob);
        await asUser(bob, async () => {
          await assert.rejects(
            db.query("update public.rescue_cases set status='en_route' where id=$1", [id]),
            /permission denied/,
          );
        });
      },
    );
  } finally {
    await db.close();
  }
});
