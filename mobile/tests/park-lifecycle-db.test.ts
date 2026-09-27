import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { lookupPark, parkRouteAction, type ResolveRow } from '../src/core/park-lifecycle';
import type { Park } from '../src/core/types';

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
