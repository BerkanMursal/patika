create table public.veterinarians (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null default '',
  city text not null default '',
  district text not null default '',
  latitude double precision not null check(latitude between -90 and 90),
  longitude double precision not null check(longitude between -180 and 180),
  location extensions.geography(Point,4326) generated always as
    (extensions.st_setsrid(extensions.st_makepoint(longitude,latitude),4326)::extensions.geography) stored,
  phone text not null default '',
  is_partner boolean not null default true,
  discount_info text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index vets_location on public.veterinarians using gist(location);
create index vets_active on public.veterinarians(active) where active;

alter table public.veterinarians enable row level security;
create policy vets_read on public.veterinarians for select using(active);
revoke all on public.veterinarians from public,anon,authenticated;
grant select on public.veterinarians to anon,authenticated;

-- PL/pgSQL (not SQL): needs procedural `raise exception` for radius/coordinate
-- validation, matching the submit_feeding/submit_observation convention.
-- SECURITY INVOKER (not DEFINER): the table's own RLS+GRANT above already let
-- anon/authenticated read active rows directly, so no elevated privilege is
-- needed here — same reasoning as get_my_points.
create function public.get_vets(
  p_near_lat double precision default null,
  p_near_lng double precision default null,
  p_radius_m double precision default null
) returns setof public.veterinarians
language plpgsql stable security invoker set search_path='' as $$
begin
  if p_near_lat is not null and (p_near_lat<-90 or p_near_lat>90) then
    raise exception 'Geçersiz konum koordinatı.';
  end if;
  if p_near_lng is not null and (p_near_lng<-180 or p_near_lng>180) then
    raise exception 'Geçersiz konum koordinatı.';
  end if;
  if p_radius_m is not null and p_radius_m<=0 then
    raise exception 'Geçersiz yarıçap.';
  end if;
  return query
    select * from public.veterinarians v
    where v.active
      and (
        p_near_lat is null or p_near_lng is null or p_radius_m is null
        or extensions.st_dwithin(
             v.location,
             extensions.st_makepoint(p_near_lng,p_near_lat)::extensions.geography,
             least(p_radius_m,50000)
           )
      );
end;$$;
revoke all on function public.get_vets(double precision,double precision,double precision) from public,anon,authenticated;
grant execute on function public.get_vets(double precision,double precision,double precision) to anon,authenticated;
