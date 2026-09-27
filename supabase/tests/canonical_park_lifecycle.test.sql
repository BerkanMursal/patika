-- Local-only test for 202609270001_canonical_park_lifecycle.sql.
-- Everything runs in ONE transaction that is rolled back at the end: fixture
-- rows never persist. Deferred integrity triggers are forced with
-- SET CONSTRAINTS ALL IMMEDIATE inside sub-transactions.
--   docker exec -i supabase_db_patika psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/canonical_park_lifecycle.test.sql
begin;

create function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end;$$;

-- expect `stmt` (followed by an immediate constraint check) to fail with errcode `code`
create function pg_temp.rejects(stmt text, code text, label text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
    set constraints all immediate;
  exception when others then
    if sqlstate <> code then raise exception 'FAIL: % (expected %, got %: %)', label, code, sqlstate, sqlerrm; end if;
    raise notice 'PASS: % [% %]', label, sqlstate, sqlerrm;
    return;
  end;
  raise exception 'FAIL: % (statement was accepted)', label;
end;$$;

-- fixtures -------------------------------------------------------------------
insert into public.canonical_park_releases(release_id, base_snapshot_sha256, manifest_sha256, expected_counts)
values ('test-release-1', repeat('a', 64), repeat('b', 64), '{"canonical": 3}');

insert into public.parks(id, name, city, latitude, longitude, active, source) values
  ('f0000000-0000-4000-8000-000000000001', 'Test Survivor Park', 'Ordu', 40.98, 37.87, true, 'test'),
  ('f0000000-0000-4000-8000-000000000002', 'Test Other Live Park', 'Ordu', 40.99, 37.88, true, 'test'),
  ('f0000000-0000-4000-8000-000000000003', 'Test Retired Fragment', 'Ordu', 40.981, 37.871, true, 'test'),
  ('f0000000-0000-4000-8000-000000000004', 'Test Hidden Park', 'Ordu', 40.97, 37.86, false, 'test'),
  ('f0000000-0000-4000-8000-000000000005', 'Test Retired Path', 'Ordu', 40.96, 37.85, true, 'test');
insert into public.park_source_refs(source_code, external_id, park_id) values
  ('test_src', '1', 'f0000000-0000-4000-8000-000000000001'),
  ('test_src', '3', 'f0000000-0000-4000-8000-000000000003'),
  ('test_src', '5', 'f0000000-0000-4000-8000-000000000005');

-- positive: consolidate #3 into #1 (existing row), alias a never-materialised preview id,
-- tombstone #5 with its source ref moved into tombstone refs
update public.parks set active = false where id in ('f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000005');
update public.park_source_refs set park_id = 'f0000000-0000-4000-8000-000000000001' where source_code = 'test_src' and external_id = '3';
insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, source_code, release_id) values
  ('f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000001', 'fragment of one physical park', 'test_src', 'test-release-1'),
  ('f0000000-0000-4000-8000-0000000000aa', 'f0000000-0000-4000-8000-000000000001', 'preview-only id consolidated', 'test_src', 'test-release-1');
insert into public.canonical_park_tombstones(retired_park_id, status, reason, source_code, release_id) values
  ('f0000000-0000-4000-8000-000000000005', 'taxonomy_review', 'path-like, no row-level park evidence', 'test_src', 'test-release-1'),
  ('f0000000-0000-4000-8000-0000000000bb', 'non_park', 'bicycle layer', 'test_src', 'test-release-1');
delete from public.park_source_refs where source_code = 'test_src' and external_id = '5';
insert into public.canonical_park_tombstone_refs(source_code, external_id, retired_park_id)
values ('test_src', '5', 'f0000000-0000-4000-8000-000000000005');
set constraints all immediate;
select pg_temp.ok(true, 'valid consolidation + tombstone batch passes all deferred checks');
set constraints all deferred;

