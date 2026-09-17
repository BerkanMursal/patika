create extension if not exists postgis with schema extensions;
create extension if not exists unaccent with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check(char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);
create table public.parks (
  id uuid primary key default gen_random_uuid(), osm_id text unique,
  name text not null, city text not null default '', district text not null default '',
  latitude double precision not null check(latitude between 35 and 43),
  longitude double precision not null check(longitude between 25 and 45),
  location extensions.geography(Point,4326) generated always as
    (extensions.st_setsrid(extensions.st_makepoint(longitude,latitude),4326)::extensions.geography) stored,
  active boolean not null default true, source text not null default 'OpenStreetMap',
  imported_at timestamptz not null default now()
);
create index parks_location on public.parks using gist(location);
create index parks_bounds on public.parks(latitude,longitude) where active;
create table public.feeding_points (
  id uuid primary key default gen_random_uuid(), park_id uuid not null references public.parks on delete cascade,
  name text not null default 'Park içi genel nokta', latitude double precision not null, longitude double precision not null,
  active boolean not null default true, unique(park_id,name)
);
create table public.feeding_events (
  id uuid primary key, user_id uuid not null references auth.users on delete cascade,
  point_id uuid not null references public.feeding_points, park_id uuid not null references public.parks,
  food_type text not null check(food_type in ('dry','wet','other')),
  food_grams integer not null check(food_grams between 0 and 100000),
  water_ml integer not null check(water_ml between 0 and 100000),
  note text not null default '' check(char_length(note)<=500), photo_path text not null unique,
  occurred_at timestamptz not null, received_at timestamptz not null default now(),
  status text not null default 'published' check(status in ('published','hidden','deleted')),
  check(food_grams>0 or water_ml>0)
);
create index feeding_park_time on public.feeding_events(park_id,occurred_at desc,id desc) where status='published';
create index feeding_user_time on public.feeding_events(user_id,received_at desc);
create table public.observations (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade,
  point_id uuid not null references public.feeding_points,
  food_status text not null check(food_status in ('full','low','empty','unknown')),
  water_status text not null check(water_status in ('full','low','empty','unknown')),
  note text not null default '' check(char_length(note)<=500), observed_at timestamptz not null default now(),
  check(food_status<>'unknown' or water_status<>'unknown')
);
create index observations_point_time on public.observations(point_id,observed_at desc);
create table public.favorites(user_id uuid references auth.users on delete cascade,park_id uuid references public.parks on delete cascade,created_at timestamptz default now(),primary key(user_id,park_id));
create table public.blocked_users(user_id uuid references auth.users on delete cascade,blocked_id uuid references auth.users on delete cascade,primary key(user_id,blocked_id),check(user_id<>blocked_id));
create table public.reports (
  id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,
  feeding_id uuid references public.feeding_events on delete cascade,park_id uuid references public.parks on delete cascade,
  reason text not null check(char_length(reason) between 1 and 100),detail text not null check(char_length(detail) between 10 and 1000),
  status text not null default 'open' check(status in ('open','resolved')),created_at timestamptz not null default now(),
  resolved_at timestamptz, check(num_nonnulls(feeding_id,park_id)=1)
);

