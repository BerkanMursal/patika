-- Single-transaction canonical release apply. Executed by scripts/apply-canonical-release.mjs
-- INSIDE its BEGIN ... COMMIT after it has (a) taken the release advisory lock and (b) loaded
--   stg_meta(k,v)          release metadata, expected counts, source scope, test hooks
--   stg_raw(kind,doc)      every bundle record (+ environment policy rows)
-- Any error aborts the whole transaction: a partially applied release is impossible.
-- See docs/CANONICAL_PARK_LIFECYCLE.md §6-§9 for the policy each step implements.

create temp table rpt(k text primary key, v jsonb) on commit drop;
create function pg_temp.rep(p_k text, p_v jsonb) returns void language sql as $$ insert into rpt values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.meta(p_k text) returns jsonb language sql stable as $$ select v from stg_meta where k = p_k $$;
create function pg_temp.maybe_fail(p_step text) returns void language plpgsql as $$
begin
  if pg_temp.meta('inject_failure') #>> '{}' = p_step then raise exception 'injected test failure at step %', p_step; end if;
end;$$;

/* ---------- 1. prerequisites ---------- */
do $$
declare t text; f text;
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null
     and not exists (select 1 from supabase_migrations.schema_migrations where version = pg_temp.meta('schema_migration') #>> '{}') then
    raise exception 'prerequisite schema migration % is not applied', pg_temp.meta('schema_migration') #>> '{}';
  end if;
  for t in select jsonb_array_elements_text(pg_temp.meta('required_tables')) loop
    if to_regclass('public.' || t) is null then raise exception 'prerequisite table public.% missing', t; end if;
  end loop;
  for f in select jsonb_array_elements_text(pg_temp.meta('required_functions')) loop
    if to_regprocedure('public.' || f) is null then raise exception 'prerequisite function public.% missing', f; end if;
  end loop;
  if exists (select 1 from public.canonical_park_releases where release_id = pg_temp.meta('release_id') #>> '{}') then
    raise exception 'release % is already recorded (status %); refusing to apply again', pg_temp.meta('release_id') #>> '{}',
      (select status from public.canonical_park_releases where release_id = pg_temp.meta('release_id') #>> '{}');
  end if;
end $$;
insert into public.canonical_park_releases(release_id, base_snapshot_sha256, manifest_sha256, expected_counts, status)
values (pg_temp.meta('release_id') #>> '{}', pg_temp.meta('base_snapshot_sha256') #>> '{}', pg_temp.meta('manifest_sha256') #>> '{}', pg_temp.meta('expected_counts'), 'applying');

/* ---------- 2. typed staging ---------- */
create temp table s_parks(id uuid primary key, osm_id text unique, name text not null, city text not null, district text not null, latitude float8 not null, longitude float8 not null,
  source text not null, name_status text not null, name_source text not null, name_source_url text not null, address_label text not null) on commit drop;
insert into s_parks select (d->>'id')::uuid, d->>'osm_id', d->>'name', coalesce(d->>'city', ''), coalesce(d->>'district', ''), (d->>'latitude')::float8, (d->>'longitude')::float8,
  d->>'source', d->>'name_status', d->>'name_source', coalesce(d->>'name_source_url', ''), coalesce(d->>'address_label', '') from stg_raw, lateral (select doc d) x where kind = 'parks';
create temp table s_refs(source_code text, external_id text, park_id uuid not null, source_url text not null, primary key(source_code, external_id)) on commit drop;
insert into s_refs select d->>'source_code', d->>'external_id', (d->>'park_id')::uuid, coalesce(d->>'source_url', '') from stg_raw, lateral (select doc d) x where kind = 'park_source_refs';
create temp table s_alias(retired uuid primary key, survivor uuid not null, reason text not null, source_code text, cluster_id text, refs jsonb not null) on commit drop;
insert into s_alias select (d->>'retired_park_id')::uuid, (d->>'canonical_park_id')::uuid, d->>'reason', d->>'source_code', d->>'cluster_id', d->'source_refs_preserved' from stg_raw, lateral (select doc d) x where kind = 'aliases';
create temp table s_tomb(retired uuid primary key, status text not null, reason text not null, source_code text, cluster_id text) on commit drop;
insert into s_tomb select (d->>'retired_park_id')::uuid, d->>'status', d->>'reason', d->>'source_code', d->>'cluster_id' from stg_raw, lateral (select doc d) x where kind = 'tombstones';
create temp table s_tomb_refs(source_code text, external_id text, retired uuid not null, source_url text not null, primary key(source_code, external_id)) on commit drop;
insert into s_tomb_refs select r->>'source_code', r->>'external_id', (d->>'retired_park_id')::uuid, coalesce(r->>'source_url', '')
  from stg_raw, lateral (select doc d) x, lateral jsonb_array_elements(d->'source_refs') r where kind = 'tombstones';
create temp table s_reviews(source_code text, external_id text, review_reason text not null, name text, province text, district text, latitude float8, longitude float8,
  candidate_canonical_ids uuid[], related_canonical_id uuid, source_url text, evidence jsonb, primary key(source_code, external_id)) on commit drop;
insert into s_reviews select d->>'source_code', d->>'external_id', d->>'review_reason', coalesce(d->>'name', ''), coalesce(d->>'province', ''), coalesce(d->>'district', ''),
  (d->>'latitude')::float8, (d->>'longitude')::float8, array(select jsonb_array_elements_text(d->'candidate_canonical_ids'))::uuid[], (d->>'related_canonical_id')::uuid,
  coalesce(d->>'source_url', ''), coalesce(d->'evidence', '{}') from stg_raw, lateral (select doc d) x where kind = 'reviews';
create temp table s_rejections(source_code text, external_id text, classification text not null, reason text not null, taxonomy_class text, retired_park_id uuid, source_url text, evidence jsonb,
  primary key(source_code, external_id)) on commit drop;
insert into s_rejections select d->>'source_code', d->>'external_id', d->>'classification', d->>'reason', d->>'taxonomy_class', (d->>'retired_park_id')::uuid, coalesce(d->>'source_url', ''), coalesce(d->'evidence', '{}')
  from stg_raw, lateral (select doc d) x where kind = 'rejections';
create temp table s_fixtures(park_id uuid primary key, evidence text not null) on commit drop;
insert into s_fixtures select (d->>'park_id')::uuid, d->>'evidence' from stg_raw, lateral (select doc d) x where kind = 'env_fixture';
create temp table s_ack(park_id uuid primary key) on commit drop;
insert into s_ack select (doc #>> '{}')::uuid from stg_raw where kind = 'env_tombstone_ack';
create temp table s_scope(source_code text primary key) on commit drop;
insert into s_scope select jsonb_array_elements_text(pg_temp.meta('source_scope'));

/* ---------- 3. staging invariants (the bundle was already hash-validated in JS; re-check in SQL) ---------- */
do $$
declare ec jsonb := pg_temp.meta('expected_counts'); n bigint;
begin
  if (select count(*) from s_parks) <> (ec->>'parks')::int then raise exception 'staged parks % != expected %', (select count(*) from s_parks), ec->>'parks'; end if;
  if (select count(*) from s_parks where osm_id is not null) <> (ec->>'osm_backed_parks')::int then raise exception 'staged OSM parks mismatch'; end if;
  if (select count(*) from s_refs) <> (ec->>'park_source_refs')::int then raise exception 'staged refs mismatch'; end if;
  if (select count(*) from s_alias) <> (ec->>'aliases')::int or (select count(*) from s_tomb) <> (ec->>'tombstones')::int then raise exception 'staged lifecycle mismatch'; end if;
  if (select count(*) from s_tomb_refs) <> (ec->>'tombstone_refs')::int then raise exception 'staged tombstone refs mismatch'; end if;
  if (select count(*) from s_reviews) <> (ec->>'reviews')::int or (select count(*) from s_rejections) <> (ec->>'rejections')::int then raise exception 'staged review/rejection mismatch'; end if;
  select count(*) into n from s_refs r where not exists (select 1 from s_parks p where p.id = r.park_id); if n > 0 then raise exception '% staged refs point outside staged parks', n; end if;
  select count(*) into n from s_alias a where not exists (select 1 from s_parks p where p.id = a.survivor) or a.survivor = a.retired; if n > 0 then raise exception '% aliases lack a live survivor', n; end if;
  select count(*) into n from s_alias a join s_tomb t using (retired); if n > 0 then raise exception '% ids are both alias and tombstone', n; end if;
  select count(*) into n from (select retired from s_alias union all select retired from s_tomb) r where exists (select 1 from s_parks p where p.id = r.retired); if n > 0 then raise exception '% retired ids are also live', n; end if;
  select count(*) into n from s_alias a where exists (select 1 from s_alias b where b.retired = a.survivor) or exists (select 1 from s_tomb t where t.retired = a.survivor); if n > 0 then raise exception '% alias chains', n; end if;
  select count(*) into n from s_tomb_refs t join s_refs r using (source_code, external_id); if n > 0 then raise exception '% tombstone refs are also live refs', n; end if;
  select count(*) into n from (select source_code, external_id from s_reviews union all select source_code, external_id from s_rejections) x join s_refs r using (source_code, external_id); if n > 0 then raise exception '% reviews/rejections are also live refs', n; end if;
end $$;

/* ---------- 4. baseline snapshot + expected-DB-state checks ---------- */
create temp table b_refs on commit drop as select source_code, external_id, park_id from public.park_source_refs;
create temp table b_parks on commit drop as select id, osm_id, active from public.parks;
create temp table b_counts on commit drop as select
  (select count(*) from public.parks) parks, (select count(*) from public.parks where active) active_parks,
  (select count(*) from public.feeding_points) feeding_points, (select count(*) from public.feeding_events) feeding_events,
  (select count(*) from public.observations) observations, (select count(*) from public.favorites) favorites,
  (select count(*) from public.park_name_suggestions) name_suggestions, (select count(*) from public.reports) reports,
  (select count(*) from public.feeding_events e join public.feeding_points fp on fp.id = e.point_id where fp.park_id <> e.park_id) event_point_park_mismatch;
create temp table b_favorites on commit drop as select user_id, park_id from public.favorites;
select pg_temp.rep('before', (select to_jsonb(b) from b_counts b) || jsonb_build_object('park_source_refs', (select count(*) from b_refs),
  'lifecycle_aliases', (select count(*) from public.canonical_park_aliases), 'lifecycle_tombstones', (select count(*) from public.canonical_park_tombstones),
  'reviews', (select count(*) from public.canonical_park_reviews), 'rejections', (select count(*) from public.canonical_park_rejections)));

do $$
declare n bigint; bad text;
begin
  -- a live id of this release must not be retired already
  select string_agg(id::text, ', ') into bad from s_parks s where exists (select 1 from public.canonical_park_aliases where retired_park_id = s.id) or exists (select 1 from public.canonical_park_tombstones where retired_park_id = s.id);
  if bad is not null then raise exception 'live ids of this release are already retired: %', bad; end if;
  -- OSM identity: an osm_id may not move to a different canonical id
  select string_agg(p.osm_id || ' db=' || p.id || ' release=' || s.id, '; ') into bad from public.parks p join s_parks s on s.osm_id = p.osm_id and s.id <> p.id;
  if bad is not null then raise exception 'OSM identity conflicts: %', bad; end if;
  select string_agg(p.id::text, ', ') into bad from public.parks p join s_parks s on s.id = p.id where p.osm_id is not null and s.osm_id is distinct from p.osm_id;
  if bad is not null then raise exception 'canonical id changes its osm_id: %', bad; end if;
  -- a DB source ref may only move to another park through an alias of this release
  select string_agg(b.source_code || ':' || b.external_id, ', ') into bad from b_refs b join s_refs s using (source_code, external_id)
    where s.park_id <> b.park_id and not exists (select 1 from s_alias a where a.retired = b.park_id and a.survivor = s.park_id);
  if bad is not null then raise exception 'source refs would move between parks without an alias: %', left(bad, 500); end if;
  select string_agg(b.source_code || ':' || b.external_id, ', ') into bad from b_refs b join s_tomb_refs t using (source_code, external_id) where t.retired <> b.park_id;
  if bad is not null then raise exception 'tombstone refs currently held by a different park: %', left(bad, 500); end if;
  -- a review/rejection may currently be a live ref only on the park this release tombstones with that
  -- same ref (demoted canonical: its provenance moves to tombstone refs, its queue item to review/rejection)
  select string_agg(b.source_code || ':' || b.external_id, ', ') into bad from b_refs b
    where (exists (select 1 from s_reviews r where r.source_code = b.source_code and r.external_id = b.external_id)
        or exists (select 1 from s_rejections r where r.source_code = b.source_code and r.external_id = b.external_id))
      and not exists (select 1 from s_tomb_refs t where t.source_code = b.source_code and t.external_id = b.external_id and t.retired = b.park_id);
  if bad is not null then raise exception 'records the release keeps in review/rejection are live refs in the DB: %', left(bad, 500); end if;
end $$;

-- history of any park id (its own rows + rows through its feeding points)
create function pg_temp.history(p uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'feeding_events', (select count(*) from public.feeding_events e where e.park_id = p or e.point_id in (select id from public.feeding_points where park_id = p)),
    'observations', (select count(*) from public.observations o where o.point_id in (select id from public.feeding_points where park_id = p)),
    'favorites', (select count(*) from public.favorites where park_id = p),
    'name_suggestions', (select count(*) from public.park_name_suggestions where park_id = p),
    'reports', (select count(*) from public.reports where park_id = p))
$$;
create function pg_temp.has_history(p uuid) returns boolean language sql stable as $$
  select exists (select 1 from jsonb_each_text(pg_temp.history(p)) where value::int > 0)
$$;
create function pg_temp.authors(p uuid) returns setof uuid language sql stable as $$
  select user_id from public.feeding_events where park_id = p or point_id in (select id from public.feeding_points where park_id = p)
  union select user_id from public.observations where point_id in (select id from public.feeding_points where park_id = p)
  union select user_id from public.favorites where park_id = p
  union select user_id from public.park_name_suggestions where park_id = p
  union select user_id from public.reports where park_id = p and user_id is not null
$$;

-- DB-only parks: classified by evidence (never by id/name)
create temp table db_only on commit drop as
select p.id, p.osm_id, p.name,
  (p.osm_id is not null or exists (select 1 from b_refs r where r.park_id = p.id)) as has_provenance,
  (select coalesce(array_agg(distinct r.source_code), '{}') from b_refs r where r.park_id = p.id) as prov_sources,
  (select count(*) from b_refs r where r.park_id = p.id
     and (exists (select 1 from s_refs s where s.source_code = r.source_code and s.external_id = r.external_id)
       or exists (select 1 from s_tomb_refs s where s.source_code = r.source_code and s.external_id = r.external_id)
       or exists (select 1 from s_reviews s where s.source_code = r.source_code and s.external_id = r.external_id)
       or exists (select 1 from s_rejections s where s.source_code = r.source_code and s.external_id = r.external_id))) as refs_in_release,
  pg_temp.history(p.id) as history, pg_temp.has_history(p.id) as has_history,
  exists (select 1 from s_fixtures f where f.park_id = p.id) as fixture_listed,
  not exists (select 1 from pg_temp.authors(p.id) a left join auth.users u on u.id = a
              where u.email is null or u.email !~* '@([^@]+\.)?(example\.(com|net|org)|[a-z0-9.-]+\.(test|invalid|localhost|example))$') as authors_reserved,
  null::text as classification, null::text as action
from public.parks p
where not exists (select 1 from s_parks s where s.id = p.id)
  and not exists (select 1 from s_alias a where a.retired = p.id)
  and not exists (select 1 from s_tomb t where t.retired = p.id)
  and not exists (select 1 from public.canonical_park_aliases a where a.retired_park_id = p.id)
  and not exists (select 1 from public.canonical_park_tombstones t where t.retired_park_id = p.id);
update db_only set classification = case
    when has_provenance and not fixture_listed and refs_in_release = 0
         and (osm_id is null or exists (select 1 from s_scope where source_code = 'osm'))
         and not exists (select 1 from unnest(prov_sources) sc where sc not in (select source_code from s_scope))
      then case when has_history then 'SOURCE_WITHDRAWN_WITH_HISTORY' else 'SOURCE_WITHDRAWN_NO_HISTORY' end
    when not has_provenance and fixture_listed and authors_reserved then 'TEST_FIXTURE'
    else 'UNKNOWN_DB_ONLY' end;
update db_only set action = case classification when 'TEST_FIXTURE' then 'untouched (out of release scope; environment fixture)'
  when 'UNKNOWN_DB_ONLY' then 'ABORT' else 'tombstone source_withdrawn; parks row kept inactive; refs -> tombstone refs; user rows untouched' end;
select pg_temp.rep('db_only_parks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'osm_id', osm_id, 'name', name, 'classification', classification,
  'has_provenance', has_provenance, 'history', history, 'action', action) order by id) from db_only), '[]'));
do $$
declare bad text;
begin
  select string_agg(id || ' (' || name || ')', ', ') into bad from db_only where classification = 'UNKNOWN_DB_ONLY';
  if bad is not null then raise exception 'unclassifiable DB-only parks (add explicit policy or fix provenance): %', bad; end if;
  select string_agg(f.park_id::text, ', ') into bad from s_fixtures f join public.parks p on p.id = f.park_id
    where not exists (select 1 from db_only d where d.id = f.park_id and d.classification = 'TEST_FIXTURE');
  if bad is not null then raise exception 'listed fixtures fail the fixture evidence rules or are release parks: %', bad; end if;
  -- tombstoning a DB park that carries user history requires an explicit environment acknowledgement
  select string_agg(t.retired::text, ', ') into bad from s_tomb t join public.parks p on p.id = t.retired
    where pg_temp.has_history(t.retired) and not exists (select 1 from s_ack k where k.park_id = t.retired);
  if bad is not null then raise exception 'release tombstones parks with user history without acknowledgement: %', bad; end if;
end $$;
select pg_temp.maybe_fail('after_baseline');

/* ---------- 5. live parks ---------- */
with ins as (
  insert into public.parks(id, osm_id, name, city, district, latitude, longitude, active, source, imported_at, name_status, name_source, name_source_url, address_label)
  select id, osm_id, name, city, district, latitude, longitude, true, source, now(), name_status, name_source, name_source_url, address_label
  from s_parks s where not exists (select 1 from public.parks p where p.id = s.id)
  returning 1)
select pg_temp.rep('parks_inserted', to_jsonb((select count(*) from ins)));
-- existing rows: data fields only. `active` is never touched (moderation hides survive), a
-- community-reviewed name is left to preserve_reviewed_park_name, address_label only fills blanks.
with upd as (
  update public.parks p set osm_id = s.osm_id, name = s.name, city = s.city, district = s.district, latitude = s.latitude, longitude = s.longitude, source = s.source,
    name_status = s.name_status, name_source = s.name_source, name_source_url = s.name_source_url,
    address_label = case when p.address_label = '' then s.address_label else p.address_label end, imported_at = now()
  from s_parks s where p.id = s.id and (
    (p.osm_id, p.city, p.district, p.latitude, p.longitude, p.source) is distinct from (s.osm_id, s.city, s.district, s.latitude, s.longitude, s.source)
    or (p.name_status <> 'community' and (p.name, p.name_status, p.name_source, p.name_source_url) is distinct from (s.name, s.name_status, s.name_source, s.name_source_url))
    or (p.address_label = '' and s.address_label <> ''))
  returning 1)
select pg_temp.rep('parks_updated', to_jsonb((select count(*) from upd)));
select pg_temp.rep('release_parks_inactive_kept', to_jsonb((select count(*) from s_parks s join b_parks b on b.id = s.id where not b.active)));
-- general feeding point (id = park id) for parks that have none
with ins as (
  insert into public.feeding_points(id, park_id, name, latitude, longitude, active)
  select s.id, s.id, 'Park içi genel nokta', s.latitude, s.longitude, true from s_parks s
  where not exists (select 1 from public.feeding_points fp where fp.park_id = s.id and fp.name = 'Park içi genel nokta')
    and not exists (select 1 from public.feeding_points fp where fp.id = s.id)
  returning 1)
select pg_temp.rep('general_feeding_points_inserted', to_jsonb((select count(*) from ins)));
do $$ begin
  if exists (select 1 from s_parks s where not exists (select 1 from public.feeding_points fp where fp.park_id = s.id and fp.name = 'Park içi genel nokta')) then
    raise exception 'some release parks still lack a general feeding point (id collision)';
  end if;
end $$;
select pg_temp.maybe_fail('after_parks');

/* ---------- 6. aliases: move user content of retired parks that exist in the DB ---------- */
create temp table alias_moves(retired uuid, survivor uuid, points_merged int, points_reparented int, events_moved int, observations_moved int,
  favorites_moved int, favorites_deduped int, suggestions_moved int, suggestions_left int, open_reports_kept int, refs_moved int) on commit drop;
do $$
declare a record; pt record; target uuid; pm int; pr int; ev int; ob int; fm int; fd int; sm int; sl int; orp int; rm int; n int;
begin
  for a in select s.* from s_alias s join public.parks p on p.id = s.retired order by s.retired loop
    pm := 0; pr := 0; ev := 0; ob := 0;
    for pt in select * from public.feeding_points where park_id = a.retired order by id loop
      select id into target from public.feeding_points where park_id = a.survivor and name = pt.name;
      if target is not null then
        -- same-named point already on the survivor (the general point in particular): merge into it
        update public.feeding_events set point_id = target, park_id = a.survivor where point_id = pt.id; get diagnostics n = row_count; ev := ev + n;
        update public.observations set point_id = target where point_id = pt.id; get diagnostics n = row_count; ob := ob + n;
        update public.feeding_points set active = false where id = pt.id;   -- kept (FK-safe, history), no dependents left
        pm := pm + 1;
      else
        update public.feeding_points set park_id = a.survivor where id = pt.id;   -- custom point: re-parent, keeps its id/history
        pr := pr + 1;
      end if;
    end loop;
    update public.feeding_events set park_id = a.survivor where park_id = a.retired; get diagnostics n = row_count; ev := ev + n;
    -- favorites: move; if the user already favours the survivor keep one row (earliest created_at)
    select count(*) into fd from public.favorites f where f.park_id = a.retired and exists (select 1 from public.favorites g where g.user_id = f.user_id and g.park_id = a.survivor);
    insert into public.favorites(user_id, park_id, created_at) select user_id, a.survivor, created_at from public.favorites where park_id = a.retired
      on conflict (user_id, park_id) do update set created_at = least(public.favorites.created_at, excluded.created_at);
    delete from public.favorites where park_id = a.retired; get diagnostics fm := row_count;
    -- pending name suggestions follow the physical park unless the user already has one pending there
    update public.park_name_suggestions s set park_id = a.survivor where s.park_id = a.retired and s.status = 'pending'
      and not exists (select 1 from public.park_name_suggestions x where x.user_id = s.user_id and x.park_id = a.survivor and x.status = 'pending');
    get diagnostics sm := row_count;
    select count(*) into sl from public.park_name_suggestions where park_id = a.retired and status = 'pending';
    select count(*) into orp from public.reports where park_id = a.retired and status = 'open';   -- report history stays on the reported id
    update public.park_source_refs set park_id = a.survivor where park_id = a.retired; get diagnostics rm := row_count;
    update public.parks set active = false where id = a.retired;
    insert into alias_moves values (a.retired, a.survivor, pm, pr, ev, ob, fm, fd, sm, sl, orp, rm);
  end loop;
end $$;
select pg_temp.rep('alias_content_moves', coalesce((select jsonb_agg(to_jsonb(m) order by retired) from alias_moves m), '[]'));
select pg_temp.maybe_fail('after_alias_moves');

/* ---------- 7. lifecycle rows ---------- */
insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, source_code, cluster_id, release_id)
select retired, survivor, reason, source_code, cluster_id, pg_temp.meta('release_id') #>> '{}' from s_alias;
insert into public.canonical_park_tombstones(retired_park_id, status, reason, source_code, cluster_id, release_id)
select retired, status, reason, source_code, cluster_id, pg_temp.meta('release_id') #>> '{}' from s_tomb;
-- release tombstones: bundle refs + any extra DB refs of a tombstoned park (nothing is dropped)
insert into public.canonical_park_tombstone_refs(source_code, external_id, retired_park_id, source_url, first_seen_at)
select t.source_code, t.external_id, t.retired, t.source_url, coalesce((select first_seen_at from public.park_source_refs r where r.source_code = t.source_code and r.external_id = t.external_id), now())
from s_tomb_refs t;
insert into public.canonical_park_tombstone_refs(source_code, external_id, retired_park_id, source_url, metadata, first_seen_at)
select r.source_code, r.external_id, r.park_id, r.source_url, r.metadata, r.first_seen_at from public.park_source_refs r
where r.park_id in (select retired from s_tomb) and not exists (select 1 from s_tomb_refs t where t.source_code = r.source_code and t.external_id = r.external_id);
delete from public.park_source_refs where park_id in (select retired from s_tomb)
  or (source_code, external_id) in (select source_code, external_id from s_tomb_refs);