-- resolve_park_id ------------------------------------------------------------
select pg_temp.ok((select status = 'live' and resolved_park_id = 'f0000000-0000-4000-8000-000000000002' from public.resolve_park_id('f0000000-0000-4000-8000-000000000002')), 'live id resolves to itself');
select pg_temp.ok((select status = 'alias' and resolved_park_id = 'f0000000-0000-4000-8000-000000000001' from public.resolve_park_id('f0000000-0000-4000-8000-000000000003')), 'alias (existing inactive row) resolves to survivor');
select pg_temp.ok((select status = 'alias' and resolved_park_id = 'f0000000-0000-4000-8000-000000000001' from public.resolve_park_id('f0000000-0000-4000-8000-0000000000aa')), 'alias (never-materialised id) resolves to survivor');
select pg_temp.ok((select status = 'tombstone' and resolved_park_id is null and tombstone_status = 'taxonomy_review' and reason like 'path-like%' from public.resolve_park_id('f0000000-0000-4000-8000-000000000005')), 'tombstone returns tombstone state + reason');
select pg_temp.ok((select status = 'tombstone' and tombstone_status = 'non_park' from public.resolve_park_id('f0000000-0000-4000-8000-0000000000bb')), 'non_park tombstone state');
select pg_temp.ok((select status = 'inactive' and resolved_park_id is null from public.resolve_park_id('f0000000-0000-4000-8000-000000000004')), 'moderation-hidden (not retired) park is inactive, not a tombstone');
select pg_temp.ok((select status = 'not_found' and resolved_park_id is null from public.resolve_park_id('f0000000-0000-4000-8000-0000000000ff')), 'unknown id is not_found');
select pg_temp.ok((select count(*) = 1 from public.resolve_park_id('f0000000-0000-4000-8000-000000000003')), 'resolver returns exactly one row');
select pg_temp.ok((select count(*) = 1 and bool_and(status = 'not_found') from public.resolve_park_id(null)), 'null id is not_found');

