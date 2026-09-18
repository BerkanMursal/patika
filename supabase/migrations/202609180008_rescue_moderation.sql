-- Moderation visibility is deliberately kept separate from rescue_cases.status:
-- a moderator hiding a case (fake report, abusive photo, spam) must never
-- collide with or overwrite the reported/claimed/en_route/at_vet/treating/
-- resolved state machine T9-T11 already own. hidden_by is nullable, ON DELETE
-- SET NULL — same pattern as assigned_volunteer_id/reviewed_by elsewhere in
-- this schema: losing the identity link on account deletion is fine, losing
-- the moderation decision (hidden_at) is not. No hard delete, ever.
alter table public.rescue_cases add column hidden_at timestamptz;
alter table public.rescue_cases add column hidden_by uuid references auth.users on delete set null;

-- Authenticated read narrows to visible cases only. A hidden case becomes
-- invisible to direct SELECT, getRescueCase() and the map query alike — the
-- moderator's own path into a hidden case's detail is get_report_context()
-- (extended below), not a widened version of this policy.
drop policy rescue_cases_read on public.rescue_cases;
create policy rescue_cases_read on public.rescue_cases for select to authenticated using(hidden_at is null);

-- reports gains a third optional target alongside feeding_id/park_id. RESTRICT
-- (not SET NULL/CASCADE): a rescue case is never hard-deleted — moderation
-- only ever hides it in place — so a report pointing at a gone case should
-- never happen; RESTRICT turns that into a schema-level guarantee instead of
-- something only application code enforces.
alter table public.reports add column rescue_case_id uuid references public.rescue_cases on delete restrict;
alter table public.reports drop constraint reports_check;
alter table public.reports add constraint reports_check check(num_nonnulls(feeding_id,park_id,rescue_case_id)=1);

-- Reporter identity is not load-bearing for a resolved moderation record —
-- same reasoning as rescue_cases.reporter_user_id (the account-deletion
-- integrity migration above): the report and its resolution must outlive the
-- reporter's own account.
alter table public.reports alter column user_id drop not null;
alter table public.reports drop constraint reports_user_id_fkey;
alter table public.reports add constraint reports_user_id_fkey foreign key (user_id) references auth.users on delete set null;

-- What a moderator actually decided, alongside the existing resolved_at.
-- Shared across every report type (not rescue-only) since resolve_report is
-- one function for all of them; every pre-existing resolved report simply has
-- both left null, same as any other retroactively-added optional column.
alter table public.reports add column resolution_action text check(resolution_action in ('hide','dismiss'));
alter table public.reports add column resolved_by uuid references auth.users on delete set null;

-- Duplicate-open-report guard, rescue only: a partial unique index (not a
-- table-wide UNIQUE) so it only ever constrains rescue reports, and only
-- while status='open' — once a report is resolved (hidden or dismissed) the
-- same user can report the same case again later if a new issue comes up.
-- report_item's own duplicate check (below) is what normally prevents this
-- from ever being hit; this index is the last-resort integrity backstop.
create unique index reports_rescue_open_unique on public.reports(user_id,rescue_case_id)
  where rescue_case_id is not null and status='open';

-- New trailing parameter changes the function's argument-type signature, so a
-- plain CREATE OR REPLACE would register a second overload instead of
-- replacing the old version — same reasoning as T11/T14's
-- update_rescue_case_status migrations. Drop the old 4-arg signature first to
-- keep a single function.
drop function if exists public.report_item(text,text,uuid,uuid);
create function public.report_item(p_reason text,p_detail text,p_park_id uuid default null,p_feeding_id uuid default null,p_rescue_case_id uuid default null) returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Oturum gerekli.' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  -- Duplicate-open-report guard, rescue only, checked before the daily rate
  -- limit so a retry/duplicate never consumes budget from the real 20/day
  -- cap. Silent no-op (not an error) — the same idempotent-retry shape
  -- report_rescue_case already uses for its own client-side retries.
  if p_rescue_case_id is not null and exists(select 1 from public.reports where user_id=auth.uid() and rescue_case_id=p_rescue_case_id and status='open') then return;end if;
  if (select count(*) from public.reports where user_id=auth.uid() and created_at>now()-interval '24 hours')>=20 then raise exception 'Günlük bildirim sınırına ulaşıldı.';end if;
  if num_nonnulls(p_park_id,p_feeding_id,p_rescue_case_id)<>1 then raise exception 'Tam olarak bir hedef seçilmeli.';end if;
  if p_rescue_case_id is not null and not exists(select 1 from public.rescue_cases where id=p_rescue_case_id and hidden_at is null) then raise exception 'Vaka bulunamadı.';end if;
  insert into public.reports(user_id,reason,detail,park_id,feeding_id,rescue_case_id) values(auth.uid(),p_reason,p_detail,p_park_id,p_feeding_id,p_rescue_case_id);
