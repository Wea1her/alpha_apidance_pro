import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { AiProviderRouter, type AiProviderAdapter } from '@alpha-research/ai';
import { migrateDatabase } from '@alpha-research/db';
import { createResearchProjectHandler } from '../src/handlers/research-project.js';

const trackKeys = ['product', 'technology', 'team', 'market', 'tokenomics', 'catalysts'] as const;

function reportFor(evidenceId: string) {
  const evidence = [{ evidenceId, claim: 'Alpha 收到项目相关信号。', sourceUrl: 'https://x.com/example' }];
  return {
    coreInfo: { projectName: 'Alpha Project', handle: 'alpha', summary: '项目摘要。', stage: '观察中' },
    focusReason: { currentProgress: '已有 Alpha 信号。', strengths: ['有公开活动'], weaknesses: ['证据仍有限'], reason: '继续观察。' },
    tags: ['基础设施'], thesis: ['后续交付是关键验证点'], playbook: ['关注官方更新'],
    l2Tracks: trackKeys.map((key) => ({ key, title: key, score: 5, summary: '阶段性判断。', findings: ['需要继续验证。'], evidence })),
    independentReview: { status: 'challenged', hypotheses: ['项目会持续交付。'], falsificationChecks: ['检查后续版本。'], counterEvidence: [], conclusion: '暂未证伪。', evidence },
    score: { overall: 55, confidence: 0.5, verdict: '持续观察', dimensions: trackKeys.map((key) => ({ key, score: 5, rationale: '证据有限。' })) },
    risksEvidence: [{ risk: '信息不足', evidence }]
  };
}

function adapter(calls: { count: number }, suffix = ''): AiProviderAdapter {
  return {
    profile: { id: 'p', name: 'research-test', baseUrl: 'https://ai.test', screeningModel: 'screen', researchModel: 'research', capabilities: ['chat', 'structured_output'], role: 'main', enabled: true, health: 'healthy' },
    complete: async (request) => {
      calls.count += 1;
      const evidenceIds = request.user.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi) ?? [];
      const evidenceId = evidenceIds.at(-1);
      return { text: `${JSON.stringify(reportFor(evidenceId ?? '00000000-0000-4000-8000-000000000001'))}${suffix}`, model: 'research' };
    },
    healthCheck: async () => 'healthy'
  };
}

describe('research-project handler', () => {
  const databases: PGlite[] = [];
  afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

  it('generates a readable report only for a screened-in project', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name) values ('42', 'alpha', 'Alpha Project') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    await database.query(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'test-raw', '{}'::jsonb, 'decoded')`);
    const raw = await database.query<{ id: string }>('select id from raw_events limit 1');
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, content, data) values ($1, $2, '42', 'common_follow', now(), '你关注的 12 个用户也关注了ta', '{}'::jsonb)`, [raw.rows[0].id, project.rows[0].id]);
    const calls = { count: 0 };
    await createResearchProjectHandler(database, new AiProviderRouter([adapter(calls, '\n补充说明：以上结论需要持续验证。')]))({ id: 'job', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:42', payload: { projectId: project.rows[0].id } });
    const versions = await database.query<{ status: string; rendered_markdown: string | null }>('select status, rendered_markdown from report_versions');
    expect(calls.count).toBe(1);
    expect(versions.rows[0]?.status).toBe('ready');
    expect(versions.rows[0]?.rendered_markdown).toContain('AI 调研报告');
  });

  it('skips excluded projects before calling AI', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, status) values ('43', 'excluded', 'excluded') returning id`);
    const calls = { count: 0 };
    await createResearchProjectHandler(database, new AiProviderRouter([adapter(calls)]))({ id: 'job', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:43', payload: { projectId: project.rows[0].id } });
    expect(calls.count).toBe(0);
    const versions = await database.query<{ count: string }>('select count(*)::text as count from report_versions');
    expect(versions.rows[0]?.count).toBe('0');
  });
});
