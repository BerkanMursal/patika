-- Single atomic conditional UPDATE, not a SELECT-then-UPDATE: Postgres takes a
-- row lock on the targeted rescue_cases row during the UPDATE, so a
-- concurrent second claim blocks until the first commits, then re-evaluates
-- this WHERE clause against the now-'claimed' row and matches zero rows. No
-- pg_advisory_xact_lock is needed — unlike submit_feeding's count-then-insert
-- rate limit, this is a single-row compare-and-swap that Postgres's own
-- row-level locking already makes atomic.
create function public.claim_rescue_case(p_case_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result_id uuid; existing public.rescue_cases;
begin
  if uid is null then raise exception 'Oturum gerekli.' using errcode='42501'; end if;
  update public.rescue_cases
    set assigned_volunteer_id=uid, status='claimed', updated_at=now()
    where id=p_case_id and status in ('reported','verifying') and assigned_volunteer_id is null
    returning id into result_id;
  if result_id is not null then return result_id; end if;
  -- 0 rows affected: either the case doesn't exist, this same call is a
  -- retry of a claim that already succeeded (network drop after commit —
  -- covers the concurrent-same-user case too, since by the time this SELECT
  -- runs any earlier UPDATE from the same user has already committed), or
  -- someone else got there first.
  select * into existing from public.rescue_cases where id=p_case_id;
  if not found then raise exception 'Vaka bulunamadı.'; end if;
  if existing.status='claimed' and existing.assigned_volunteer_id=uid then return existing.id; end if;
  raise exception 'Bu vaka zaten üstlenilmiş veya bu aşamada üstlenilemez.';
end;$$;
revoke all on function public.claim_rescue_case(uuid) from public,anon,authenticated;
grant execute on function public.claim_rescue_case(uuid) to authenticated;
