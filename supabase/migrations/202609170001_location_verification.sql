alter table public.feeding_events
  add column reported_latitude double precision,
  add column reported_longitude double precision;
alter table public.observations
  add column reported_latitude double precision,
  add column reported_longitude double precision;

-- Great-circle distance in meters, using the spherical law of cosines
-- (küresel kosinüs teoremi) — not Haversine. This loses precision only at
-- sub-meter distances (acos'(x) is steep near x=1); negligible at our 200m
-- threshold. Deliberately avoids PostGIS: feeding_points and observations
-- only carry plain latitude/longitude (unlike parks.location), and this
-- runs identically in production and in the PostGIS-less PGlite tests.
create function public.location_distance_meters(p_lat1 double precision,p_lon1 double precision,p_lat2 double precision,p_lon2 double precision)
returns double precision language sql immutable set search_path='' as $$
select 6371000*acos(greatest(-1,least(1,
  sin(radians(p_lat1))*sin(radians(p_lat2))+cos(radians(p_lat1))*cos(radians(p_lat2))*cos(radians(p_lon2-p_lon1))
)))
$$;

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
  return op;
end;$$;

-- New trailing parameters change the function's argument-type signature, so a
-- true CREATE OR REPLACE would register a second overload instead of
-- replacing this one; drop the old signature first to keep a single function.
drop function if exists public.submit_observation(uuid,text,text,text);
create function public.submit_observation(p_point_id uuid,p_food text,p_water text,p_note text default '',p_latitude double precision default null,p_longitude double precision default null) returns uuid language plpgsql security definer set search_path='' as $$
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
  insert into public.observations(user_id,point_id,food_status,water_status,note,reported_latitude,reported_longitude) values(uid,p_point_id,p_food,p_water,p_note,p_latitude,p_longitude) returning id into result;return result;
end;$$;

revoke all on function public.location_distance_meters(double precision,double precision,double precision,double precision) from public,anon,authenticated;
grant execute on function public.location_distance_meters(double precision,double precision,double precision,double precision) to authenticated;
revoke all on function public.submit_observation(uuid,text,text,text,double precision,double precision) from public,anon,authenticated;
grant execute on function public.submit_observation(uuid,text,text,text,double precision,double precision) to authenticated;
