-- New trailing parameter changes the function's argument-type signature, so a
-- plain CREATE OR REPLACE would register a second overload instead of
-- replacing the T11 version — same reasoning as T3's submit_observation
-- migration. Drop the old 2-arg signature first to keep a single function.
drop function if exists public.update_rescue_case_status(uuid,text);

-- Same atomic-conditional-UPDATE shape as T10/T11: no pg_advisory_xact_lock,
-- because this remains a single-row compare-and-swap that Postgres's own row
-- lock already makes safe under concurrent callers. p_vet_id only ever
-- participates in the real (non-retry) en_route->at_vet write; every other
-- transition leaves assigned_vet_id completely untouched.
create function public.update_rescue_case_status(p_case_id uuid, p_new_status text, p_vet_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result_id uuid; existing public.rescue_cases; expected text;
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501'; end if;
  -- The only defined forward steps. 'claimed' is claim_rescue_case's own
  -- target, never accepted here; anything else (including 'reported',
  -- 'verifying' or arbitrary text) has no expected predecessor and is
  -- rejected up front with a precise message.
  expected := case p_new_status
    when 'en_route' then 'claimed'
    when 'at_vet' then 'en_route'
    when 'treating' then 'at_vet'
    when 'resolved' then 'treating'
  end;
  if expected is null then raise exception 'Geçersiz hedef durum.'; end if;
  -- Pure request-shape validation, independent of case/row state: a vet_id
  -- for any target other than 'at_vet' is always a caller mistake, retry or
  -- not (a retry of the at_vet transition still carries p_new_status='at_vet',
  -- so this never fires for a legitimate retry).
  if p_vet_id is not null and p_new_status<>'at_vet' then
    raise exception 'Veteriner yalnızca "Veterinere Ulaştırıldı" durumuna geçişte atanabilir.';
  end if;
  update public.rescue_cases
    set status=p_new_status, updated_at=now()
    where id=p_case_id and status=expected and (assigned_volunteer_id=uid or public.is_moderator())
    returning id into result_id;
  if result_id is not null then
    -- Only a genuine, freshly-committed en_route->at_vet transition ever
    -- reaches here — a retry 0-matches the WHERE above once status is
    -- already 'at_vet', so it never re-enters this branch. That is what
    -- keeps a retry safe even if it carries a different/invalid p_vet_id:
    -- validation and the write both live inside this "real transition only"
    -- branch, and raising here rolls back the status UPDATE above too
    -- (same function call, same transaction), so an invalid vet never
    -- leaves the case half-transitioned.
    if p_new_status='at_vet' and p_vet_id is not null then
      if not exists(select 1 from public.veterinarians where id=p_vet_id and active) then
        raise exception 'Geçersiz veteriner.';
      end if;
      update public.rescue_cases set assigned_vet_id=p_vet_id where id=p_case_id;
    end if;
    return result_id;
  end if;
  -- 0 rows affected: case doesn't exist, this is a retry of a transition
  -- that already committed (network drop after success — updated_at must
  -- NOT be bumped again, and assigned_vet_id must NOT be touched at all,
  -- regardless of what p_vet_id this retry carries), or the transition is
  -- genuinely invalid (skip, backwards, unauthorized, or the case is past
  -- this state already, e.g. terminal 'resolved').
  select * into existing from public.rescue_cases where id=p_case_id;
  if not found then raise exception 'Vaka bulunamadı.'; end if;
  if existing.status=p_new_status and (existing.assigned_volunteer_id=uid or public.is_moderator())
    then return existing.id; end if;
  raise exception 'Bu geçiş şu anda yapılamaz.';
end;$$;
revoke all on function public.update_rescue_case_status(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.update_rescue_case_status(uuid,text,uuid) to authenticated;
