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

function chineseReportAdapter(): AiProviderAdapter {
  return {
    profile: { id: 'cn', name: 'chinese-fields', baseUrl: 'https://ai.test', screeningModel: 'screen', researchModel: 'research', capabilities: ['chat', 'structured_output'], role: 'main', enabled: true, health: 'healthy' },
    complete: async () => ({
      model: 'research',
      text: JSON.stringify({
        项目核心信息: { 项目: 'Alpha Project', 账号: '@alpha', 当前阶段: '公开进展暂未确认，等待后续更新。', 项目背景: '当前无法确认知名 Crypto 背书账号或机构背景；现有关注信号仅作为早期线索，不等同于可验证背书。', 项目摘要: '暂未确认' },
        关注理由: { 当前进展: 'X账号@alpha简介明确为某项目；绑定evidence 47f3d1e4-8ddb-4086-a45e-485248500a5f；共同关注人数13-21人，粉丝2342；近期帖子：2026-08-27 发布测试网演示。', 优点: ['有可验证产品'], 缺点: ['用户规模未知'], 综合判断: '观点：值得持续跟踪产品进展' },
        标签: ['基础设施'], 核心论点: ['产品留存将验证叙事'], 参与玩法: ['关注测试网任务'],
        六赛道: trackKeys.map((key) => ({ key, 评分: 6, 总结: '阶段性判断。', 发现: ['需要继续验证。'] })),
        独立复核轮: { 状态: 'challenged', 假设: ['项目会持续交付。'], 证伪检查项: ['检查后续版本。'], 反证: [], 结论: '暂未证伪。' },
        评分总览: { 总分: 60, 置信度: 0.5, 判断: '持续观察' }, 风险与证据链: []
      })
    }),
    healthCheck: async () => 'healthy'
  };
}

