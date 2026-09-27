-- Canonical park LIFECYCLE schema (no data). A canonical park id, once
-- published, is never hard-deleted and never silently disappears: when a
-- canonical release consolidates duplicates or rejects a record, the retired
-- id is registered exactly once, either as
--   * an ALIAS    -> resolves to one live surviving park (flattened: one hop), or
--   * a TOMBSTONE -> resolves to no live park (taxonomy_review / non_park /
--                    source_withdrawn: no longer in the canonical source
--                    snapshot but kept resolvable for historical content),
-- and resolve_park_id() answers for any id ever issued. Source records that a
-- release does not turn into a live park are kept as durable review /
-- rejection rows. Release data itself is imported separately by a
-- single-transaction importer; this migration only adds tables, integrity
-- triggers and the resolver. Existing tables, RPCs and policies are unchanged
-- except for added integrity triggers on parks (a retired id cannot be
-- re-activated) and park_source_refs (a source ref has exactly one holder).
--
-- Retired ids are deliberately NOT foreign keys to parks: a release may retire
-- ids that were only ever published in a preview (never materialised in this
-- database). When a retired id does exist in parks, its row stays in place with
-- active=false (historical user rows keep a valid FK target) and may never be
-- re-activated while it is registered as retired.

create table public.canonical_park_releases (
  release_id text primary key
    check (release_id ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),
  base_snapshot_sha256 text not null check (base_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  expected_counts jsonb not null,
  status text not null default 'applying' check (status in ('applying', 'applied')),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  check ((status = 'applied') = (applied_at is not null))
);

create table public.canonical_park_aliases (
  retired_park_id uuid primary key,
  canonical_park_id uuid not null references public.parks(id) on delete restrict,
  reason text not null check (char_length(reason) between 1 and 1000),
  source_code text check (source_code is null or (char_length(source_code) between 1 and 80 and source_code = lower(source_code))),
  cluster_id text,
  release_id text not null references public.canonical_park_releases(release_id) on delete restrict,
  created_at timestamptz not null default now(),
  check (retired_park_id <> canonical_park_id)
);
create index canonical_park_aliases_target on public.canonical_park_aliases(canonical_park_id);

create table public.canonical_park_tombstones (
  retired_park_id uuid primary key,
  status text not null check (status in ('taxonomy_review', 'non_park', 'source_withdrawn')),
  reason text not null check (char_length(reason) between 1 and 1000),
  source_code text check (source_code is null or (char_length(source_code) between 1 and 80 and source_code = lower(source_code))),
  cluster_id text,
  release_id text not null references public.canonical_park_releases(release_id) on delete restrict,
  created_at timestamptz not null default now()
);

-- Source evidence of a tombstoned id. Same key as park_source_refs so a
-- (source_code, external_id) pair is held by exactly one live park OR one
-- tombstone (cross-table check below); nothing is dropped when a park retires.
create table public.canonical_park_tombstone_refs (
  source_code text not null check (char_length(source_code) between 1 and 80 and source_code = lower(source_code)),
  external_id text not null check (char_length(external_id) between 1 and 200),
  retired_park_id uuid not null references public.canonical_park_tombstones(retired_park_id) on delete restrict,
  source_url text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  retired_at timestamptz not null default now(),
  primary key (source_code, external_id)
);
create index canonical_park_tombstone_refs_park on public.canonical_park_tombstone_refs(retired_park_id);

-- Source records that a release did NOT turn into (or attach to) a live park.
-- One row per source record (its current state); release_id says which release
-- produced it. An OPEN review / a rejection never coexists with a live
-- park_source_refs row for the same (source_code, external_id).
create table public.canonical_park_reviews (
  source_code text not null check (char_length(source_code) between 1 and 80 and source_code = lower(source_code)),
  external_id text not null check (char_length(external_id) between 1 and 200),
  release_id text not null references public.canonical_park_releases(release_id) on delete restrict,
  review_reason text not null check (char_length(review_reason) between 1 and 200),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  name text not null default '',
  province text not null default '',
  district text not null default '',
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  candidate_canonical_ids uuid[] not null default '{}',
  related_canonical_id uuid,
  source_url text not null default '',
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_code, external_id),
  check ((latitude is null) = (longitude is null))
);
create index canonical_park_reviews_open on public.canonical_park_reviews(status, source_code) where status = 'open';

create table public.canonical_park_rejections (
  source_code text not null check (char_length(source_code) between 1 and 80 and source_code = lower(source_code)),
  external_id text not null check (char_length(external_id) between 1 and 200),
  release_id text not null references public.canonical_park_releases(release_id) on delete restrict,
  classification text not null check (classification in ('non_park')),
  reason text not null check (char_length(reason) between 1 and 1000),
  taxonomy_class text,
  retired_park_id uuid,
  source_url text not null default '',
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (source_code, external_id)
);

