-- Same atomic-conditional-UPDATE shape as claim_rescue_case: no
-- pg_advisory_xact_lock, because this is a single-row compare-and-swap that
-- Postgres's own row lock already makes safe under concurrent callers.
create function public.update_rescue_case_status(p_case_id uuid, p_new_status text) returns uuid
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
  update public.rescue_cases
    set status=p_new_status, updated_at=now()
    where id=p_case_id and status=expected and (assigned_volunteer_id=uid or public.is_moderator())
    returning id into result_id;
  if result_id is not null then return result_id; end if;
  -- 0 rows affected: case doesn't exist, this is a retry of a transition
  -- that already committed (network drop after success — updated_at must
  -- NOT be bumped again for this branch, so no UPDATE runs here), or the
  -- transition is genuinely invalid (skip, backwards, unauthorized, or the
  -- case is past this state already, e.g. terminal 'resolved').
  select * into existing from public.rescue_cases where id=p_case_id;
  if not found then raise exception 'Vaka bulunamadı.'; end if;
  if existing.status=p_new_status and (existing.assigned_volunteer_id=uid or public.is_moderator())
    then return existing.id; end if;
  raise exception 'Bu geçiş şu anda yapılamaz.';
end;$$;
revoke all on function public.update_rescue_case_status(uuid,text) from public,anon,authenticated;
grant execute on function public.update_rescue_case_status(uuid,text) to authenticated;
