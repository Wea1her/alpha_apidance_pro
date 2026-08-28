alter table projects
  add column if not exists current_common_follow_count integer not null default 0
  check (current_common_follow_count >= 0);

update projects p
set current_common_follow_count = coalesce((
  select s.common_follow_count
  from signals s
  where s.project_id = p.id
    and s.type = 'common_follow'
    and s.common_follow_count is not null
  order by s.occurred_at desc, s.id desc
  limit 1
), p.highest_common_follow_count);
