create table public.rescue_cases (
  id uuid primary key,
  reporter_user_id uuid not null references auth.users on delete cascade,
  latitude double precision not null check(latitude between -90 and 90),
  longitude double precision not null check(longitude between -180 and 180),
  location extensions.geography(Point,4326) generated always as
    (extensions.st_setsrid(extensions.st_makepoint(longitude,latitude),4326)::extensions.geography) stored,
  description text not null default '' check(char_length(description)<=500),
  animal_condition text not null check(char_length(animal_condition) between 1 and 200),
  photo_path text not null unique,
  -- T9 only ever writes 'reported'. Later states are reserved here so the
  -- column/constraint never needs to move when T10/T11 add their own RPCs;
  -- this migration adds no state-transition RPC.
  status text not null default 'reported'
    check(status in ('reported','verifying','claimed','en_route','at_vet','treating','resolved')),
  assigned_volunteer_id uuid references auth.users on delete set null,
  assigned_vet_id uuid references public.veterinarians on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rescue_cases_location on public.rescue_cases using gist(location);
create index rescue_cases_reporter_time on public.rescue_cases(reporter_user_id,created_at desc);

alter table public.rescue_cases enable row level security;
-- Authenticated-only read (tightened from the original "anon dahil herkese
-- açık" plan): rescue cases carry photo + free-form location, so anon gets
-- no visibility at all, matching the storage read policy below.
create policy rescue_cases_read on public.rescue_cases for select to authenticated using(true);
revoke all on public.rescue_cases from public,anon,authenticated;
grant select on public.rescue_cases to authenticated;

-- Same shape as submit_feeding: client-generated p_id makes retry (upload
-- succeeds, RPC call fails, user retries with the same id) a no-op instead
-- of a duplicate case. Salt 0 matches the shared per-user advisory-lock
-- namespace already used by submit_feeding/submit_observation/report_item.
create function public.report_rescue_case(
  p_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_description text,
  p_animal_condition text,
  p_photo_path text
) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  if exists(select 1 from public.rescue_cases where id=p_id and reporter_user_id=uid) then return p_id;end if;
  if exists(select 1 from public.rescue_cases where id=p_id) then raise exception 'İşlem kimliği kullanılamıyor.';end if;
  if (select count(*) from public.rescue_cases where reporter_user_id=uid and created_at>now()-interval '24 hours')>=10 then raise exception 'Günlük bildirim sınırına ulaşıldı.';end if;
  if p_latitude is null or p_longitude is null then raise exception 'Konum bilgisi gerekli.';end if;
  if p_latitude<-90 or p_latitude>90 or p_longitude<-180 or p_longitude>180 then raise exception 'Geçersiz konum koordinatı.';end if;
  if p_photo_path is null or p_photo_path<>uid::text||'/rescue-cases/'||p_id::text||'.jpg' then raise exception 'Fotoğraf kayda ve kullanıcıya ait olmalı.';end if;
  if not exists(select 1 from storage.objects where bucket_id='feeding-photos' and name=p_photo_path and owner_id=uid::text) then raise exception 'Önce bildirim fotoğrafını yükleyin.';end if;
  insert into public.rescue_cases(id,reporter_user_id,latitude,longitude,description,animal_condition,photo_path)
  values(p_id,uid,p_latitude,p_longitude,coalesce(p_description,''),p_animal_condition,p_photo_path);
  return p_id;
end;$$;
revoke all on function public.report_rescue_case(uuid,double precision,double precision,text,text,text) from public,anon,authenticated;
grant execute on function public.report_rescue_case(uuid,double precision,double precision,text,text,text) to authenticated;

-- Storage: new bucket is not opened (product decision) — rescue photos live
-- in the existing feeding-photos bucket under {uid}/rescue-cases/{id}.jpg.
-- That keeps foldername(name)[1]=uid, the same ownership segment the
-- existing feeding policies already check.

-- Separate INSERT policy (photos_insert_own's own regex is untouched —
-- Postgres OR's permissive policies together, so this only adds a second
-- accepted shape rather than editing the first).
create policy rescue_photos_insert_own on storage.objects for insert to authenticated
  with check(bucket_id='feeding-photos' and (storage.foldername(name))[1]=(select auth.uid())::text
    and name ~ '^[a-f0-9-]{36}/rescue-cases/[a-f0-9-]{36}\.jpg$');

-- Separate SELECT policy, scoped to authenticated only and to rows a
-- rescue_case actually references. photos_read is left exactly as-is, so
-- feeding-photo anon/authenticated behavior is unchanged; this policy can
-- only ever match rescue paths, since only rescue_cases.photo_path is
-- checked, so it never widens feeding-photo access either.
create policy rescue_photos_read on storage.objects for select to authenticated
  using(bucket_id='feeding-photos' and exists(select 1 from public.rescue_cases rc where rc.photo_path=name));

-- photos_remove_orphan must itself account for rescue_cases: it is a single
-- permissive DELETE policy, and permissive policies are OR'd, so a second
-- *additive* policy cannot narrow what the first one already allows. A
-- rescue photo has no matching feeding_events row, so the existing
-- "not exists ... feeding_events ... published" clause alone always passed
-- for it — the fix has to land inside this same policy's USING clause.
drop policy photos_remove_orphan on storage.objects;
create policy photos_remove_orphan on storage.objects for delete to authenticated
  using(bucket_id='feeding-photos' and owner_id=(select auth.uid())::text
    and not exists(select 1 from public.feeding_events e where e.photo_path=name and e.status='published')
    and not exists(select 1 from public.rescue_cases rc where rc.photo_path=name));
