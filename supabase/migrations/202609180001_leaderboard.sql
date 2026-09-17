-- Plain view (no security_invoker): same pattern as park_summaries. It runs
-- with the view owner's privileges, so it bypasses point_transactions_active's
-- and profiles' owner-scoped RLS and can aggregate points across all users.
-- Only reachable through get_leaderboard below — direct select is revoked,
-- so this bypass never leaks to a client query.
create view public.leaderboard_summary as
select pta.user_id,coalesce(pr.display_name,'Hayvansever') as display_name,sum(pta.points)::integer as total_points
from public.point_transactions_active pta
left join public.profiles pr on pr.id=pta.user_id
group by pta.user_id,pr.display_name;
revoke all on public.leaderboard_summary from public,anon,authenticated;

create function public.get_leaderboard(p_limit integer default 10) returns setof public.leaderboard_summary
language sql stable security definer set search_path='' as $$
  select * from public.leaderboard_summary
  order by total_points desc,user_id asc
  limit least(greatest(coalesce(p_limit,10),1),100)
$$;
revoke all on function public.get_leaderboard(integer) from public,anon,authenticated;
grant execute on function public.get_leaderboard(integer) to authenticated;