update public.parks set active = false where id in (select retired from s_tomb) and active;
-- DB-only source-withdrawn parks: generic tombstone, row kept inactive, provenance preserved
insert into public.canonical_park_tombstones(retired_park_id, status, reason, source_code, release_id)
select d.id, 'source_withdrawn',
  'absent from release ' || (pg_temp.meta('release_id') #>> '{}') || ' although all its provenance sources (' || array_to_string(d.prov_sources, ', ') || ') are in scope; kept resolvable'
    || case when d.has_history then ' because historical user content references it' else '' end,
  coalesce(d.prov_sources[1], case when d.osm_id is not null then 'osm' end), pg_temp.meta('release_id') #>> '{}'
from db_only d where d.classification like 'SOURCE_WITHDRAWN%';
insert into public.canonical_park_tombstone_refs(source_code, external_id, retired_park_id, source_url, metadata, first_seen_at)
select r.source_code, r.external_id, r.park_id, r.source_url, r.metadata, r.first_seen_at from public.park_source_refs r
where r.park_id in (select id from db_only where classification like 'SOURCE_WITHDRAWN%');
insert into public.canonical_park_tombstone_refs(source_code, external_id, retired_park_id, source_url)
select 'osm', d.osm_id, d.id, 'https://www.openstreetmap.org/' || d.osm_id from db_only d
where d.classification like 'SOURCE_WITHDRAWN%' and d.osm_id is not null
  and not exists (select 1 from public.canonical_park_tombstone_refs t where t.source_code = 'osm' and t.external_id = d.osm_id);
delete from public.park_source_refs where park_id in (select id from db_only where classification like 'SOURCE_WITHDRAWN%');
update public.parks set active = false where id in (select id from db_only where classification like 'SOURCE_WITHDRAWN%') and active;
select pg_temp.maybe_fail('after_lifecycle');

/* ---------- 8. live source refs ---------- */
with up as (
  insert into public.park_source_refs(source_code, external_id, park_id, source_url)
  select source_code, external_id, park_id, source_url from s_refs
  on conflict (source_code, external_id) do update set park_id = excluded.park_id, source_url = excluded.source_url, last_seen_at = now()
    where (public.park_source_refs.park_id, public.park_source_refs.source_url) is distinct from (excluded.park_id, excluded.source_url)
  returning (xmax = 0) as inserted)
select pg_temp.rep('source_refs_upsert', jsonb_build_object('inserted', (select count(*) from up where inserted), 'updated', (select count(*) from up where not inserted)));

/* ---------- 9. review queue + rejections ---------- */
insert into public.canonical_park_reviews(source_code, external_id, release_id, review_reason, status, name, province, district, latitude, longitude, candidate_canonical_ids, related_canonical_id, source_url, evidence)
select source_code, external_id, pg_temp.meta('release_id') #>> '{}', review_reason, 'open', name, province, district, latitude, longitude, candidate_canonical_ids, related_canonical_id, source_url, evidence from s_reviews
on conflict (source_code, external_id) do update set release_id = excluded.release_id, review_reason = excluded.review_reason, status = 'open', name = excluded.name, province = excluded.province,
  district = excluded.district, latitude = excluded.latitude, longitude = excluded.longitude, candidate_canonical_ids = excluded.candidate_canonical_ids,
  related_canonical_id = excluded.related_canonical_id, source_url = excluded.source_url, evidence = excluded.evidence, updated_at = now();
insert into public.canonical_park_rejections(source_code, external_id, release_id, classification, reason, taxonomy_class, retired_park_id, source_url, evidence)
select source_code, external_id, pg_temp.meta('release_id') #>> '{}', classification, reason, taxonomy_class, retired_park_id, source_url, evidence from s_rejections
on conflict (source_code, external_id) do update set release_id = excluded.release_id, classification = excluded.classification, reason = excluded.reason,
  taxonomy_class = excluded.taxonomy_class, retired_park_id = excluded.retired_park_id, source_url = excluded.source_url, evidence = excluded.evidence;
select pg_temp.maybe_fail('before_invariants');

/* ---------- 10. final invariants (any failure aborts the release) ---------- */
do $$
declare ec jsonb := pg_temp.meta('expected_counts'); rid text := pg_temp.meta('release_id') #>> '{}'; n bigint; bc record;
begin
  select * into bc from b_counts;
  select count(*) into n from s_parks s where not exists (select 1 from public.parks p where p.id = s.id); if n > 0 then raise exception 'INV: % release parks missing', n; end if;
  select count(*) into n from s_parks s join public.parks p on p.id = s.id where not p.active and not exists (select 1 from b_parks x where x.id = s.id and not x.active);
  if n > 0 then raise exception 'INV: % release parks inactive that were not moderation-hidden before', n; end if;
  select count(*) into n from s_parks s join public.parks p on p.id = s.id where p.osm_id is not null; if n <> (ec->>'osm_backed_parks')::int then raise exception 'INV: OSM-backed % != %', n, ec->>'osm_backed_parks'; end if;
  select count(*) into n from s_refs s where not exists (select 1 from public.park_source_refs r where r.source_code = s.source_code and r.external_id = s.external_id and r.park_id = s.park_id);
  if n > 0 then raise exception 'INV: % release refs not attached as specified', n; end if;
  select count(*) into n from s_alias s where not exists (select 1 from public.canonical_park_aliases a where a.retired_park_id = s.retired and a.canonical_park_id = s.survivor and a.release_id = rid); if n > 0 then raise exception 'INV: % aliases missing', n; end if;
  select count(*) into n from s_tomb s where not exists (select 1 from public.canonical_park_tombstones t where t.retired_park_id = s.retired and t.status = s.status and t.release_id = rid); if n > 0 then raise exception 'INV: % tombstones missing', n; end if;
  select count(*) into n from s_tomb_refs s where not exists (select 1 from public.canonical_park_tombstone_refs t where t.source_code = s.source_code and t.external_id = s.external_id and t.retired_park_id = s.retired); if n > 0 then raise exception 'INV: % tombstone refs missing', n; end if;
  select count(*) into n from public.parks p where p.active and (exists (select 1 from public.canonical_park_aliases a where a.retired_park_id = p.id) or exists (select 1 from public.canonical_park_tombstones t where t.retired_park_id = p.id));
  if n > 0 then raise exception 'INV: % retired parks still active', n; end if;
  select count(*) into n from public.canonical_park_aliases a where not exists (select 1 from public.parks p where p.id = a.canonical_park_id and p.active)
    or exists (select 1 from public.canonical_park_aliases b where b.retired_park_id = a.canonical_park_id) or exists (select 1 from public.canonical_park_tombstones t where t.retired_park_id = a.canonical_park_id);
  if n > 0 then raise exception 'INV: % aliases without a live one-hop survivor', n; end if;
  select count(*) into n from b_refs b where not exists (select 1 from public.park_source_refs r where r.source_code = b.source_code and r.external_id = b.external_id)
    and not exists (select 1 from public.canonical_park_tombstone_refs t where t.source_code = b.source_code and t.external_id = b.external_id);
  if n > 0 then raise exception 'INV: % pre-existing source refs lost', n; end if;
  select count(*) into n from public.canonical_park_reviews where release_id = rid and status = 'open'; if n <> (ec->>'reviews')::int then raise exception 'INV: open reviews % != %', n, ec->>'reviews'; end if;
  select count(*) into n from public.canonical_park_rejections where release_id = rid; if n <> (ec->>'rejections')::int then raise exception 'INV: rejections % != %', n, ec->>'rejections'; end if;
  -- user content: nothing deleted except favorites merged into an identical (user, survivor) favorite
  if (select count(*) from public.feeding_events) <> bc.feeding_events then raise exception 'INV: feeding_events count changed'; end if;
  if (select count(*) from public.observations) <> bc.observations then raise exception 'INV: observations count changed'; end if;
  if (select count(*) from public.park_name_suggestions) <> bc.name_suggestions then raise exception 'INV: name suggestions count changed'; end if;
  if (select count(*) from public.reports) <> bc.reports then raise exception 'INV: reports count changed'; end if;
  if (select count(*) from public.feeding_points) <> bc.feeding_points + (select (v #>> '{}')::bigint from rpt where k = 'general_feeding_points_inserted') then raise exception 'INV: feeding_points count changed unexpectedly'; end if;
  select count(*) into n from b_favorites f where not exists (select 1 from public.favorites g where g.user_id = f.user_id
    and g.park_id = coalesce((select canonical_park_id from public.canonical_park_aliases a where a.retired_park_id = f.park_id), f.park_id));
  if n > 0 then raise exception 'INV: % favorites lost', n; end if;
  if (select count(*) from public.favorites) <> bc.favorites - coalesce((select sum(favorites_deduped) from alias_moves), 0) then raise exception 'INV: favorites count mismatch'; end if;
  select count(*) into n from public.feeding_events e join public.feeding_points fp on fp.id = e.point_id where fp.park_id <> e.park_id;
  if n > bc.event_point_park_mismatch then raise exception 'INV: feeding event/point park consistency degraded (% > %)', n, bc.event_point_park_mismatch; end if;
  select count(*) into n from public.feeding_events e join public.feeding_points fp on fp.id = e.point_id where not fp.active and e.status = 'published'
    and exists (select 1 from alias_moves m where m.retired = fp.park_id);
  if n > 0 then raise exception 'INV: % published events still on a merged (inactive) point', n; end if;
end $$;
set constraints all immediate;   -- fire every deferred lifecycle/holder trigger now, inside the transaction

update public.canonical_park_releases set status = 'applied', applied_at = now() where release_id = pg_temp.meta('release_id') #>> '{}';
select pg_temp.rep('after', jsonb_build_object(
  'parks', (select count(*) from public.parks), 'active_parks', (select count(*) from public.parks where active), 'inactive_parks', (select count(*) from public.parks where not active),
  'release_live_parks_active', (select count(*) from s_parks s join public.parks p on p.id = s.id where p.active),
  'park_source_refs', (select count(*) from public.park_source_refs), 'feeding_points', (select count(*) from public.feeding_points), 'feeding_events', (select count(*) from public.feeding_events),
  'observations', (select count(*) from public.observations), 'favorites', (select count(*) from public.favorites), 'name_suggestions', (select count(*) from public.park_name_suggestions),
  'reports', (select count(*) from public.reports), 'aliases', (select count(*) from public.canonical_park_aliases), 'tombstones', (select count(*) from public.canonical_park_tombstones),
  'tombstones_by_status', (select jsonb_object_agg(status, n) from (select status, count(*) n from public.canonical_park_tombstones group by status) x),
  'tombstone_refs', (select count(*) from public.canonical_park_tombstone_refs), 'reviews', (select count(*) from public.canonical_park_reviews),
  'rejections', (select count(*) from public.canonical_park_rejections)));