-- Service-role only, like park_source_refs. Clients reach lifecycle state
-- solely through resolve_park_id().
alter table public.canonical_park_releases enable row level security;
alter table public.canonical_park_aliases enable row level security;
alter table public.canonical_park_tombstones enable row level security;
alter table public.canonical_park_tombstone_refs enable row level security;
alter table public.canonical_park_reviews enable row level security;
alter table public.canonical_park_rejections enable row level security;
revoke all on public.canonical_park_releases, public.canonical_park_aliases, public.canonical_park_tombstones, public.canonical_park_tombstone_refs, public.canonical_park_reviews, public.canonical_park_rejections from public, anon, authenticated;
grant all on public.canonical_park_releases, public.canonical_park_aliases, public.canonical_park_tombstones, public.canonical_park_tombstone_refs, public.canonical_park_reviews, public.canonical_park_rejections to service_role;

-- Immutability: lifecycle history is append-only. An explicit correction
-- migration (or the importer's alias-flattening step) must opt in with
--   set local patika.lifecycle_maintenance = 'on';
create function public.canonical_lifecycle_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if coalesce(current_setting('patika.lifecycle_maintenance', true), '') <> 'on' then
    raise exception 'canonical lifecycle records are immutable (% on %)', tg_op, tg_table_name using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;$$;
create trigger canonical_park_aliases_immutable before update or delete on public.canonical_park_aliases for each row execute function public.canonical_lifecycle_immutable();
create trigger canonical_park_tombstones_immutable before update or delete on public.canonical_park_tombstones for each row execute function public.canonical_lifecycle_immutable();
create trigger canonical_park_tombstone_refs_immutable before update or delete on public.canonical_park_tombstone_refs for each row execute function public.canonical_lifecycle_immutable();
create trigger canonical_park_aliases_no_truncate before truncate on public.canonical_park_aliases for each statement execute function public.canonical_lifecycle_immutable();
create trigger canonical_park_tombstones_no_truncate before truncate on public.canonical_park_tombstones for each statement execute function public.canonical_lifecycle_immutable();
create trigger canonical_park_tombstone_refs_no_truncate before truncate on public.canonical_park_tombstone_refs for each statement execute function public.canonical_lifecycle_immutable();

-- Cross-table integrity, checked at COMMIT (deferred) so a release can be
-- applied in any statement order inside one transaction; any violation aborts
-- the whole transaction.
-- Deferred row triggers see the NEW image queued at event time, so every check
-- re-reads the CURRENT rows (a later statement in the same transaction may have
-- re-pointed, deactivated or removed them).
create function public.canonical_lifecycle_check() returns trigger language plpgsql set search_path='' as $$
declare rid uuid := new.retired_park_id; survivor uuid;
begin
  -- still registered? (a maintenance delete/replace in the same txn may have removed it)
  if not exists (select 1 from public.canonical_park_aliases where retired_park_id = rid)
     and not exists (select 1 from public.canonical_park_tombstones where retired_park_id = rid) then
    return null;
  end if;
  if exists (select 1 from public.canonical_park_aliases where retired_park_id = rid)
     and exists (select 1 from public.canonical_park_tombstones where retired_park_id = rid) then
    raise exception 'retired park % is both an alias and a tombstone', rid using errcode = '23514';
  end if;
  if exists (select 1 from public.parks where id = rid and active) then
    raise exception 'retired park % is still active in parks', rid using errcode = '23514';
  end if;
  -- flattened: nothing may point at a retired id (no chains, hence no cycles)
  if exists (select 1 from public.canonical_park_aliases where canonical_park_id = rid) then
    raise exception 'retired park % is the survivor of another alias (flatten aliases first)', rid using errcode = '23514';
  end if;
  select canonical_park_id into survivor from public.canonical_park_aliases where retired_park_id = rid;
  if survivor is not null then
    if not exists (select 1 from public.parks where id = survivor and active) then
      raise exception 'alias survivor % is not a live park', survivor using errcode = '23514';
    end if;
    if exists (select 1 from public.canonical_park_aliases where retired_park_id = survivor)
       or exists (select 1 from public.canonical_park_tombstones where retired_park_id = survivor) then
      raise exception 'alias survivor % is itself retired (chain)', survivor using errcode = '23514';
    end if;
  end if;
  return null;
end;$$;
create constraint trigger canonical_park_aliases_integrity after insert or update on public.canonical_park_aliases
  deferrable initially deferred for each row execute function public.canonical_lifecycle_check();
create constraint trigger canonical_park_tombstones_integrity after insert or update on public.canonical_park_tombstones
  deferrable initially deferred for each row execute function public.canonical_lifecycle_check();

-- A retired id can never come back to life through a later (re)import or a
-- manual update (e.g. an upsert that writes active=true).
create function public.parks_retired_stay_inactive() returns trigger language plpgsql set search_path='' as $$
begin
  -- current row state, not the queued NEW image (see canonical_lifecycle_check)
  if exists (select 1 from public.parks where id = new.id and active)
     and (exists (select 1 from public.canonical_park_aliases where retired_park_id = new.id)
                     or exists (select 1 from public.canonical_park_tombstones where retired_park_id = new.id)) then
    raise exception 'park % is retired (canonical alias/tombstone) and cannot be active', new.id using errcode = '23514';
  end if;
  return null;
end;$$;
create constraint trigger parks_retired_stay_inactive after insert or update of active on public.parks
  deferrable initially deferred for each row execute function public.parks_retired_stay_inactive();

-- A (source_code, external_id) held by a live park may not at the same time be
-- held by a tombstone, be an OPEN review, or be rejected. (A tombstone ref and a
-- review/rejection may coexist: a demoted canonical's provenance + its queue item.)
create function public.source_ref_single_holder() returns trigger language plpgsql set search_path='' as $$
begin
  if not exists (select 1 from public.park_source_refs where source_code = new.source_code and external_id = new.external_id) then
    return null;
  end if;
  if exists (select 1 from public.canonical_park_tombstone_refs where source_code = new.source_code and external_id = new.external_id) then
    raise exception 'source ref %:% is held by both a live park and a tombstone', new.source_code, new.external_id using errcode = '23505';
  end if;
  if exists (select 1 from public.canonical_park_reviews where source_code = new.source_code and external_id = new.external_id and status = 'open') then
    raise exception 'source ref %:% is both a live park ref and an open review', new.source_code, new.external_id using errcode = '23505';
  end if;
  if exists (select 1 from public.canonical_park_rejections where source_code = new.source_code and external_id = new.external_id) then
    raise exception 'source ref %:% is both a live park ref and a rejection', new.source_code, new.external_id using errcode = '23505';
  end if;
  return null;
end;$$;
create constraint trigger park_source_refs_single_holder after insert or update of source_code, external_id on public.park_source_refs
  deferrable initially deferred for each row execute function public.source_ref_single_holder();
create constraint trigger canonical_park_tombstone_refs_single_holder after insert or update of source_code, external_id on public.canonical_park_tombstone_refs
  deferrable initially deferred for each row execute function public.source_ref_single_holder();
create constraint trigger canonical_park_reviews_single_holder after insert or update of source_code, external_id, status on public.canonical_park_reviews
  deferrable initially deferred for each row execute function public.source_ref_single_holder();
create constraint trigger canonical_park_rejections_single_holder after insert or update of source_code, external_id on public.canonical_park_rejections
  deferrable initially deferred for each row execute function public.source_ref_single_holder();

-- resolve_park_id: answers for ANY park id ever issued.
--   live       -> resolved_park_id = input
--   alias      -> resolved_park_id = survivor (one hop; aliases are flattened)
--   tombstone  -> resolved_park_id = null, tombstone_status (taxonomy_review /
--                 non_park / source_withdrawn) + reason
--   inactive   -> exists but hidden (moderation), not retired; no id returned
--   not_found  -> never issued in this database
-- Lifecycle is checked first: a retired id may still have an (inactive) parks row.
create function public.resolve_park_id(p_id uuid)
returns table(status text, resolved_park_id uuid, tombstone_status text, reason text, release_id text)
language sql stable security definer set search_path='' as $$
  select * from (
    select 'alias'::text, a.canonical_park_id, null::text, a.reason, a.release_id
      from public.canonical_park_aliases a where a.retired_park_id = p_id
    union all
    select 'tombstone', null::uuid, t.status, t.reason, t.release_id
      from public.canonical_park_tombstones t where t.retired_park_id = p_id
    union all
    select case when p.active then 'live' else 'inactive' end, case when p.active then p.id end, null, null, null
      from public.parks p where p.id = p_id
        and not exists (select 1 from public.canonical_park_aliases where retired_park_id = p_id)
        and not exists (select 1 from public.canonical_park_tombstones where retired_park_id = p_id)
    union all
    select 'not_found', null, null, null, null
      where p_id is null or (not exists (select 1 from public.parks where id = p_id)
        and not exists (select 1 from public.canonical_park_aliases where retired_park_id = p_id)
        and not exists (select 1 from public.canonical_park_tombstones where retired_park_id = p_id))
  ) r
$$;

revoke all on function public.canonical_lifecycle_immutable(), public.canonical_lifecycle_check(), public.parks_retired_stay_inactive(), public.source_ref_single_holder() from public, anon, authenticated;
revoke all on function public.resolve_park_id(uuid) from public, anon, authenticated;
-- Same audience as get_park(): deep links (patika://park/:id) are opened by anon users too.
grant execute on function public.resolve_park_id(uuid) to anon, authenticated;
