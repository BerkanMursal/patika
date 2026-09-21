create table public.park_source_refs (
  source_code text not null
    check (
      char_length(source_code) between 1 and 80
      and source_code = lower(source_code)
    ),

  external_id text not null
    check (char_length(external_id) between 1 and 200),

  park_id uuid not null
    references public.parks(id)
    on delete cascade,

  source_url text not null default '',

  metadata jsonb not null default '{}'::jsonb,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),

  primary key (source_code, external_id)
);

create index park_source_refs_park
  on public.park_source_refs(park_id);

alter table public.park_source_refs
  enable row level security;

revoke all
  on public.park_source_refs
  from public, anon, authenticated;

grant all
  on public.park_source_refs
  to service_role;

-- Existing real OSM-backed parks are represented in the new
-- provenance table without changing their canonical park IDs.
insert into public.park_source_refs (
  source_code,
  external_id,
  park_id,
  source_url
)
select
  'osm',
  p.osm_id,
  p.id,
  'https://www.openstreetmap.org/' || p.osm_id
from public.parks p
where p.osm_id is not null
on conflict (source_code, external_id)
do update set
  park_id = excluded.park_id,
  source_url = excluded.source_url,
  last_seen_at = now();
