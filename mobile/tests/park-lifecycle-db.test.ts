import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { lookupPark, parkRouteAction, type ResolveRow } from '../src/core/park-lifecycle';
import { submitQueuedFeeding } from '../src/core/offline-queue';
import type { FeedingDraft, Park } from '../src/core/types';

// Fresh PGlite database with the migration chain the park lifecycle depends on
// (core schema, park names, park_source_refs, lifecycle). Same PostGIS stripping as
// database.test.ts; everything else runs as in production.
const migration = (name: string) =>
  readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');

async function database() {
  const db = new PGlite({ extensions: { unaccent } });
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
  await db.exec(
    (await migration('202609130001_patika.sql'))
      .replace('create extension if not exists postgis with schema extensions;', '')
      .replace(
        /  location extensions\.geography\(Point,4326\) generated always as[\s\S]*? stored,\n/,
        '',
      )
      .replace('create index parks_location on public.parks using gist(location);', ''),
  );
  await db.exec(await migration('202609130002_park_names.sql'));
  // production submit_feeding (location check + points) for the offline-queue cases
  for (const m of [
    '202609170001_location_verification.sql',
    '202609170002_points.sql',
    '202609170003_my_points.sql',
    '202609170004_points_integrity.sql',
  ])
    await db.exec(await migration(m));
  await db.exec(await migration('202609180009_park_source_refs.sql'));
  await db.exec(await migration('202609270001_canonical_park_lifecycle.sql'));
  return db;
}