end;$$;
revoke all on function public.report_item(text,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.report_item(text,text,uuid,uuid,uuid) to authenticated;

-- resolve_report's own signature is unchanged (p_id,p_hide), so CREATE OR
-- REPLACE keeps the existing object identity and its grants — no drop, no
-- re-grant needed. It now also handles a rescue_case_id target and writes
-- the shared audit trail (resolution_action/resolved_by) for every report
-- type. Idempotent on the report row itself: a retried call on an
-- already-resolved report changes nothing at all, so the first decision's
-- timestamp (and whatever it already wrote to feeding_events/parks/
-- rescue_cases) is never touched again. For rescue specifically,
-- hidden_at/hidden_by are additionally first-write-wins at the case level: a
-- second, still-open report resolving hide=true on a case another moderator
-- already hid gets its own resolution recorded normally, but never
-- reassigns hidden_by or resets hidden_at.
create or replace function public.resolve_report(p_id uuid,p_hide boolean) returns void language plpgsql security definer set search_path='' as $$
declare r public.reports; uid uuid:=auth.uid();
begin
  if not public.is_moderator() then raise exception 'Moderatör yetkisi gerekli.' using errcode='42501';end if;
  select * into r from public.reports where id=p_id for update;
  if not found then raise exception 'Bildirim bulunamadı.';end if;
  if r.status='resolved' then return;end if;
  if p_hide then
    if r.feeding_id is not null then update public.feeding_events set status='hidden' where id=r.feeding_id;
    elsif r.park_id is not null then update public.parks set active=false where id=r.park_id;
    else
      -- Operational status/assignments are moderation-orthogonal and never
      -- touched here — only hidden_at/hidden_by, and only if unset.
      update public.rescue_cases set hidden_at=now(),hidden_by=uid where id=r.rescue_case_id and hidden_at is null;
    end if;
  end if;
  update public.reports set status='resolved',resolved_at=now(),resolved_by=uid,
    resolution_action=case when p_hide then 'hide' else 'dismiss' end where id=p_id;
end;$$;

-- get_report_context gains a rescue branch, entirely separate from the
-- existing park/feeding query below it (untouched). This is the moderator's
-- sanctioned path to a hidden case's detail — security definer plus its own
-- is_moderator() gate above, not a widened rescue_cases RLS policy.
create or replace function public.get_report_context(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.reports; result jsonb;
begin
  if not public.is_moderator() then raise exception 'Moderatör yetkisi gerekli.' using errcode='42501';end if;
  select * into r from public.reports where id=p_id;
  if not found then raise exception 'Bildirim bulunamadı.';end if;
  if r.rescue_case_id is not null then
    select jsonb_build_object('rescue',jsonb_build_object(
      'id',rc.id,'description',rc.description,'animal_condition',rc.animal_condition,
      'status',rc.status,'photo_path',rc.photo_path,'latitude',rc.latitude,'longitude',rc.longitude,
      'hidden_at',rc.hidden_at))
    into result from public.rescue_cases rc where rc.id=r.rescue_case_id;
    return result;
  end if;
  select jsonb_build_object('park',jsonb_build_object('id',p.id,'name',p.name,'city',p.city,'latitude',p.latitude,'longitude',p.longitude),
    'feeding',case when e.id is null then null else to_jsonb(e)||jsonb_build_object('author_name',coalesce(pr.display_name,'Hayvansever'),'park_name',p.name) end)
  into result from public.parks p left join public.feeding_events e on e.id=r.feeding_id left join public.profiles pr on pr.id=e.user_id
  where p.id=coalesce(r.park_id,(select park_id from public.feeding_events where id=r.feeding_id));
  return result;
end;$$;

-- claim_rescue_case and update_rescue_case_status keep their exact existing
-- signatures, so CREATE OR REPLACE preserves their grants — no drop needed.
-- Both gain an explicit hidden_at IS NULL guard in the real conditional
-- UPDATE's WHERE clause AND in the retry/idempotency success-fallback branch:
-- a hidden case must never be claimed, orphan-reclaimed, advanced or
-- vet-assigned — not via a fresh transition, and not via a retry that would
-- otherwise report an already-committed success. Moderation state
-- (hidden_at/hidden_by) is untouched by either function; a hide freezes the
-- state machine, it never rewinds or resets it.
create or replace function public.claim_rescue_case(p_case_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result_id uuid; existing public.rescue_cases;
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501'; end if;
  update public.rescue_cases
    set assigned_volunteer_id=uid,
        status=case when status in ('reported','verifying') then 'claimed' else status end,
        updated_at=now()
    where id=p_case_id and assigned_volunteer_id is null and hidden_at is null
      and status in ('reported','verifying','claimed','en_route','at_vet','treating')
    returning id into result_id;
  if result_id is not null then return result_id; end if;
  select * into existing from public.rescue_cases where id=p_case_id;
  if not found then raise exception 'Vaka bulunamadı.'; end if;
  if existing.hidden_at is null and existing.assigned_volunteer_id=uid and existing.status in ('claimed','en_route','at_vet','treating')
    then return existing.id; end if;
  raise exception 'Bu vaka zaten üstlenilmiş veya bu aşamada üstlenilemez.';
end;$$;

create or replace function public.update_rescue_case_status(p_case_id uuid, p_new_status text, p_vet_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result_id uuid; existing public.rescue_cases; expected text;
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501'; end if;
  expected := case p_new_status
    when 'en_route' then 'claimed'
    when 'at_vet' then 'en_route'
    when 'treating' then 'at_vet'
    when 'resolved' then 'treating'
  end;
  if expected is null then raise exception 'Geçersiz hedef durum.'; end if;
  if p_vet_id is not null and p_new_status<>'at_vet' then
    raise exception 'Veteriner yalnızca "Veterinere Ulaştırıldı" durumuna geçişte atanabilir.';
  end if;
  update public.rescue_cases
    set status=p_new_status, updated_at=now()
    where id=p_case_id and status=expected and hidden_at is null and (assigned_volunteer_id=uid or public.is_moderator())
    returning id into result_id;
  if result_id is not null then
    if p_new_status='at_vet' and p_vet_id is not null then
      if not exists(select 1 from public.veterinarians where id=p_vet_id and active) then
        raise exception 'Geçersiz veteriner.';
      end if;
      update public.rescue_cases set assigned_vet_id=p_vet_id where id=p_case_id;
    end if;
    return result_id;
  end if;
  select * into existing from public.rescue_cases where id=p_case_id;
  if not found then raise exception 'Vaka bulunamadı.'; end if;
  if existing.hidden_at is null and existing.status=p_new_status and (existing.assigned_volunteer_id=uid or public.is_moderator())
    then return existing.id; end if;
  raise exception 'Bu geçiş şu anda yapılamaz.';
end;$$;

-- Storage: photos_read's owner branch used to match ANY object the caller
-- owns, with no path-shape check at all — harmless while only feeding photos
-- existed, but a real bypass now: a rescue photo under {uid}/rescue-cases/
-- {id}.jpg is also owned by its uploader, so that branch alone already let a
-- case's own reporter (or a volunteer who uploaded under their own uid —
-- moot today since only report_rescue_case ever writes rescue photos, but
-- the policy must not depend on that) read it regardless of hidden_at. Path
-- narrowing the owner branch to the feeding shape closes this without
-- touching the moderator or published-feeding branches at all.
drop policy photos_read on storage.objects;
create policy photos_read on storage.objects for select to authenticated using(bucket_id='feeding-photos' and (
  public.is_moderator()
  or (owner_id=(select auth.uid())::text and name ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.jpg$')
  or exists(select 1 from public.feeding_events e join public.parks p on p.id=e.park_id where e.photo_path=name and e.status='published' and p.active)
));

-- rescue_photos_read's plain EXISTS(...) used to implicitly ride on
-- rescue_cases_read's own RLS (permissive because that policy was
-- using(true)) — now that rescue_cases_read requires hidden_at IS NULL, the
-- same EXISTS would also block a moderator, since a SECURITY INVOKER policy's
-- subquery is itself subject to rescue_cases' RLS for a non-owner role. This
-- narrow SECURITY DEFINER helper is the moderator's own path in (bypassing
-- that RLS deliberately, gated by its own is_moderator() check) without
-- opening a general bypass policy on rescue_cases itself.
create function public.rescue_photo_visible(p_path text) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.rescue_cases rc where rc.photo_path=p_path and (rc.hidden_at is null or public.is_moderator()))
$$;
revoke all on function public.rescue_photo_visible(text) from public,anon,authenticated;
grant execute on function public.rescue_photo_visible(text) to authenticated;
drop policy rescue_photos_read on storage.objects;
create policy rescue_photos_read on storage.objects for select to authenticated
  using(bucket_id='feeding-photos' and public.rescue_photo_visible(name));

-- photos_remove_orphan's rescue EXISTS(...) has the identical RLS-visibility
-- problem as rescue_photos_read above: with rescue_cases_read now requiring
-- hidden_at IS NULL, a hidden case becomes invisible to its own owner's plain
-- EXISTS check too, so the photo would look unreferenced and get deleted as
-- a false "orphan" — silently destroying evidence for a case still under
-- moderation. own_photo_referenced is intentionally narrow: it only ever
-- answers for a path under the caller's own uid segment (never a general
-- hidden-case existence oracle for arbitrary paths/other users), and it
-- counts a hidden rescue_cases reference as real.
create function public.own_photo_referenced(p_path text) returns boolean language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
  if uid is null or (storage.foldername(p_path))[1]<>uid::text then return false; end if;
  return exists(select 1 from public.feeding_events e where e.photo_path=p_path and e.status='published')
      or exists(select 1 from public.rescue_cases rc where rc.photo_path=p_path);
end;$$;
revoke all on function public.own_photo_referenced(text) from public,anon,authenticated;
grant execute on function public.own_photo_referenced(text) to authenticated;
drop policy photos_remove_orphan on storage.objects;
create policy photos_remove_orphan on storage.objects for delete to authenticated
  using(bucket_id='feeding-photos' and owner_id=(select auth.uid())::text and not public.own_photo_referenced(name));
