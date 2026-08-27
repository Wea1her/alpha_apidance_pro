import type { JobDatabase } from '@alpha-research/db';

/** Persists the desired Alpha monitoring state for a project entering the trench. */
export async function ensureTrenchMonitoring(database: JobDatabase, projectId: string, alphaUserId: string): Promise<void> {
  await database.query(
    `insert into trench_memberships (project_id, state, entered_at, last_checked_at)
     values ($1, 'active', now(), now())
     on conflict (project_id) do update set state = 'active', dormant_at = null, last_checked_at = now()`,
    [projectId]
  );
  await database.query(
    `insert into alpha_monitors (project_id, alpha_user_id, tweet_enabled, ca_enabled, desired_state, actual_state)
     values ($1, $2, true, true, 'enabled', 'pending')
     on conflict (project_id) do update set
       alpha_user_id = excluded.alpha_user_id,
       tweet_enabled = true,
       ca_enabled = true,
       desired_state = 'enabled',
       actual_state = case when alpha_monitors.actual_state = 'enabled' then 'enabled' else 'pending' end`,
    [projectId, alphaUserId]
  );
}
