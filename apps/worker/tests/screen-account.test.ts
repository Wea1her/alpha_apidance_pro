import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountScreeningService, AiProviderRouter } from '@alpha-research/ai';
import { migrateDatabase } from '@alpha-research/db';
import type { AiProviderAdapter } from '@alpha-research/ai';
import { createScreenAccountHandler } from '../src/handlers/screen-account.js';

function adapter(text: string): AiProviderAdapter {
  return { profile: { id: 'p', name: 'screening', baseUrl: 'https://ai.test', screeningModel: 'screen-v1', researchModel: 'research-v1', capabilities: ['chat', 'structured_output'], role: 'main', enabled: true, health: 'healthy' }, complete: async () => ({ text, model: 'screen-v1' }), healthCheck: async () => 'healthy' };
}

describe('screen-account handler', () => {
  const databases: PGlite[] = [];
  afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

  it('persists an allowed decision and schedules research', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle) values ('42', 'alpha') returning id`);
    const handler = createScreenAccountHandler(database, new AccountScreeningService(new AiProviderRouter([adapter('{"accountType":"PROJECT","reason":"项目账号"}')] )));
    await handler({ id: 'job', type: 'screen_account', priority: 1, status: 'running', idempotencyKey: 'screen:1', payload: { projectId: project.rows[0].id, input: { xUserId: '42', handle: 'alpha' } } });
    const decisions = await database.query<{ decision: string }>('select decision from screening_decisions');
    const jobs = await database.query<{ type: string }>(`select type from jobs where type = 'research_project'`);
    expect(decisions.rows[0]?.decision).toBe('allowed');
    expect(jobs.rows[0]?.type).toBe('research_project');
  });
});