-- rejected shapes ------------------------------------------------------------
select pg_temp.rejects($$insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000002','x','test-release-1')$$, '23514', 'self alias rejected');
select pg_temp.rejects($$insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-000000000003','f0000000-0000-4000-8000-000000000002','x','test-release-1')$$, '23505', 'duplicate retired id (alias) rejected');
select pg_temp.rejects($$insert into public.canonical_park_tombstones(retired_park_id, status, reason, release_id) values ('f0000000-0000-4000-8000-000000000005','non_park','x','test-release-1')$$, '23505', 'duplicate retired id (tombstone) rejected');
select pg_temp.rejects($$insert into public.canonical_park_tombstones(retired_park_id, status, reason, release_id) values ('f0000000-0000-4000-8000-000000000003','non_park','x','test-release-1')$$, '23514', 'alias/tombstone overlap rejected (tombstone of an alias)');
select pg_temp.rejects($$insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-0000000000bb','f0000000-0000-4000-8000-000000000001','x','test-release-1')$$, '23514', 'alias/tombstone overlap rejected (alias of a tombstone)');
select pg_temp.rejects($$insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-0000000000c1','f0000000-0000-4000-8000-0000000000ee','x','test-release-1')$$, '23503', 'missing survivor rejected (FK)');
select pg_temp.rejects($$insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-0000000000c1','f0000000-0000-4000-8000-000000000004','x','test-release-1')$$, '23514', 'inactive survivor rejected');
select pg_temp.rejects($$insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-0000000000c1','f0000000-0000-4000-8000-000000000003','x','test-release-1')$$, '23514', 'chain rejected (survivor is itself retired)');
select pg_temp.rejects($$update public.parks set active=false where id='f0000000-0000-4000-8000-000000000001'; insert into public.canonical_park_tombstones(retired_park_id, status, reason, release_id) values ('f0000000-0000-4000-8000-000000000001','non_park','x','test-release-1')$$, '23514', 'retiring a survivor without flattening its aliases rejected');
select pg_temp.rejects($$update public.parks set active=false where id='f0000000-0000-4000-8000-000000000002'; insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001','x','test-release-1'); update public.parks set active=false where id='f0000000-0000-4000-8000-000000000001'; insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000002','x','test-release-1')$$, '23514', 'cycle A->B, B->A rejected');
select pg_temp.rejects($$insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001','x','test-release-1')$$, '23514', 'retiring a still-active park rejected');
select pg_temp.rejects($$update public.parks set active=true where id='f0000000-0000-4000-8000-000000000003'$$, '23514', 'reactivating a retired park rejected');
select pg_temp.rejects($$insert into public.parks(id,name,latitude,longitude,active) values ('f0000000-0000-4000-8000-0000000000aa','x',40,37,true)$$, '23514', 'importing a retired id as a new live park rejected');
select pg_temp.rejects($$insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id) values ('f0000000-0000-4000-8000-0000000000c2','f0000000-0000-4000-8000-000000000001','x','no-such-release')$$, '23503', 'alias without a registered release rejected');

-- source-ref uniqueness --------------------------------------------------------
select pg_temp.rejects($$insert into public.park_source_refs(source_code, external_id, park_id) values ('test_src','5','f0000000-0000-4000-8000-000000000002')$$, '23505', 'live ref duplicating a tombstone ref rejected');
select pg_temp.rejects($$insert into public.canonical_park_tombstone_refs(source_code, external_id, retired_park_id) values ('test_src','1','f0000000-0000-4000-8000-0000000000bb')$$, '23505', 'tombstone ref duplicating a live ref rejected');
select pg_temp.rejects($$insert into public.park_source_refs(source_code, external_id, park_id) values ('test_src','3','f0000000-0000-4000-8000-000000000002')$$, '23505', 'duplicate live source ref rejected (PK)');
select pg_temp.ok((select count(*) = 2 from public.park_source_refs where source_code = 'test_src' and park_id = 'f0000000-0000-4000-8000-000000000001'), 'retired fragment ref moved to survivor (no ref lost)');

-- source_withdrawn: a park that left the source snapshot stays resolvable -------
insert into public.parks(id, name, city, latitude, longitude, active, source) values
  ('f0000000-0000-4000-8000-000000000006', 'Test Withdrawn Park', 'İzmir', 38.4, 27.1, true, 'test');
insert into public.park_source_refs(source_code, external_id, park_id) values ('test_src', '6', 'f0000000-0000-4000-8000-000000000006');
update public.parks set active = false where id = 'f0000000-0000-4000-8000-000000000006';
insert into public.canonical_park_tombstones(retired_park_id, status, reason, source_code, release_id)
values ('f0000000-0000-4000-8000-000000000006', 'source_withdrawn', 'absent from the canonical source snapshot', 'test_src', 'test-release-1');
delete from public.park_source_refs where source_code = 'test_src' and external_id = '6';
insert into public.canonical_park_tombstone_refs(source_code, external_id, retired_park_id) values ('test_src', '6', 'f0000000-0000-4000-8000-000000000006');
set constraints all immediate;
select pg_temp.ok((select status = 'tombstone' and tombstone_status = 'source_withdrawn' and resolved_park_id is null from public.resolve_park_id('f0000000-0000-4000-8000-000000000006')), 'source_withdrawn tombstone resolves as tombstone/source_withdrawn');
select pg_temp.ok(exists (select 1 from public.parks where id = 'f0000000-0000-4000-8000-000000000006' and not active), 'source_withdrawn parks row kept (inactive), not deleted');
set constraints all deferred;

-- reviews / rejections: never mixed with live provenance ---------------------------
insert into public.canonical_park_reviews(source_code, external_id, release_id, review_reason, name, latitude, longitude, evidence)
values ('test_src', 'r1', 'test-release-1', 'multiple_osm_candidates', 'Aday Park', 40.9, 37.8, '{"flags":{}}');
insert into public.canonical_park_rejections(source_code, external_id, release_id, classification, reason)
values ('test_src', 'x1', 'test-release-1', 'non_park', 'bicycle layer');
-- a demoted canonical's tombstone ref and its review item may coexist
insert into public.canonical_park_reviews(source_code, external_id, release_id, review_reason, related_canonical_id)
values ('test_src', '5', 'test-release-1', 'taxonomy_ambiguous_physical_park', 'f0000000-0000-4000-8000-000000000005');
set constraints all immediate;
select pg_temp.ok(true, 'review, rejection and tombstone-ref + review coexistence accepted');
set constraints all deferred;
select pg_temp.rejects($$insert into public.park_source_refs(source_code, external_id, park_id) values ('test_src','r1','f0000000-0000-4000-8000-000000000002')$$, '23505', 'open review cannot also be a live park ref');
select pg_temp.rejects($$insert into public.park_source_refs(source_code, external_id, park_id) values ('test_src','x1','f0000000-0000-4000-8000-000000000002')$$, '23505', 'rejection cannot also be a live park ref');
select pg_temp.rejects($$insert into public.canonical_park_reviews(source_code, external_id, release_id, review_reason) values ('test_src','1','test-release-1','x')$$, '23505', 'open review of an already-live ref rejected');
select pg_temp.rejects($$insert into public.canonical_park_reviews(source_code, external_id, release_id, review_reason) values ('test_src','r1','test-release-1','x')$$, '23505', 'duplicate review identity rejected');
select pg_temp.rejects($$insert into public.canonical_park_tombstones(retired_park_id, status, reason, release_id) values ('f0000000-0000-4000-8000-0000000000c3','deleted','x','test-release-1')$$, '23514', 'unknown tombstone status rejected');
update public.canonical_park_reviews set status = 'resolved' where source_code = 'test_src' and external_id = 'r1';
insert into public.park_source_refs(source_code, external_id, park_id) values ('test_src', 'r1', 'f0000000-0000-4000-8000-000000000002');
set constraints all immediate;
select pg_temp.ok(true, 'a RESOLVED review may become a live park ref');
set constraints all deferred;

-- immutability ---------------------------------------------------------------
select pg_temp.rejects($$update public.canonical_park_aliases set reason='changed' where retired_park_id='f0000000-0000-4000-8000-000000000003'$$, '55000', 'alias update blocked without maintenance mode');
select pg_temp.rejects($$delete from public.canonical_park_tombstones where retired_park_id='f0000000-0000-4000-8000-0000000000bb'$$, '55000', 'tombstone delete blocked without maintenance mode');
select pg_temp.rejects($$truncate public.canonical_park_aliases$$, '55000', 'alias truncate blocked');
select pg_temp.rejects($$delete from public.parks where id='f0000000-0000-4000-8000-000000000001'$$, '23503', 'hard delete of an alias survivor blocked');

-- positive flattening: survivor #1 later retires into #2 -> re-point its aliases in maintenance mode
set local patika.lifecycle_maintenance = 'on';
update public.canonical_park_aliases set canonical_park_id = 'f0000000-0000-4000-8000-000000000002' where canonical_park_id = 'f0000000-0000-4000-8000-000000000001';
set local patika.lifecycle_maintenance = 'off';
update public.parks set active = false where id = 'f0000000-0000-4000-8000-000000000001';
update public.park_source_refs set park_id = 'f0000000-0000-4000-8000-000000000002' where park_id = 'f0000000-0000-4000-8000-000000000001';
insert into public.canonical_park_aliases(retired_park_id, canonical_park_id, reason, release_id)
values ('f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 'second consolidation', 'test-release-1');
set constraints all immediate;
select pg_temp.ok((select bool_and(r.resolved_park_id = 'f0000000-0000-4000-8000-000000000002')
  from unnest(array['f0000000-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000003','f0000000-0000-4000-8000-0000000000aa']::uuid[]) id,
  lateral public.resolve_park_id(id) r), 'flattened re-point: all former ids resolve in one hop to the new survivor');
select pg_temp.ok(not exists (select 1 from public.canonical_park_aliases a join public.canonical_park_aliases b on b.retired_park_id = a.canonical_park_id), 'no alias chains remain');
set constraints all deferred;

-- regression: existing read paths still serve only live parks -------------------
select pg_temp.ok((select count(*) = 1 from public.get_park('f0000000-0000-4000-8000-000000000002')), 'get_park works for a live id');
select pg_temp.ok((select count(*) = 0 from public.get_park('f0000000-0000-4000-8000-000000000003')), 'get_park returns nothing for a retired id');
select pg_temp.ok(not exists (select 1 from public.get_parks(40.9, 41.0, 37.8, 37.9) where id in ('f0000000-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000003','f0000000-0000-4000-8000-000000000005')), 'get_parks excludes retired ids');
select pg_temp.ok(exists (select 1 from public.get_parks(40.9, 41.0, 37.8, 37.9) where id = 'f0000000-0000-4000-8000-000000000002'), 'get_parks still returns live ids');

-- privileges -----------------------------------------------------------------
set local role anon;
select pg_temp.ok((select status = 'alias' from public.resolve_park_id('f0000000-0000-4000-8000-000000000003')), 'anon can call resolve_park_id (deep links)');
reset role;
select pg_temp.ok(not has_table_privilege('anon', 'public.canonical_park_aliases', 'select') and not has_table_privilege('authenticated', 'public.canonical_park_tombstones', 'select') and not has_table_privilege('authenticated', 'public.canonical_park_tombstone_refs', 'select'), 'lifecycle tables are not client-readable');

rollback;
