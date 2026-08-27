import { AccountScreeningService, type ScreeningInput } from '@alpha-research/ai';
import { JobStore, type JobDatabase, type JobRecord } from '@alpha-research/db';
import { ensureTrenchMonitoring } from '../trench.js';

export interface ScreenAccountPayload { projectId: string; input: ScreeningInput; }

export function createScreenAccountHandler(database: JobDatabase, screening: AccountScreeningService) {
  return async (job: JobRecord): Promise<void> => {
    let rawPayload: unknown = job.payload;
    for (let attempt = 0; typeof rawPayload === 'string' && attempt < 2; attempt += 1) rawPayload = JSON.parse(rawPayload);
    const payload = rawPayload as ScreenAccountPayload;
    if (!payload?.projectId || !payload.input?.xUserId) throw new Error('Invalid screen_account payload');
    const result = await screening.classify(payload.input);
    await database.query(
      `insert into screening_decisions (project_id, decision, account_type, reason)
       values ($1, $2, $3, $4)`,
      [payload.projectId, result.decision === 'pending_review' ? 'failed' : result.decision, result.accountType, result.reason]
    );
    if (result.decision === 'allowed') {
      const project = await database.query<{ highest_star: number; x_user_id: string; status: string }>('select highest_star, x_user_id, status from projects where id = $1', [payload.projectId]);
      const row = project.rows[0];
      if (!row || row.status === 'excluded') return;
      const trench = Boolean(row && row.highest_star >= 3);
      const activated = await database.query<{ id: string }>(
        `update projects set status = $2, updated_at = now()
         where id = $1 and status <> 'excluded' returning id`,
        [payload.projectId, trench ? 'trench' : 'active']
      );
      if (!activated.rows[0]) return;
      if (trench && row) await ensureTrenchMonitoring(database, payload.projectId, row.x_user_id);
      await new JobStore(database).enqueue({ type: 'research_project', idempotencyKey: `research:${payload.projectId}`, payload: { projectId: payload.projectId }, priority: 30 });
    } else if (result.decision === 'blocked') {
      await database.query(
        `update projects set status = 'excluded', excluded_at = now(), exclusion_reason = $2, updated_at = now() where id = $1`,
        [payload.projectId, `AI 初筛自动拦截：${result.reason}`]
      );
    } else if (result.decision === 'pending_review') {
      await database.query(`update projects set status = 'pending_review', updated_at = now() where id = $1`, [payload.projectId]);
    }
  };
}