create function public.handle_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.profiles(id,display_name) values(new.id,left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'),''),'Hayvansever'),40))
  on conflict(id) do update set display_name=excluded.display_name;
  return new;
end;$$;
create trigger on_auth_user_created after insert or update of raw_user_meta_data on auth.users for each row execute function public.handle_profile();
create function public.is_moderator() returns boolean language sql stable set search_path='' as $$
  select coalesce(auth.jwt()->'app_metadata'->>'role'='moderator',false)
$$;

alter table public.profiles enable row level security;
alter table public.parks enable row level security;
alter table public.feeding_points enable row level security;
alter table public.feeding_events enable row level security;
alter table public.observations enable row level security;
alter table public.favorites enable row level security;
alter table public.blocked_users enable row level security;
alter table public.reports enable row level security;
create policy profiles_self on public.profiles for select to authenticated using(id=(select auth.uid()));
create policy parks_read on public.parks for select using(active);
create policy points_read on public.feeding_points for select using(active and exists(select 1 from public.parks p where p.id=park_id and p.active));
create policy events_read on public.feeding_events for select using(status='published' and exists(select 1 from public.parks p where p.id=park_id and p.active));
create policy observations_read on public.observations for select using(exists(select 1 from public.feeding_points p where p.id=point_id and p.active));
create policy favorites_self on public.favorites for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
create policy blocks_self on public.blocked_users for select to authenticated using(user_id=(select auth.uid()));
create policy reports_read on public.reports for select to authenticated using(user_id=(select auth.uid()) or public.is_moderator());
revoke all on all tables in schema public from anon,authenticated;
grant select on public.parks,public.feeding_points to anon,authenticated;
grant select on public.profiles,public.favorites,public.blocked_users,public.reports to authenticated;
grant insert,delete,update on public.favorites to authenticated;
grant all on all tables in schema public to service_role;

-- Internal view: never expose raw joins as a client-writable endpoint.
create view public.park_summaries as
select p.id,p.name,p.city,p.district,p.latitude,p.longitude,p.osm_id,
  f.occurred_at as last_fed_at,f.food_grams as last_grams,w.occurred_at as last_water_at,
  (select count(*)::integer from public.feeding_events e where e.park_id=p.id and e.status='published') as total_records,
  coalesce(o.food_status,'unknown') as food_status,coalesce(o.water_status,'unknown') as water_status,o.observed_at
from public.parks p
left join lateral(select occurred_at,food_grams from public.feeding_events where park_id=p.id and food_grams>0 and status='published' order by occurred_at desc,id desc limit 1) f on true
left join lateral(select occurred_at from public.feeding_events where park_id=p.id and water_ml>0 and status='published' order by occurred_at desc,id desc limit 1) w on true
left join lateral(select ob.food_status,ob.water_status,ob.observed_at from public.observations ob join public.feeding_points fp on fp.id=ob.point_id where fp.park_id=p.id order by ob.observed_at desc,ob.id desc limit 1) o on true
where p.active;
revoke all on public.park_summaries from public,anon,authenticated;
create function public.get_parks(p_south float8,p_north float8,p_west float8,p_east float8,p_query text default '')
returns setof public.park_summaries language sql stable security definer set search_path='' as $$
with candidates as materialized (
  select p.id,(p.latitude-(p_south+p_north)/2)^2+(p.longitude-(p_west+p_east)/2)^2 as distance
  from public.parks p where p.active and
  (case when length(trim(p_query))>=2 then extensions.unaccent(p.name||' '||p.city||' '||p.district) ilike '%'||extensions.unaccent(left(trim(p_query),100))||'%'
  else p.latitude between greatest(p_south,35) and least(p_north,43) and p.longitude between greatest(p_west,25) and least(p_east,45) end)
  order by distance,p.id limit 200
)
select s.* from candidates c join public.park_summaries s on s.id=c.id order by c.distance,c.id
$$;
create function public.get_park(p_id uuid) returns setof public.park_summaries language sql stable security definer set search_path='' as $$select * from public.park_summaries where id=p_id$$;
create function public.list_feedings(p_park_id uuid default null,p_mine boolean default false,p_before timestamptz default now()+interval '5 minutes',p_before_id uuid default 'ffffffff-ffff-ffff-ffff-ffffffffffff')
returns table(id uuid,park_id uuid,point_id uuid,user_id uuid,author_name text,park_name text,food_type text,food_grams integer,water_ml integer,occurred_at timestamptz,note text,photo_path text)
language sql stable security definer set search_path='' as $$
select e.id,e.park_id,e.point_id,e.user_id,coalesce(pr.display_name,'Hayvansever'),p.name,e.food_type,e.food_grams,e.water_ml,e.occurred_at,e.note,e.photo_path
from public.feeding_events e join public.parks p on p.id=e.park_id left join public.profiles pr on pr.id=e.user_id
where e.status='published' and p.active and (p_park_id is null or e.park_id=p_park_id)
and (not p_mine or e.user_id=auth.uid()) and (e.occurred_at,e.id)<(p_before,p_before_id)
and not exists(select 1 from public.blocked_users b where b.user_id=auth.uid() and b.blocked_id=e.user_id)
order by e.occurred_at desc,e.id desc limit 30
$$;

create function public.submit_feeding(p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); op uuid:=(p_payload->>'id')::uuid; point uuid:=(p_payload->>'point_id')::uuid; park uuid;
  photo text:=p_payload->>'photo_path'; event_time timestamptz:=(p_payload->>'occurred_at')::timestamptz;
begin
  if uid is null or uid is distinct from (p_payload->>'user_id')::uuid then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if exists(select 1 from public.feeding_events where id=op and user_id=uid) then return op;end if;
  if exists(select 1 from public.feeding_events where id=op) then raise exception 'İşlem kimliği kullanılamıyor.';end if;
  if (select count(*) from public.feeding_events where user_id=uid and received_at>now()-interval '24 hours')>=50 then raise exception 'Günlük paylaşım sınırına ulaşıldı.';end if;
  select fp.park_id into park from public.feeding_points fp join public.parks p on p.id=fp.park_id where fp.id=point and fp.active and p.active;
  if park is null or park is distinct from (p_payload->>'park_id')::uuid then raise exception 'Geçerli besleme noktası gerekli.';end if;
  if event_time is null or event_time>now()+interval '5 minutes' or event_time<now()-interval '90 days' then raise exception 'Geçersiz olay zamanı.';end if;
  if photo is null or photo<>uid::text||'/'||op::text||'.jpg' then raise exception 'Fotoğraf kayda ve kullanıcıya ait olmalı.';end if;
  if not exists(select 1 from storage.objects where bucket_id='feeding-photos' and name=photo and owner_id=uid::text) then raise exception 'Önce besleme fotoğrafını yükleyin.';end if;
  insert into public.feeding_events(id,user_id,point_id,park_id,food_type,food_grams,water_ml,note,photo_path,occurred_at)
  values(op,uid,point,park,p_payload->>'food_type',(p_payload->>'food_grams')::integer,(p_payload->>'water_ml')::integer,coalesce(p_payload->>'note',''),photo,event_time);
  return op;
end;$$;
create function public.submit_observation(p_point_id uuid,p_food text,p_water text,p_note text default '') returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();result uuid;
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if not exists(select 1 from public.feeding_points fp join public.parks p on p.id=fp.park_id where fp.id=p_point_id and fp.active and p.active) then raise exception 'Geçersiz nokta.';end if;
  if (select count(*) from public.observations where user_id=uid and observed_at>now()-interval '1 hour')>=20 then raise exception 'Gözlem sınırına ulaşıldı.';end if;
  insert into public.observations(user_id,point_id,food_status,water_status,note) values(uid,p_point_id,p_food,p_water,p_note) returning id into result;return result;
end;$$;
create function public.remove_feeding(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  update public.feeding_events set status='deleted' where id=p_id and user_id=auth.uid();
  if not found then raise exception 'Kayıt bulunamadı veya yetkiniz yok.' using errcode='42501';end if;
end;$$;
create function public.block_user(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  insert into public.blocked_users values(auth.uid(),p_id) on conflict do nothing;
end;$$;
create function public.report_item(p_reason text,p_detail text,p_park_id uuid default null,p_feeding_id uuid default null) returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  if (select count(*) from public.reports where user_id=auth.uid() and created_at>now()-interval '24 hours')>=20 then raise exception 'Günlük bildirim sınırına ulaşıldı.';end if;
  insert into public.reports(user_id,reason,detail,park_id,feeding_id) values(auth.uid(),p_reason,p_detail,p_park_id,p_feeding_id);
end;$$;
create function public.resolve_report(p_id uuid,p_hide boolean) returns void language plpgsql security definer set search_path='' as $$
declare r public.reports;
begin
  if not public.is_moderator() then raise exception 'Moderatör yetkisi gerekli.' using errcode='42501';end if;
  select * into r from public.reports where id=p_id for update;
  if not found then raise exception 'Bildirim bulunamadı.';end if;
  if p_hide then
    if r.feeding_id is not null then update public.feeding_events set status='hidden' where id=r.feeding_id;
    else update public.parks set active=false where id=r.park_id;end if;
  end if;
  update public.reports set status='resolved',resolved_at=now() where id=p_id;
end;$$;

create function public.get_report_context(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.reports; result jsonb;
begin
  if not public.is_moderator() then raise exception 'Moderatör yetkisi gerekli.' using errcode='42501';end if;
  select * into r from public.reports where id=p_id;
  if not found then raise exception 'Bildirim bulunamadı.';end if;
  select jsonb_build_object('park',jsonb_build_object('id',p.id,'name',p.name,'city',p.city,'latitude',p.latitude,'longitude',p.longitude),
    'feeding',case when e.id is null then null else to_jsonb(e)||jsonb_build_object('author_name',coalesce(pr.display_name,'Hayvansever'),'park_name',p.name) end)
  into result from public.parks p left join public.feeding_events e on e.id=r.feeding_id left join public.profiles pr on pr.id=e.user_id
  where p.id=coalesce(r.park_id,(select park_id from public.feeding_events where id=r.feeding_id));
  return result;
end;$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('feeding-photos','feeding-photos',false,5242880,array['image/jpeg']) on conflict(id) do nothing;
create policy photos_insert_own on storage.objects for insert to authenticated with check(bucket_id='feeding-photos' and (storage.foldername(name))[1]=(select auth.uid())::text and name ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.jpg$');
create policy photos_read on storage.objects for select to authenticated using(bucket_id='feeding-photos' and (public.is_moderator() or owner_id=(select auth.uid())::text or exists(select 1 from public.feeding_events e join public.parks p on p.id=e.park_id where e.photo_path=name and e.status='published' and p.active)));
create policy photos_remove_orphan on storage.objects for delete to authenticated using(bucket_id='feeding-photos' and owner_id=(select auth.uid())::text and not exists(select 1 from public.feeding_events e where e.photo_path=name and e.status='published'));
-- Policy evaluation needs narrowly scoped table read rights; RLS still filters rows.
grant select on public.feeding_events to authenticated;

do $$declare r record;begin
  for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('handle_profile','is_moderator','get_parks','get_park','list_feedings','submit_feeding','submit_observation','remove_feeding','block_user','report_item','resolve_report') loop
    execute format('revoke all on function %s from public,anon,authenticated',r.signature);
  end loop;
end;$$;
revoke all on function public.get_report_context(uuid) from public,anon,authenticated;
grant execute on function public.get_report_context(uuid) to authenticated;
grant execute on function public.get_parks(float8,float8,float8,float8,text),public.get_park(uuid),public.list_feedings(uuid,boolean,timestamptz,uuid) to anon,authenticated;
grant execute on function public.is_moderator(),public.submit_feeding(jsonb),public.submit_observation(uuid,text,text,text),public.remove_feeding(uuid),public.block_user(uuid),public.report_item(text,text,uuid,uuid),public.resolve_report(uuid,boolean) to authenticated;
