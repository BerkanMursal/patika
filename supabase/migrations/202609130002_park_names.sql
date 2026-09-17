alter table public.parks
  add column name_status text not null default 'source' check(name_status in ('source','missing','municipal','community')),
  add column name_source text not null default 'OpenStreetMap',
  add column name_source_url text not null default '',
  add column address_label text not null default '';
update public.parks set name_status='missing' where name='İsimsiz park' or trim(name)='';

create table public.park_name_suggestions (
  id uuid primary key default gen_random_uuid(),
  park_id uuid not null references public.parks on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  original_name text not null,
  proposed_name text not null check(char_length(proposed_name) between 3 and 120),
  evidence text not null check(char_length(evidence) between 10 and 600),
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  review_note text not null default '',
  reviewed_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(), reviewed_at timestamptz
);
create unique index one_pending_park_name on public.park_name_suggestions(user_id,park_id) where status='pending';
create index park_name_review_queue on public.park_name_suggestions(status,created_at);
alter table public.park_name_suggestions enable row level security;
create policy park_name_suggestions_read on public.park_name_suggestions for select to authenticated using(user_id=(select auth.uid()) or public.is_moderator());
revoke all on public.park_name_suggestions from public,anon,authenticated;
grant select on public.park_name_suggestions to authenticated;
grant all on public.park_name_suggestions to service_role;

create function public.suggest_park_name(p_park_id uuid,p_name text,p_evidence text) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); current_name text; proposed text:=trim(regexp_replace(p_name,'\s+',' ','g')); evidence text:=trim(p_evidence); previous public.park_name_suggestions; result uuid;
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  if proposed is null or char_length(proposed) not between 3 and 120 or p_name ~ '[[:cntrl:]<>]' or proposed ~* 'https?://|www\.' or proposed !~ '[[:alpha:]]' or lower(extensions.unaccent(proposed)) in ('isimsiz park','park alani','park') then raise exception 'Geçerli bir park adı yazın.';end if;
  if evidence is null or char_length(evidence) not between 10 and 600 then raise exception 'Doğrulama açıklaması 10–600 karakter olmalı.';end if;
  perform pg_advisory_xact_lock(hashtextextended('park-name:'||uid::text,0));
  select name into current_name from public.parks where id=p_park_id and active;
  if not found then raise exception 'Park bulunamadı.';end if;
  if lower(proposed)=lower(current_name) then raise exception 'Önerilen ad mevcut adla aynı.';end if;
  select * into previous from public.park_name_suggestions where user_id=uid and park_id=p_park_id and status='pending';
  if found then
    if previous.proposed_name=proposed and previous.evidence=evidence then return previous.id;end if;
    raise exception 'Bu park için zaten inceleme bekleyen bir önerin var.';
  end if;
  if (select count(*) from public.park_name_suggestions where user_id=uid and created_at>now()-interval '24 hours')>=20 then raise exception 'Günlük öneri sınırına ulaşıldı.';end if;
  insert into public.park_name_suggestions(park_id,user_id,original_name,proposed_name,evidence) values(p_park_id,uid,current_name,proposed,evidence) returning id into result;
  return result;
end;$$;

create function public.review_park_name(p_id uuid,p_accept boolean,p_note text) returns void language plpgsql security definer set search_path='' as $$
declare suggestion public.park_name_suggestions; current_name text; target uuid;
begin
  if auth.uid() is null or not public.is_moderator() then raise exception 'Moderatör yetkisi gerekli.' using errcode='42501';end if;
  if p_accept is null or p_note is null or char_length(trim(p_note)) not between 10 and 600 then raise exception 'Karar ve 10–600 karakterlik inceleme notu gerekli.';end if;
  select park_id into target from public.park_name_suggestions where id=p_id;
  if target is null then raise exception 'Öneri bulunamadı.';end if;
  -- Always lock the park first so competing approvals serialize consistently.
  select name into current_name from public.parks where id=target and active for update;
  if not found then raise exception 'Park bulunamadı.';end if;
  select * into suggestion from public.park_name_suggestions where id=p_id for update;
  if suggestion.status<>'pending' then raise exception 'Öneri zaten incelenmiş.';end if;
  if suggestion.user_id=auth.uid() then raise exception 'Kendi önerinizi onaylayamaz veya reddedemezsiniz.' using errcode='42501';end if;
  if p_accept and current_name is distinct from suggestion.original_name then raise exception 'Park adı değişti; güncel bilgiyle yeni öneri alın.';end if;
  if p_accept then
    update public.parks set name=suggestion.proposed_name,name_status='community',name_source='Topluluk incelemesi',name_source_url='' where id=target;
  end if;
  update public.park_name_suggestions set status=case when p_accept then 'approved' else 'rejected' end,review_note=trim(p_note),reviewed_by=auth.uid(),reviewed_at=now() where id=p_id;
