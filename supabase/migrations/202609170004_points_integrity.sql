-- point_transactions stays an append-only audit log (T5) — never deleted here.
-- This view is the "active" (currently-countable) subset: observation
-- transactions always count (observations have no hide/delete mechanism),
-- feeding transactions only count while their source feeding_event is
-- still status='published' (not soft-deleted by remove_feeding, not
-- moderator-hidden by resolve_report). security_invoker=true means the
-- view carries no elevated privilege of its own — it runs as the querying
-- role, so point_transactions' existing RLS policy (owner-only) keeps
-- applying exactly as if the base table were queried directly.
create view public.point_transactions_active
with (security_invoker = true) as
select pt.* from public.point_transactions pt
where pt.source_type='observation'
   or (pt.source_type='feeding' and exists(
        select 1 from public.feeding_events fe
        where fe.id=pt.source_id and fe.status='published'
      ));
revoke all on public.point_transactions_active from public,anon,authenticated;
grant select on public.point_transactions_active to authenticated;

-- Same signature/SECURITY INVOKER as before; only the source relation changes.
create or replace function public.get_my_points() returns integer language sql stable security invoker set search_path='' as $$
  select coalesce(sum(points),0)::integer from public.point_transactions_active where user_id=auth.uid()
$$;

-- Supports the new (user_id,point_id,observed_at) cooldown check below;
-- the existing observations_point_time index has no user_id column, so a
-- per-(user,point) lookup would otherwise scan every observation at that point.
create index observations_user_point_time on public.observations(user_id,point_id,observed_at desc);

create or replace function public.submit_observation(p_point_id uuid,p_food text,p_water text,p_note text default '',p_latitude double precision default null,p_longitude double precision default null) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();result uuid;point_lat double precision;point_lon double precision;
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  select fp.latitude,fp.longitude into point_lat,point_lon from public.feeding_points fp join public.parks p on p.id=fp.park_id where fp.id=p_point_id and fp.active and p.active;
  if point_lat is null then raise exception 'Geçersiz nokta.';end if;
  if (select count(*) from public.observations where user_id=uid and observed_at>now()-interval '1 hour')>=20 then raise exception 'Gözlem sınırına ulaşıldı.';end if;
  if exists(select 1 from public.observations where user_id=uid and point_id=p_point_id and observed_at>now()-interval '30 minutes') then raise exception 'Bu noktayı yakın zamanda kontrol ettin. Biraz sonra tekrar dene.';end if;
  if p_latitude is null or p_longitude is null then raise exception 'Konum bilgisi gerekli.';end if;
  if p_latitude<-90 or p_latitude>90 or p_longitude<-180 or p_longitude>180 then raise exception 'Geçersiz konum koordinatı.';end if;
  if public.location_distance_meters(p_latitude,p_longitude,point_lat,point_lon)>200 then raise exception 'Konumunu kontrol edip tekrar dene.';end if;
  insert into public.observations(user_id,point_id,food_status,water_status,note,reported_latitude,reported_longitude) values(uid,p_point_id,p_food,p_water,p_note,p_latitude,p_longitude) returning id into result;
  insert into public.point_transactions(user_id,source_type,source_id,points) values(uid,'observation',result,2);
  return result;
end;$$;
