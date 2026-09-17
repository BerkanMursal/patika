-- SECURITY INVOKER (not DEFINER): point_transactions_self RLS already scopes
-- rows to auth.uid(), so this needs no elevated privilege to compute the
-- caller's own total. No user_id parameter — always the caller's own sum.
create function public.get_my_points() returns integer language sql stable security invoker set search_path='' as $$
  select coalesce(sum(points),0)::integer from public.point_transactions where user_id=auth.uid()
$$;
revoke all on function public.get_my_points() from public,anon,authenticated;
grant execute on function public.get_my_points() to authenticated;