function legacyReportAdapter(): AiProviderAdapter {
  return {
    profile: { id: 'legacy', name: 'legacy-fields', baseUrl: 'https://ai.test', screeningModel: 'screen', researchModel: 'research', capabilities: ['chat', 'structured_output'], role: 'main', enabled: true, health: 'healthy' },
    complete: async () => ({
      model: 'research',
      text: JSON.stringify({
        coreInfo: { project: 'Legacy Project', xHandle: 'legacy', phase: '测试网', summary: '已发布可访问测试网。' },
        focusReason: '账号持续发布产品更新，已有测试网用户反馈。',
        thesis: '若测试网留存持续增长，项目有机会形成早期网络效应。',
        playbook: '先体验测试网，记录任务与产品更新。',
        l2Tracks: Object.fromEntries(trackKeys.map((key) => [key, { problem: `${key} 已有公开进展`, evidence: 'https://x.com/example' }])),
        independentReview: { falsifiableHypotheses: ['若无后续版本则证伪'], checkItems: ['检查版本更新'], finalConclusion: '当前证据支持持续观察。' },
        score: { total: 42, confidence: 0.6, dimensions: Object.fromEntries(trackKeys.map((key) => [key, 7])), judgment: '持续观察' },
        risksEvidence: '仍需验证用户留存与真实交付。'
      })
    }),
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

  it('skips deep research for blocked account types even if an old decision allowed it', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name, status) values ('47', 'zec_bit', 'Zec Bit', 'active') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'NFT', 'NFT 项目')`, [project.rows[0].id]);
    const calls = { count: 0 };
    await createResearchProjectHandler(database, new AiProviderRouter([adapter(calls)]))({ id: 'job-nft', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:47', payload: { projectId: project.rows[0].id } });
    expect(calls.count).toBe(0);
    const versions = await database.query<{ count: string }>('select count(*)::text as count from report_versions');
    expect(versions.rows[0]?.count).toBe('0');
  });

  it('maps Chinese report fields instead of silently using placeholders', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name) values ('44', 'alpha', 'Alpha Project') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    await database.query(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'cn-raw', '{}'::jsonb, 'decoded')`);
    const raw = await database.query<{ id: string }>('select id from raw_events limit 1');
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, content, data) values ($1, $2, '44', 'common_follow', now(), '共同关注 20 人', '{}'::jsonb)`, [raw.rows[0].id, project.rows[0].id]);
    await createResearchProjectHandler(database, new AiProviderRouter([chineseReportAdapter()]))({ id: 'job-cn', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:44', payload: { projectId: project.rows[0].id } });
    const result = await database.query<{ rendered_markdown: string }>('select rendered_markdown from report_versions');
    expect(result.rows[0]?.rendered_markdown).toContain('观点：值得持续跟踪产品进展');
    expect(result.rows[0]?.rendered_markdown).toContain('产品留存将验证叙事');
    expect(result.rows[0]?.rendered_markdown).toContain('近期帖子：2026-08-27 发布测试网演示');
    expect(result.rows[0]?.rendered_markdown).not.toContain('绑定evidence');
    expect(result.rows[0]?.rendered_markdown).not.toContain('共同关注人数13-21人');
    expect(result.rows[0]?.rendered_markdown).not.toContain('47f3d1e4-8ddb-4086-a45e-485248500a5f');
    expect(result.rows[0]?.rendered_markdown).toContain('早期公开构建阶段（基于当前可见信号）');
    expect(result.rows[0]?.rendered_markdown).toContain('项目公开背景资料基于账号简介、历史推文和所属生态整理');
    expect(result.rows[0]?.rendered_markdown).not.toContain('公开进展暂未确认，等待后续更新');
    expect(result.rows[0]?.rendered_markdown).not.toContain('无法确认知名 Crypto 背书账号');
    expect(result.rows[0]?.rendered_markdown).not.toContain('当前暂无正向证据');
    expect(result.rows[0]?.rendered_markdown).not.toContain('当前暂无负向证据');
    expect(result.rows[0]?.rendered_markdown).not.toContain('关注测试网任务');
    expect(result.rows[0]?.rendered_markdown).not.toContain('L2 六赛道深挖');
    expect(result.rows[0]?.rendered_markdown).not.toContain('评分总览');
  });

  it('retries a syntactically valid but incomplete report before persisting', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name) values ('45', 'alpha', 'Alpha Project') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    await database.query(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'retry-raw', '{}'::jsonb, 'decoded')`);
    const raw = await database.query<{ id: string }>('select id from raw_events limit 1');
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, content, data) values ($1, $2, '45', 'common_follow', now(), '共同关注 20 人', '{}'::jsonb)`, [raw.rows[0].id, project.rows[0].id]);
    let calls = 0;
    const retryAdapter: AiProviderAdapter = {
      profile: { id: 'retry', name: 'retry', baseUrl: 'https://ai.test', screeningModel: 'screen', researchModel: 'research', capabilities: ['chat', 'structured_output'], role: 'main', enabled: true, health: 'healthy' },
      complete: async (request) => {
        calls += 1;
        if (calls === 1) return { text: '{}', model: 'research' };
        const evidenceId = request.user.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi)?.at(-1) ?? '00000000-0000-4000-8000-000000000001';
        return { text: JSON.stringify(reportFor(evidenceId)), model: 'research' };
      },
      healthCheck: async () => 'healthy'
    };
    await createResearchProjectHandler(database, new AiProviderRouter([retryAdapter]))({ id: 'job-retry', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:45', payload: { projectId: project.rows[0].id } });
    const result = await database.query<{ status: string; rendered_markdown: string; structured_document: { thesis: string[] } }>('select status, rendered_markdown, structured_document from report_versions');
    expect(calls).toBe(2);
    expect(result.rows[0]?.status).toBe('ready');
    expect(result.rows[0]?.structured_document.thesis[0]).toContain('后续交付是关键验证点');
    expect(result.rows[0]?.rendered_markdown).not.toContain('核心论点');
  });

  it('preserves legacy Grok field names and object-shaped tracks', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name) values ('46', 'legacy', 'Legacy Project') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    await database.query(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'legacy-raw', '{}'::jsonb, 'decoded')`);
    const raw = await database.query<{ id: string }>('select id from raw_events limit 1');
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, content, data) values ($1, $2, '46', 'common_follow', now(), '共同关注 20 人', '{}'::jsonb)`, [raw.rows[0].id, project.rows[0].id]);
    await createResearchProjectHandler(database, new AiProviderRouter([legacyReportAdapter()]))({ id: 'job-legacy', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:46', payload: { projectId: project.rows[0].id } });
    const result = await database.query<{ status: string; rendered_markdown: string; structured_document: { coreInfo: { handle: string }; independentReview: { conclusion: string; hypotheses: string[] }; l2Tracks: Array<{ findings: string[] }>; risksEvidence: Array<{ risk: string }> } }>('select status, rendered_markdown, structured_document from report_versions');
    expect(result.rows[0]?.status).toBe('ready');
    expect(result.rows[0]?.structured_document.coreInfo.handle).toBe('legacy');
    expect(result.rows[0]?.structured_document.independentReview.conclusion).toContain('当前证据支持');
    expect(result.rows[0]?.structured_document.independentReview.hypotheses[0]).toContain('无后续版本');
    expect(result.rows[0]?.structured_document.l2Tracks[0]?.findings[0]).toContain('problem:');
    expect(result.rows[0]?.structured_document.risksEvidence[0]?.risk).toContain('仍需验证用户留存');
    expect(result.rows[0]?.rendered_markdown).not.toContain('L2 六赛道深挖');
  });
});
