import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { AiProviderRouter, type AiProviderAdapter } from '@alpha-research/ai';
import { migrateDatabase } from '@alpha-research/db';
import { createResearchProjectHandler } from '../src/handlers/research-project.js';

function reportFor() {
  return {
    coreInfo: { projectName: 'Alpha Project', handle: 'alpha', summary: '项目摘要。', stage: '观察中' },
    focusReason: { currentProgress: '已有 Alpha 信号。', strengths: ['有公开活动'], weaknesses: ['证据仍有限'], reason: '继续观察。' },
    tags: ['基础设施']
  };
}

function adapter(calls: { count: number }, suffix = ''): AiProviderAdapter {
  return {
    profile: { id: 'p', name: 'research-test', baseUrl: 'https://ai.test', screeningModel: 'screen', researchModel: 'research', capabilities: ['chat', 'structured_output'], role: 'main', enabled: true, health: 'healthy' },
    complete: async (request) => {
      calls.count += 1;
      return { text: `${JSON.stringify(reportFor())}${suffix}`, model: 'research' };
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
        项目核心信息: { 项目: 'Alpha Project', 账号: '@alpha', 当前阶段: '公开进展暂未确认，等待后续更新。', 项目背景: '当前无法确认知名 Crypto 背书账号或机构背景；现有关注信号仅作为早期线索，不等同于可验证背书。', 项目摘要: 'Alpha Project (@alpha) 定位为早期基础设施项目，通过公开测试网验证产品需求，当前需继续观察用户使用数据。' },
        关注理由: { 当前进展: 'X账号@alpha简介明确为某项目；绑定evidence 47f3d1e4-8ddb-4086-a45e-485248500a5f；共同关注人数13-21人，粉丝2342；近期帖子：2026-08-27 发布测试网演示。', 优点: ['有可验证产品'], 缺点: ['用户规模未知'], 综合判断: '观点：值得持续跟踪产品进展' },
        标签: ['基础设施'], 核心论点: ['产品留存将验证叙事'], 参与玩法: ['关注测试网任务'],
        六赛道: [{ key: 'product', 评分: 6, 总结: '阶段性判断。', 发现: ['需要继续验证。'] }],
        独立复核轮: { 状态: 'challenged', 假设: ['项目会持续交付。'], 证伪检查项: ['检查后续版本。'], 反证: [], 结论: '暂未证伪。' },
        评分总览: { 总分: 60, 置信度: 0.5, 判断: '持续观察' }, 风险与证据链: []
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
    const versions = await database.query<{ status: string; version: number; rendered_markdown: string | null }>('select status, version, rendered_markdown from report_versions');
    expect(calls.count).toBe(1);
    expect(versions.rows[0]?.status).toBe('ready');
    expect(versions.rows[0]?.version).toBe(3);
    expect(versions.rows[0]?.rendered_markdown).toContain('AI 调研报告');
  });

  it('sends post heat and account activity metrics to the V3 prompt', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name) values ('metrics-user', 'metrics', 'Metrics Project') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    await database.query(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'metrics-raw', '{}'::jsonb, 'decoded')`);
    const raw = await database.query<{ id: string }>('select id from raw_events limit 1');
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, x_post_url, content, data) values ($1, $2, 'metrics-user', 'new_tweet', now(), 'https://x.com/metrics/status/1', '产品即将开放测试', $3::jsonb)`, [raw.rows[0].id, project.rows[0].id, JSON.stringify({ tweet: { views: 92000, like_count: 3100, retweet_count: 420, reply_count: 180 }, user: { followers_count: 680 } })]);
    let promptUser = '';
    const base = adapter({ count: 0 });
    const captureAdapter: AiProviderAdapter = { ...base, complete: async (request) => { promptUser = request.user; return base.complete(request); } };
    await createResearchProjectHandler(database, new AiProviderRouter([captureAdapter]))({ id: 'job-metrics', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:metrics-user', payload: { projectId: project.rows[0].id } });
    expect(promptUser).toContain('浏览 92000');
    expect(promptUser).toContain('点赞 3100');
    expect(promptUser).toContain('回复 180');
    expect(promptUser).toContain('粉丝 680');
    expect(promptUser).toContain('时间：');
    expect(promptUser).not.toContain('已完成事项、未完成事项');
  });

  it('passes Alpha follow_user profile evidence into the V3 research context', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name) values ('profile-user', 'UrVote_', 'UrVote') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    const raw = await database.query<{ id: string }>(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'profile-raw', '{}'::jsonb, 'decoded') returning id`);
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, content, data) values ($1, $2, 'profile-user', 'common_follow', now(), '用户简介：The governance layer for communities.', $3::jsonb)`, [raw.rows[0].id, project.rows[0].id, JSON.stringify({ follow_user: { screen_name: 'UrVote_', description: 'The governance layer for communities. Vote, verify, and watch in real time.', followers_count: 455, statuses_count: 326 } })]);
    let promptUser = '';
    const base = adapter({ count: 0 });
    const captureAdapter: AiProviderAdapter = { ...base, complete: async (request) => { promptUser = request.user; return base.complete(request); } };
    await createResearchProjectHandler(database, new AiProviderRouter([captureAdapter]))({ id: 'job-profile', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:profile-user', payload: { projectId: project.rows[0].id } });
    expect(promptUser).toContain('governance layer');
    expect(promptUser).toContain('粉丝 455');
  });

  it('uses profile evidence instead of generic placeholders when the model omits the summary', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name) values ('placeholder-profile', 'UrVote_', 'UrVote') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    const raw = await database.query<{ id: string }>(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'placeholder-profile-raw', '{}'::jsonb, 'decoded') returning id`);
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, content, data) values ($1, $2, 'placeholder-profile', 'common_follow', now(), '用户简介：The governance layer for communities.', $3::jsonb)`, [raw.rows[0].id, project.rows[0].id, JSON.stringify({ follow_user: { screen_name: 'UrVote_', description: 'The governance layer for communities. Vote, verify, and watch in real time.', followers_count: 455 } })]);
    const placeholderAdapter: AiProviderAdapter = { ...adapter({ count: 0 }), complete: async () => { const report = reportFor(); report.coreInfo.summary = '公开定位资料不足，暂无公开证据，暂无公开证据。'; return { text: JSON.stringify(report), model: 'research' }; } };
    await createResearchProjectHandler(database, new AiProviderRouter([placeholderAdapter]))({ id: 'job-placeholder-profile', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:placeholder-profile', payload: { projectId: project.rows[0].id } });
    const result = await database.query<{ rendered_markdown: string }>('select rendered_markdown from report_versions');
    expect(result.rows[0]?.rendered_markdown).toContain('governance layer');
    expect(result.rows[0]?.rendered_markdown).not.toContain('公开定位资料不足，暂无公开证据，暂无公开证据');
  });

  it('replaces unfilled template placeholders instead of publishing them', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name) values ('placeholder-user', 'placeholder', 'Placeholder Project') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    await database.query(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'placeholder-raw', '{}'::jsonb, 'decoded')`);
    const raw = await database.query<{ id: string }>('select id from raw_events limit 1');
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, content, data) values ($1, $2, 'placeholder-user', 'new_tweet', now(), 'Soon', '{}'::jsonb)`, [raw.rows[0].id, project.rows[0].id]);
    const placeholderAdapter: AiProviderAdapter = {
      profile: { id: 'placeholder', name: 'placeholder', baseUrl: 'https://ai.test', screeningModel: 'screen', researchModel: 'research', capabilities: ['chat', 'structured_output'], role: 'main', enabled: true, health: 'healthy' },
      complete: async () => { const report = reportFor(); report.coreInfo.summary = '定位为暂无公开证据，通过暂无公开证据服务暂无公开证据；当前暂无公开证据。'; report.focusReason.strengths = ['作为暂无公开证据的早期布局者，暂无公开证据带来暂无公开证据。']; report.focusReason.weaknesses = ['暂无公开证据导致暂无公开证据；若暂无公开证据不成立，暂无公开证据会放大。']; report.focusReason.reason = '值得小仓试错。该账号获得暂无公开证据，叠加暂无公开证据，存在暂无公开证据机会。'; return { text: JSON.stringify(report), model: 'research' }; },
      healthCheck: async () => 'healthy'
    };
    await createResearchProjectHandler(database, new AiProviderRouter([placeholderAdapter]))({ id: 'job-placeholder', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:placeholder-user', payload: { projectId: project.rows[0].id } });
    const result = await database.query<{ rendered_markdown: string }>('select rendered_markdown from report_versions');
    expect(result.rows[0]?.rendered_markdown).not.toContain('核心定位/叙事');
    expect(result.rows[0]?.rendered_markdown).not.toContain('暂无公开证据，通过暂无公开证据服务');
    expect(result.rows[0]?.rendered_markdown).toContain('持续观察。当前公开资料和有效信号不足');
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
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name, status) values ('47', 'kol_account', 'KOL Account', 'active') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'KOL', 'KOL 账号')`, [project.rows[0].id]);
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
    const result = await database.query<{ rendered_markdown: string; structured_document: Record<string, unknown> }>('select rendered_markdown, structured_document from report_versions');
    expect(result.rows[0]?.rendered_markdown).toContain('观点：值得持续跟踪产品进展');
    expect(result.rows[0]?.rendered_markdown).toContain('近期帖子：2026-08-27 发布测试网演示');
    expect(result.rows[0]?.rendered_markdown).not.toContain('绑定evidence');
    expect(result.rows[0]?.rendered_markdown).not.toContain('共同关注人数13-21人');
    expect(result.rows[0]?.rendered_markdown).not.toContain('47f3d1e4-8ddb-4086-a45e-485248500a5f');
    expect(result.rows[0]?.rendered_markdown).toContain('早期公开构建阶段（基于当前可见信号）');
    expect(result.rows[0]?.rendered_markdown).not.toContain('项目背景');
    expect(result.rows[0]?.rendered_markdown).not.toContain('公开进展暂未确认，等待后续更新');
    expect(result.rows[0]?.rendered_markdown).not.toContain('无法确认知名 Crypto 背书账号');
    expect(result.rows[0]?.rendered_markdown).not.toContain('当前暂无正向证据');
    expect(result.rows[0]?.rendered_markdown).not.toContain('当前暂无负向证据');
    expect(result.rows[0]?.rendered_markdown).not.toContain('关注测试网任务');
    expect(result.rows[0]?.rendered_markdown).not.toContain('L2 六赛道深挖');
    expect(result.rows[0]?.rendered_markdown).not.toContain('评分总览');
    expect(Object.keys(result.rows[0]?.structured_document ?? {}).sort()).toEqual(['coreInfo', 'focusReason', 'tags']);
  });

  it('retries a syntactically valid but incomplete report before persisting', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name) values ('45', 'alpha', 'Alpha Project') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    await database.query(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'retry-raw', '{}'::jsonb, 'decoded')`);
    const raw = await database.query<{ id: string }>('select id from raw_events limit 1');
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, content, data) values ($1, $2, '45', 'common_follow', now(), '共同关注 20 人', '{}'::jsonb)`, [raw.rows[0].id, project.rows[0].id]);
    let calls = 0;
    let retryPrompt = '';
    const retryAdapter: AiProviderAdapter = {
      profile: { id: 'retry', name: 'retry', baseUrl: 'https://ai.test', screeningModel: 'screen', researchModel: 'research', capabilities: ['chat', 'structured_output'], role: 'main', enabled: true, health: 'healthy' },
      complete: async (request) => {
        calls += 1;
        if (calls === 1) return { text: '{}', model: 'research' };
        retryPrompt = request.user;
        return { text: JSON.stringify(reportFor()), model: 'research' };
      },
      healthCheck: async () => 'healthy'
    };
    await createResearchProjectHandler(database, new AiProviderRouter([retryAdapter]))({ id: 'job-retry', type: 'research_project', priority: 1, status: 'running', idempotencyKey: 'research:45', payload: { projectId: project.rows[0].id } });
    const result = await database.query<{ status: string; rendered_markdown: string; structured_document: Record<string, unknown> }>('select status, rendered_markdown, structured_document from report_versions');
    expect(calls).toBe(2);
    expect(result.rows[0]?.status).toBe('ready');
    expect(Object.keys(result.rows[0]?.structured_document ?? {}).sort()).toEqual(['coreInfo', 'focusReason', 'tags']);
    expect(retryPrompt).toContain('顶层仍只能输出 coreInfo、focusReason、tags');
    expect(retryPrompt).not.toContain('内部六赛道、评分和复核字段可基于已有证据归一化');
    expect(result.rows[0]?.rendered_markdown).not.toContain('核心论点');
  });
});