test('lifecycle migration on a fresh chain + client resolver against the real RPCs', async (t) => {
  const db = await database();
  try {
    await t.test(
      'the committed lifecycle SQL test suite passes on a fresh migration chain',
      async () => {
        const sql = await readFile(
          new URL('../../supabase/tests/canonical_park_lifecycle.test.sql', import.meta.url),
          'utf8',
        );
        await db.exec(sql); // raises on the first failed assertion; ends in ROLLBACK
        const left = await db.query<{ n: number }>(
          "select count(*)::int n from public.parks where id::text like 'f0000000%'",
        );
        assert.equal(left.rows[0].n, 0);
      },
    );

    await db.exec(`
      insert into public.canonical_park_releases(release_id, base_snapshot_sha256, manifest_sha256, expected_counts, status, applied_at)
      values ('mobile-test', repeat('a',64), repeat('b',64), '{}', 'applied', now());
      insert into public.parks(id, name, city, latitude, longitude, active) values
        ('20000000-0000-4000-8000-000000000001', 'Canlı Park', 'Ordu', 40.98, 37.87, true),
        ('20000000-0000-4000-8000-000000000002', 'Birleşen Park', 'Ordu', 40.99, 37.88, true),
        ('20000000-0000-4000-8000-000000000003', 'Eski Parça', 'Ordu', 40.981, 37.871, false),
        ('20000000-0000-4000-8000-000000000006', 'Çekilen Park', 'İzmir', 38.4, 27.1, false),
        ('20000000-0000-4000-8000-000000000007', 'Gizlenen Park', 'İzmir', 38.41, 27.11, false);
      insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values
        ('20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', 'fragment', 'mobile-test');
      insert into public.canonical_park_tombstones(retired_park_id, status, reason, release_id) values
        ('20000000-0000-4000-8000-000000000004', 'taxonomy_review', 'x', 'mobile-test'),
        ('20000000-0000-4000-8000-000000000005', 'non_park', 'x', 'mobile-test'),
        ('20000000-0000-4000-8000-000000000006', 'source_withdrawn', 'x', 'mobile-test');`);
    const deps = {
      loadPark: async (id: string) =>
        ((await db.query<Park>('select * from public.get_park($1)', [id])).rows[0] ??
          null) as Park | null,
      resolve: async (id: string) =>
        ((await db.query('select * from public.resolve_park_id($1)', [id])).rows[0] ??
          null) as ResolveRow,
    };
    const open = async (id: string, redirectedFrom?: string) =>
      parkRouteAction(await lookupPark(id, deps), redirectedFrom);

    await t.test('live id shows the park', async () => {
      const a = await open('20000000-0000-4000-8000-000000000001');
      assert.equal(a.type === 'show' && a.park.name, 'Canlı Park');
    });
    await t.test(
      'alias redirects to the survivor, which then shows without another redirect',
      async () => {
        const a = await open('20000000-0000-4000-8000-000000000003');
        assert.deepEqual(a, { type: 'redirect', id: '20000000-0000-4000-8000-000000000002' });
        const b = await open(
          '20000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000003',
        );
        assert.equal(b.type === 'show' && b.park.name, 'Birleşen Park');
      },
    );
    for (const [id, title] of [
      ['20000000-0000-4000-8000-000000000004', 'Bu konum şu anda doğrulanıyor.'],
      ['20000000-0000-4000-8000-000000000005', 'Bu kayıt artık park olarak listelenmiyor.'],
      ['20000000-0000-4000-8000-000000000006', 'Bu park artık güncel park listesinde yer almıyor.'],
      ['20000000-0000-4000-8000-000000000007', 'Park bulunamadı'],
      ['20000000-0000-4000-8000-0000000000ff', 'Park bulunamadı'],
    ] as const) {
      await t.test(`${id.slice(-2)} -> "${title}"`, async () => {
        const a = await open(id);
        assert.equal(a.type, 'unavailable');
        assert.equal(a.type === 'unavailable' && a.message.title, title);
      });
    }
    await t.test(
      'offline queue: a feeding queued for a merged park is accepted after remapping',
      async () => {
        const U = '50000000-0000-4000-8000-000000000001',
          A2 = '20000000-0000-4000-8000-0000000000a2',
          B2 = '20000000-0000-4000-8000-0000000000b2',
          C2 = '20000000-0000-4000-8000-0000000000c2';
        // state after a release merged A2 into B2: A2's general point kept inactive, custom point
        // C2 re-parented to B2 (see scripts/sql/apply-canonical-release.sql, alias step)
        await db.exec(`
        insert into auth.users(id) values ('${U}');
        insert into public.parks(id, name, city, latitude, longitude, active) values
          ('${A2}', 'Eski Parça 2', 'Ordu', 40.9801, 37.8701, false),
          ('${B2}', 'Birleşen Park 2', 'Ordu', 40.9802, 37.8702, true);
        insert into public.feeding_points(id, park_id, name, latitude, longitude, active) values
          ('${A2}', '${A2}', 'Park içi genel nokta', 40.9801, 37.8701, false),
          ('${B2}', '${B2}', 'Park içi genel nokta', 40.9802, 37.8702, true),
          ('${C2}', '${B2}', 'Kuzey kapı noktası', 40.9803, 37.8703, true);
        insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id)
          values ('${A2}', '${B2}', 'fragment', 'mobile-test');`);
        await db.query("select set_config('request.jwt.claim.sub', $1, false)", [U]);
        const submitted: string[] = [];
        const submit = async (draft: FeedingDraft) => {
          const { photo_uri, ...payload } = draft; // same shape as repository.submitFeeding
          const photo_path = `${U}/${draft.id}.jpg`;
          await db.query(
            "insert into storage.objects(bucket_id, name, owner_id) values ('feeding-photos', $1, $2) on conflict (name) do nothing",
            [photo_path, U],
          );
          const r = await db.query<{ id: string }>('select public.submit_feeding($1::jsonb) id', [
            { ...payload, photo_path },
          ]);
          submitted.push(r.rows[0].id);
        };
        const queued = (id: string, point_id: string): FeedingDraft => ({
          id,
          user_id: U,
          park_id: A2,
          point_id,
          park_name: 'Eski Parça 2',
          food_type: 'dry',
          food_grams: 150,
          water_ml: 0,
          note: '',
          occurred_at: new Date().toISOString(),
          photo_uri: 'file:///x.jpg',
          reported_latitude: 40.9802,
          reported_longitude: 37.8702,
        });
        const qDeps = { resolvePark: (id: string) => lookupPark(id, deps), submit };
        // the un-remapped payload is what failed before this change
        await assert.rejects(
          submit(queued('60000000-0000-4000-8000-000000000000', A2)),
          /Geçerli besleme noktası gerekli/,
        );
        await submitQueuedFeeding(queued('60000000-0000-4000-8000-000000000001', A2), qDeps);
        await submitQueuedFeeding(queued('60000000-0000-4000-8000-000000000002', C2), qDeps);
        const rows = await db.query<{ id: string; park_id: string; point_id: string }>(
          "select id, park_id, point_id from public.feeding_events where id::text like '60000000%' order by id",
        );
        assert.deepEqual(rows.rows, [
          { id: '60000000-0000-4000-8000-000000000001', park_id: B2, point_id: B2 },
          { id: '60000000-0000-4000-8000-000000000002', park_id: B2, point_id: C2 },
        ]);
        await db.query("select set_config('request.jwt.claim.sub', '', false)");
      },
    );
    await t.test('anon (deep links before sign-in) may call resolve_park_id', async () => {
      await db.exec('set role anon');
      try {
        const r = await db.query<{ status: string }>(
          "select status from public.resolve_park_id('20000000-0000-4000-8000-000000000003')",
        );
        assert.equal(r.rows[0].status, 'alias');
      } finally {
        await db.exec('reset role');
      }
    });
  } finally {
    await db.close();
  }
});
