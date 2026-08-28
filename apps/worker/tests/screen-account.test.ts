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
    const handler = createScreenAccountHandler(database, new AccountScreeningService(new AiProviderRouter([adapter('{"accountType":"PROJECT","reason":"项目账号","chainCategory":"Base","playbookCategory":"Launchpad"}')] )));
    await handler({ id: 'job', type: 'screen_account', priority: 1, status: 'running', idempotencyKey: 'screen:1', payload: { projectId: project.rows[0].id, input: { xUserId: '42', handle: 'alpha' } } });
    const decisions = await database.query<{ decision: string; chain_category: string | null; playbook_category: string | null }>('select decision, chain_category, playbook_category from screening_decisions');
    const jobs = await database.query<{ type: string }>(`select type from jobs where type = 'research_project'`);
    expect(decisions.rows[0]?.decision).toBe('allowed');
    expect(decisions.rows[0]).toMatchObject({ chain_category: 'Base', playbook_category: 'Launchpad' });
    expect(jobs.rows[0]?.type).toBe('research_project');
  });

  it('overrides a contradictory blocked label when the evidence says retain project', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, status, excluded_at, exclusion_reason) values ('43', 'mosaicetf', 'excluded', now(), 'AI 初筛自动拦截：旧判断') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'blocked', 'KOL', '旧判断')`, [project.rows[0].id]);
    const reason = '简介证据：账号是链上 ETF 协议并提供合约地址；项目类型结论：属于加密项目，不属于 KOL、个人账号、NFT 或 TRADFI，符合筛选标准，应保留。';
    const handler = createScreenAccountHandler(database, new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'KOL', reason }))])));
    await handler({ id: 'job-2', type: 'screen_account', priority: 1, status: 'running', idempotencyKey: 'screen:2', payload: { projectId: project.rows[0].id, input: { xUserId: '43', handle: 'mosaicetf', bio: 'ETFs rebuilt onchain.' } } });
    const current = await database.query<{ status: string; exclusion_reason: string | null }>('select status, exclusion_reason from projects where id = $1', [project.rows[0].id]);
    const latest = await database.query<{ decision: string; account_type: string }>('select decision, account_type from screening_decisions where project_id = $1 order by created_at desc limit 1', [project.rows[0].id]);
    expect(latest.rows[0]).toMatchObject({ decision: 'allowed', account_type: 'PROJECT' });
    expect(current.rows[0]).toMatchObject({ status: 'active', exclusion_reason: null });
  });
});