end;$$;

create function public.list_park_name_suggestions(p_park_id uuid default null)
returns table(id uuid,park_id uuid,user_id uuid,original_name text,proposed_name text,evidence text,status text,review_note text,created_at timestamptz,reviewed_at timestamptz,park_name text,city text,district text,latitude float8,longitude float8)
language sql stable security definer set search_path='' as $$
 select s.id,s.park_id,s.user_id,s.original_name,s.proposed_name,s.evidence,s.status,s.review_note,s.created_at,s.reviewed_at,p.name,p.city,p.district,p.latitude,p.longitude
 from public.park_name_suggestions s join public.parks p on p.id=s.park_id
 where p.active and (s.user_id=auth.uid() or public.is_moderator()) and (p_park_id is null or s.park_id=p_park_id)
 order by (s.status='pending') desc,s.created_at desc,s.id desc limit 100
$$;

-- Source imports cannot silently undo a reviewed community correction.
create function public.preserve_reviewed_park_name() returns trigger language plpgsql set search_path='' as $$
begin
  if old.name_status='community' and new.name_status<>'community' then
    new.name:=old.name;new.name_status:=old.name_status;new.name_source:=old.name_source;new.name_source_url:=old.name_source_url;
  end if;
  return new;
end;$$;
create trigger preserve_reviewed_park_name before update on public.parks for each row execute function public.preserve_reviewed_park_name();

create or replace view public.park_summaries as
select p.id,p.name,p.city,p.district,p.latitude,p.longitude,p.osm_id,
  f.occurred_at as last_fed_at,f.food_grams as last_grams,w.occurred_at as last_water_at,
  (select count(*)::integer from public.feeding_events e where e.park_id=p.id and e.status='published') as total_records,
  coalesce(o.food_status,'unknown') as food_status,coalesce(o.water_status,'unknown') as water_status,o.observed_at,
  p.name_status,p.name_source,p.name_source_url,p.address_label
from public.parks p
left join lateral(select occurred_at,food_grams from public.feeding_events where park_id=p.id and food_grams>0 and status='published' order by occurred_at desc,id desc limit 1) f on true
left join lateral(select occurred_at from public.feeding_events where park_id=p.id and water_ml>0 and status='published' order by occurred_at desc,id desc limit 1) w on true
left join lateral(select ob.food_status,ob.water_status,ob.observed_at from public.observations ob join public.feeding_points fp on fp.id=ob.point_id where fp.park_id=p.id order by ob.observed_at desc,ob.id desc limit 1) o on true
where p.active;
revoke all on public.park_summaries from public,anon,authenticated;
create or replace function public.get_parks(p_south float8,p_north float8,p_west float8,p_east float8,p_query text default '')
returns setof public.park_summaries language sql stable security definer set search_path='' as $$
with candidates as materialized (
 select p.id,(p.latitude-(p_south+p_north)/2)^2+(p.longitude-(p_west+p_east)/2)^2 as distance
 from public.parks p where p.active and
 (case when length(trim(p_query))>=2 then extensions.unaccent((case when p.name_status='missing' then 'Park alanı · '||left(replace(p.id::text,'-',''),10) else p.name end)||' '||p.city||' '||p.district||' '||p.address_label) ilike '%'||extensions.unaccent(left(trim(p_query),100))||'%'
 else p.latitude between greatest(p_south,35) and least(p_north,43) and p.longitude between greatest(p_west,25) and least(p_east,45) end)
 order by distance,p.id limit 200
) select s.* from candidates c join public.park_summaries s on s.id=c.id order by c.distance,c.id
$$;
revoke all on function public.suggest_park_name(uuid,text,text),public.review_park_name(uuid,boolean,text),public.list_park_name_suggestions(uuid),public.preserve_reviewed_park_name() from public,anon,authenticated;
grant execute on function public.suggest_park_name(uuid,text,text),public.review_park_name(uuid,boolean,text),public.list_park_name_suggestions(uuid) to authenticated;
