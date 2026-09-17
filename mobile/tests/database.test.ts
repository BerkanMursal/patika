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
      locPoint = 'a2222222-2222-4222-8222-222222222222';
    await db.query(
      'insert into public.parks(id,name,latitude,longitude) values($1,$2,41,29)',
      [locPark, 'Konum Testi Parkı'],
    );
    await db.query(
      'insert into public.feeding_points(id,park_id,latitude,longitude) values($1,$2,41,29)',
      [locPoint, locPark],
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
          await db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
            locPoint,
            'full',
            'full',
            '',
            under,
            29,
          ]);
          await assert.rejects(
            db.query('select public.submit_observation($1,$2,$3,$4,$5,$6)', [
              locPoint,
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
      dateline = 'a6666666-6666-4666-8666-666666666666';
    await db.query(
      'insert into public.parks(id,name,latitude,longitude) values($1,$2,41,29)',
      [boundaryPark, 'Sınır Testi Parkı'],
    );
    await db.query(
      `insert into public.feeding_points(id,park_id,name,latitude,longitude) values
        ($1,$4,'Kuzey Kutbu',90,0),($2,$4,'Güney Kutbu',-90,0),($3,$4,'Tarih Değiştirme Hattı',0,180)`,
      [northPole, southPole, dateline, boundaryPark],
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
          // -180 and 180 are the same meridian, so this is still 0m from `dateline`.
          await observeAt(dateline, 0, -180);
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
    await t.test('submit_observation produces exactly one 2-point transaction', () =>
      asUser(alice, async () => {
        const { rows: submitted } = await db.query<{ id: string }>(
          'select public.submit_observation($1,$2,$3,$4,$5,$6) as id',
          [locPoint, 'full', 'full', '', 41, 29],
        );
        const { rows } = await db.query<{ source_type: string; points: number }>(
          'select source_type, points from public.point_transactions where source_id=$1',
          [submitted[0].id],
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source_type, 'observation');
        assert.equal(rows[0].points, 2);
      }),
    );
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
  } finally {
    await db.close();
  }
});
