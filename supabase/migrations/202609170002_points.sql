create table public.point_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  source_type text not null check(source_type in ('feeding','observation')),
  source_id uuid not null,
  points integer not null check(points>0),
  created_at timestamptz not null default now(),
  unique(source_type,source_id)
);
create index point_transactions_user on public.point_transactions(user_id);
alter table public.point_transactions enable row level security;
create policy point_transactions_self on public.point_transactions for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.point_transactions from public,anon,authenticated;
grant select on public.point_transactions to authenticated;

-- Same signature as after 202609170001; a plain replace keeps the existing
-- execute grant intact. Only the trailing point_transactions insert is new;
-- the location-verification logic above it is byte-for-byte unchanged.
create or replace function public.submit_feeding(p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); op uuid:=(p_payload->>'id')::uuid; point uuid:=(p_payload->>'point_id')::uuid; park uuid;
  photo text:=p_payload->>'photo_path'; event_time timestamptz:=(p_payload->>'occurred_at')::timestamptz;
  point_lat double precision; point_lon double precision;
  rep_lat double precision:=(p_payload->>'reported_latitude')::double precision;
  rep_lon double precision:=(p_payload->>'reported_longitude')::double precision;
begin
  if uid is null or uid is distinct from (p_payload->>'user_id')::uuid then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if exists(select 1 from public.feeding_events where id=op and user_id=uid) then return op;end if;
  if exists(select 1 from public.feeding_events where id=op) then raise exception 'İşlem kimliği kullanılamıyor.';end if;
  if (select count(*) from public.feeding_events where user_id=uid and received_at>now()-interval '24 hours')>=50 then raise exception 'Günlük paylaşım sınırına ulaşıldı.';end if;
  select fp.park_id,fp.latitude,fp.longitude into park,point_lat,point_lon from public.feeding_points fp join public.parks p on p.id=fp.park_id where fp.id=point and fp.active and p.active;
  if park is null or park is distinct from (p_payload->>'park_id')::uuid then raise exception 'Geçerli besleme noktası gerekli.';end if;
  if event_time is null or event_time>now()+interval '5 minutes' or event_time<now()-interval '90 days' then raise exception 'Geçersiz olay zamanı.';end if;
  if photo is null or photo<>uid::text||'/'||op::text||'.jpg' then raise exception 'Fotoğraf kayda ve kullanıcıya ait olmalı.';end if;
  if not exists(select 1 from storage.objects where bucket_id='feeding-photos' and name=photo and owner_id=uid::text) then raise exception 'Önce besleme fotoğrafını yükleyin.';end if;
  if rep_lat is null or rep_lon is null then raise exception 'Konum bilgisi gerekli.';end if;
  if rep_lat<-90 or rep_lat>90 or rep_lon<-180 or rep_lon>180 then raise exception 'Geçersiz konum koordinatı.';end if;
  if public.location_distance_meters(rep_lat,rep_lon,point_lat,point_lon)>200 then raise exception 'Konumunu kontrol edip tekrar dene.';end if;
  insert into public.feeding_events(id,user_id,point_id,park_id,food_type,food_grams,water_ml,note,photo_path,occurred_at,reported_latitude,reported_longitude)
  values(op,uid,point,park,p_payload->>'food_type',(p_payload->>'food_grams')::integer,(p_payload->>'water_ml')::integer,coalesce(p_payload->>'note',''),photo,event_time,rep_lat,rep_lon);
  insert into public.point_transactions(user_id,source_type,source_id,points) values(uid,'feeding',op,10);
  return op;
end;$$;

create or replace function public.submit_observation(p_point_id uuid,p_food text,p_water text,p_note text default '',p_latitude double precision default null,p_longitude double precision default null) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();result uuid;point_lat double precision;point_lon double precision;
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  select fp.latitude,fp.longitude into point_lat,point_lon from public.feeding_points fp join public.parks p on p.id=fp.park_id where fp.id=p_point_id and fp.active and p.active;
  if point_lat is null then raise exception 'Geçersiz nokta.';end if;
  if (select count(*) from public.observations where user_id=uid and observed_at>now()-interval '1 hour')>=20 then raise exception 'Gözlem sınırına ulaşıldı.';end if;
  if p_latitude is null or p_longitude is null then raise exception 'Konum bilgisi gerekli.';end if;
  if p_latitude<-90 or p_latitude>90 or p_longitude<-180 or p_longitude>180 then raise exception 'Geçersiz konum koordinatı.';end if;
  if public.location_distance_meters(p_latitude,p_longitude,point_lat,point_lon)>200 then raise exception 'Konumunu kontrol edip tekrar dene.';end if;
  insert into public.observations(user_id,point_id,food_status,water_status,note,reported_latitude,reported_longitude) values(uid,p_point_id,p_food,p_water,p_note,p_latitude,p_longitude) returning id into result;
  insert into public.point_transactions(user_id,source_type,source_id,points) values(uid,'observation',result,2);
  return result;
end;$$;
