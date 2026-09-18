-- Account deletion must never delete or strand someone else's active rescue
-- case. reporter_user_id previously cascaded, so deleting the reporter's
-- account deleted the whole case out from under an assigned volunteer —
-- unlike every other user-owned row in this schema (feeding_events,
-- observations, favorites, ...), a rescue case is not purely the reporter's
-- own record once someone else has claimed it. This mirrors the existing
-- assigned_volunteer_id/park_name_suggestions.reviewed_by pattern: losing
-- the identity link on account deletion is fine, losing the row is not.
alter table public.rescue_cases alter column reporter_user_id drop not null;
alter table public.rescue_cases drop constraint rescue_cases_reporter_user_id_fkey;
alter table public.rescue_cases add constraint rescue_cases_reporter_user_id_fkey
  foreign key (reporter_user_id) references auth.users on delete set null;

-- claim_rescue_case now also has to close the other half of the same
-- problem: assigned_volunteer_id already used on delete set null, so a
-- volunteer deleting their account mid-response leaves the case exactly
-- where it was (status unchanged) but with no one assigned — and no
-- existing RPC could ever pick that back up, since the old WHERE only
-- matched status in ('reported','verifying'). This replacement recognizes
-- "assigned_volunteer_id is null AND status is one of the in-progress ones"
-- as an unambiguous orphan signal (that combination is otherwise
-- unreachable — only claim_rescue_case ever sets assigned_volunteer_id, and
-- nothing else ever clears it) and lets a new volunteer adopt the case
-- *at its current status* rather than resetting it to 'reported', which
-- would silently erase real progress (e.g. an animal already at a vet).
drop function if exists public.claim_rescue_case(uuid);
create function public.claim_rescue_case(p_case_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result_id uuid; existing public.rescue_cases;
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501'; end if;
  -- Single atomic conditional UPDATE, same as before: Postgres's row lock
  -- already makes this a safe compare-and-swap under concurrent callers, so
  -- no pg_advisory_xact_lock is needed. A case with a live (non-deleted)
  -- volunteer always has assigned_volunteer_id is not null, so it can never
  -- match this WHERE regardless of status — orphan adoption cannot steal an
  -- actively-assigned case.
  update public.rescue_cases
    set assigned_volunteer_id=uid,
        -- A genuinely new claim (reported/verifying) still becomes
        -- 'claimed', matching T10's original contract exactly. An orphan
        -- adoption of an already-progressed case keeps its status
        -- untouched — the new volunteer picks up exactly where the
        -- previous one left off; assigned_vet_id is never referenced here
        -- at all, so it survives automatically either way.
        status=case when status in ('reported','verifying') then 'claimed' else status end,
        updated_at=now()
    where id=p_case_id and assigned_volunteer_id is null
      and status in ('reported','verifying','claimed','en_route','at_vet','treating')
    returning id into result_id;
  if result_id is not null then return result_id; end if;
  -- 0 rows affected: case doesn't exist, this is a retry of a claim/adoption
  -- that already committed (network drop after success), or the case is
  -- genuinely unavailable (already has a live volunteer, or is 'resolved'
  -- and therefore never orphan-claimable no matter who its
  -- assigned_volunteer_id last was).
  select * into existing from public.rescue_cases where id=p_case_id;
  if not found then raise exception 'Vaka bulunamadı.'; end if;
  -- Retry-safety is scoped to the in-progress statuses on purpose: matching
  -- only on "assigned_volunteer_id=uid" would let this branch report
  -- success for a 'resolved' case simply because this same uid happened to
  -- be its volunteer before some other event (e.g. a later moderator
  -- action) — resolved must never look claimable or already-claimed-by-you
  -- again, it is a terminal state.
  if existing.assigned_volunteer_id=uid and existing.status in ('claimed','en_route','at_vet','treating')
    then return existing.id; end if;
  raise exception 'Bu vaka zaten üstlenilmiş veya bu aşamada üstlenilemez.';
end;$$;
revoke all on function public.claim_rescue_case(uuid) from public,anon,authenticated;
grant execute on function public.claim_rescue_case(uuid) to authenticated;
