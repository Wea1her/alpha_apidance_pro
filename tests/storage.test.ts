import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { defaultMigrationsDirectory, listAppliedMigrations, parseMigrationFileName, runMigrations } from '../src/storage/migrate.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import {
  buildDecisionId,
  findProjectKeyByDedupeKey,
  persistDecision,
  persistEventLevelDecision,
  recordInboundEvent,
  resolveProject
} from '../src/storage/decision-recorder.js';
import { decide, type ParsedAlphaEvent } from '../src/domain/decision-rules.js';
import { buildInboundEventId, handleInboundEvent } from '../src/worker/inbound-pipeline.js';

/**
 * 存储层集成测试：需要真实 PostgreSQL。
 *
 * 安全约束：本文件会 DROP SCHEMA，因此**只接受** TEST_DATABASE_URL，且库名必须包含 "test"。
 * 绝不回退到 DATABASE_URL 或 .env 中的生产连接串。
 * 数据库不可用时整个文件跳过，保证无数据库环境下测试套件仍然全绿。
 */

let pool: StoragePool | null = null;
let available = false;

beforeAll(async () => {
  pool = await openTestDatabase();
  available = pool !== null;
  if (!available) return;
  await resetSchemaAndMigrate(pool!);
});

beforeEach(async () => {
  if (!available) return;
  // 每个用例都从“全新环境”开始：schema 用例会插入固定 ID 的夹具，跨用例残留会互相干扰。
  await resetSchemaAndMigrate(pool!, { forceAll: true });
  // 共享基线夹具：一个监控中的项目 + 一条接收记录，供约束用例引用。
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, source, pool_state, star)
     VALUES ('p1', 'berauniversity', 'natural', 'monitored', 0)`
  );
  await pool!.query(
    `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload, common_follow_count, link)
     VALUES ('efixture', 'collector-fixture', 1, now(), '{"channel":"follow"}', 3, 'https://x.com/berauniversity')`
  );
});

afterAll(async () => {
  if (pool) await pool.close();
});

// 注意：不能用 describe.skipIf(!available)——它在本文件加载时求值，而探测要到 beforeAll 才完成。
// 因此统一在用例内部按运行时结果跳过。
function itDb(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available) {
      console.warn('跳过存储层测试：未配置 TEST_DATABASE_URL 或数据库不可用');
      return;
    }
    await fn();
  });
}

describe('迁移文件名解析', () => {
  it('识别版本与名称，忽略其他文件', () => {
    expect(parseMigrationFileName('0001_initial.sql')).toEqual({ version: '0001', name: 'initial' });
    expect(parseMigrationFileName('README.md')).toBeNull();
    expect(parseMigrationFileName('initial.sql')).toBeNull();
  });
});

describe('存储层 schema', () => {
  itDb('迁移可重复执行且已应用版本被记录', async () => {
    const applied = await listAppliedMigrations(pool!);
    expect(applied.map((row) => row.version)).toContain('0001');

    const second = await runMigrations({ client: pool!, directory: defaultMigrationsDirectory(process.cwd()) });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0001');
  });

  itDb('创建了 M1 需要的全部表', async () => {
    const result = await pool!.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    const tables = result.rows.map((row) => String(row.table_name));
    for (const expected of [
      'audit_records',
      'config_versions',
      'decisions',
      'delivery_records',
      'inbound_events',
      'jobs',
      'project_contract_addresses',
      'project_identifiers',
      'projects',
      'reports',
      'runtime_metrics',
      'schema_migrations',
    ]) {
      expect(tables, expected).toContain(expected);
    }
  });

  itDb('接收记录允许保留解析失败与重复输入，并强制接收顺序唯一', async () => {
    await pool!.query(
      `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload, parse_error)
       VALUES ('e1', 'collector-1', 1, now(), '{"broken":', 'Unexpected end of JSON input')`
    );
    await pool!.query(
      `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload, parse_error)
       VALUES ('e2', 'collector-1', 1, now(), '{"broken":', 'duplicate seq')`
    ).then(
      () => {
        throw new Error('同一采集器的接收序号必须唯一');
      },
      () => undefined
    );
  });

  itDb('项目状态只有监控中/已排除两态，且排除必须带原因与时间', async () => {
    // 非法状态：同时违反“状态取值”与“排除一致性”两条 CHECK，Postgres 报哪条不保证，
    // 因此只断言被 projects 的某条 CHECK 拒绝。
    await expect(
      pool!.query(
        `INSERT INTO projects (project_id, project_key, source, pool_state)
         VALUES ('p2', 'x', 'natural', 'stopped')`
      )
    ).rejects.toThrow(/projects_(pool_state_valid|exclusion_consistent)/);

    // 已排除但缺排除时间/原因
    await expect(
      pool!.query(
        `INSERT INTO projects (project_id, project_key, source, pool_state)
         VALUES ('p3', 'y', 'natural', 'excluded')`
      )
    ).rejects.toThrow(/projects_exclusion_consistent/);

    // 合法排除：人工排除
    await pool!.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state, excluded_at, exclusion_reason, excluded_star)
       VALUES ('p4', 'boopfamily', 'natural', 'excluded', now(), 'manual', 2)`
    );

    // 监控中却带排除原因
    await expect(
      pool!.query(
        `INSERT INTO projects (project_id, project_key, source, pool_state, exclusion_reason)
         VALUES ('p5', 'z', 'natural', 'monitored', 'manual')`
      )
    ).rejects.toThrow(/projects_exclusion_consistent/);

    // 恢复：回到监控中并保留恢复理由（Q136）
    await pool!.query(
      `UPDATE projects SET pool_state = 'monitored', exclusion_reason = NULL, excluded_at = NULL, restore_reason = '项目方已澄清'
       WHERE project_id = 'p4'`
    );
    const restored = await pool!.query(`SELECT pool_state, restore_reason FROM projects WHERE project_id = 'p4'`);
    expect(restored.rows[0]).toMatchObject({ pool_state: 'monitored', restore_reason: '项目方已澄清' });
  });

  itDb('归一化账号唯一，来源与状态取值受约束', async () => {
    await pool!.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state) VALUES ('p10', 'getstonkoptions', 'restored', 'monitored')`
    );
    await expect(
      pool!.query(`INSERT INTO projects (project_id, project_key, source, pool_state) VALUES ('p11', 'getstonkoptions', 'natural', 'monitored')`)
    ).rejects.toThrow(/projects_project_key_key/);
    await expect(
      pool!.query(`INSERT INTO projects (project_id, project_key, source, pool_state) VALUES ('p12', 'other', 'manual', 'monitored')`)
    ).rejects.toThrow(/projects_source_valid/);
  });

  itDb('报告按项目与类型唯一，用量字段不允许负数', async () => {
    await pool!.query(
      `INSERT INTO reports (report_id, project_id, kind, body, generated_at)
       VALUES ('r1', 'p1', 'standard', '正文', now())`
    );
    await expect(
      pool!.query(
        `INSERT INTO reports (report_id, project_id, kind, body, generated_at)
         VALUES ('r2', 'p1', 'standard', '重复正文', now())`
      )
    ).rejects.toThrow(/reports_project_kind_natural_key/);
    await expect(
      pool!.query(
        `INSERT INTO reports (report_id, project_id, kind, body, generated_at, input_tokens)
         VALUES ('r3', 'p1', 'deep', '正文', now(), -1)`
      )
    ).rejects.toThrow(/reports_usage_non_negative/);

    // 恢复触发的新报告可以与自然报告并存（Q126、Q130）
    await pool!.query(
      `INSERT INTO reports (report_id, project_id, kind, body, generated_at, triggered_by)
       VALUES ('r4', 'p1', 'standard', '恢复后的新报告', now(), 'restore')`
    );
    const kinds = await pool!.query(
      `SELECT count(*)::int AS c FROM reports WHERE project_id = 'p1' AND kind = 'standard'`
    );
    expect(kinds.rows[0]?.c).toBe(2);
  });

  itDb('投递以业务目的 + 目标 + 分片号唯一，且手动报告可以不产生投递记录', async () => {
    await pool!.query(
      `INSERT INTO reports (report_id, project_id, kind, body, generated_at)
       VALUES ('r-report', 'p1', 'standard', '正文', now())`
    );
    await pool!.query(
      `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, shard_index)
       VALUES ('d1', 'p1', 'r-report', 'channel_main', '-100123', 0)`
    );
    await expect(
      pool!.query(
        `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, shard_index)
         VALUES ('d2', 'p1', 'r-report', 'channel_main', '-100123', 0)`
      )
    ).rejects.toThrow(/delivery_intent_key/);

    // 分割投递：分片号不同即为不同意图
    await pool!.query(
      `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, shard_index)
       VALUES ('d3', 'p1', 'r-report', 'discussion_report', '-100999', 1)`
    );
    // 无投递记录的报告是合法状态（生成与投递解耦，Q55）
    const withoutDelivery = await pool!.query(`SELECT count(*)::int AS count FROM reports r
       WHERE r.report_id = 'r-report' AND NOT EXISTS (SELECT 1 FROM delivery_records d WHERE d.report_id = r.report_id)`);
    expect(withoutDelivery.rows[0]?.count).toBe(0);
  });

  itDb('自动首次任务按项目与类型唯一，重试沿用同一任务 ID', async () => {
    await pool!.query(
      `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
       VALUES ('j1', 'standard', 'p1', 'queued', 'natural')`
    );
    await expect(
      pool!.query(
        `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
         VALUES ('j2', 'standard', 'p1', 'queued', 'natural')`
      )
    ).rejects.toThrow(/jobs_project_kind_auto_key/);

    // 恢复触发的任务不占用“自然首次任务”唯一位（Q130）
    await pool!.query(
      `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
       VALUES ('j3', 'standard', 'p1', 'queued', 'restore')`
    );
    await expect(
      pool!.query(`INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by) VALUES ('j4', 'standard', 'p1', 'bogus', 'natural')`)
    ).rejects.toThrow(/jobs_stage_valid/);
  });

  itDb('判定记录每条接收记录最多一条，且分类失败时不得伪造类型', async () => {
    // 判定记录依赖接收记录；e1 由前面的用例插入，这里补齐 e2/e3。
    await pool!.query(
      `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload, common_follow_count)
       VALUES ('e2', 'collector-1', 2, now(), '{"channel":"follow"}', 3),
              ('e3', 'collector-1', 3, now(), '{"channel":"follow"}', 4)
       ON CONFLICT (event_id) DO NOTHING`
    );

    await pool!.query(
      `INSERT INTO decisions (decision_id, event_id, project_id, reason_code, star, previous_star, max_star)
       VALUES ('dec1', 'efixture', 'p1', 'PUSHED', 2, 1, 5)`
    );
    await expect(
      pool!.query(`INSERT INTO decisions (decision_id, event_id, project_id, reason_code) VALUES ('dec2', 'efixture', 'p1', 'DEDUPE_REPEAT')`)
    ).rejects.toThrow(/decisions_event_key/);

    // 分类异常保守放行：只记 error，不填 type（Q38）
    await expect(
      pool!.query(
        `INSERT INTO decisions (decision_id, event_id, project_id, reason_code, classification_type, classification_error)
         VALUES ('dec3', 'e3', 'p1', 'CLASSIFY_ERROR_ALLOWED', 'PROJECT', 'timeout')`
      )
    ).rejects.toThrow(/decisions_classification_error_consistent/);

    await pool!.query(
      `INSERT INTO decisions (decision_id, event_id, project_id, reason_code, classification_error)
       VALUES ('dec4', 'e3', 'p1', 'CLASSIFY_ERROR_ALLOWED', 'timeout')`
    );
    const row = await pool!.query(`SELECT reason_code, classification_type, classification_error FROM decisions WHERE decision_id = 'dec4'`);
    expect(row.rows[0]).toMatchObject({ reason_code: 'CLASSIFY_ERROR_ALLOWED', classification_type: null });
  });

  itDb('审计与配置版本记录可写入，配置哈希唯一', async () => {
    await pool!.query(
      `INSERT INTO config_versions (config_version_id, content_hash, effective_at, snapshot)
       VALUES ('cfg-1', 'deadbeefdeadbeef', now(), '{"starLevels":[3,8,13,18,23]}'::jsonb)`
    );
    await expect(
      pool!.query(
        `INSERT INTO config_versions (config_version_id, content_hash, effective_at, snapshot)
         VALUES ('cfg-2', 'deadbeefdeadbeef', now(), '{}'::jsonb)`
      )
    ).rejects.toThrow(/config_versions_hash_key/);

    await pool!.query(
      `INSERT INTO audit_records (audit_id, action, target_type, target_id, before_summary, after_summary)
       VALUES ('a1', 'project.exclude', 'project', 'p4', 'monitored/star=2', 'excluded/manual')`
    );
    const audit = await pool!.query(`SELECT count(*)::int AS count FROM audit_records`);
    expect(audit.rows[0]?.count).toBe(1);
  });

  itDb('判定落库：接收记录 → 判定记录 → 项目状态与投递意图', async () => {
    const parsed: ParsedAlphaEvent = {
      channel: 'follow',
      title: 'Someone 关注了 Project',
      link: 'https://x.com/project',
      content: '你关注的 5 个用户也关注了ta',
      upstreamPushAtSec: 1_789_283_635,
      commonFollowCount: 5,
      legacyDedupeKey: 'follow|https://x.com/project|Someone 关注了 Project|1789283635',
      projectKey: 'project',
      displayName: 'Project'
    };

    const recorded = await recordInboundEvent(pool!, {
      eventId: 'evt-1',
      collectorId: 'collector-decision',
      ingestSeq: 1,
      receivedAt: '2026-09-14T00:00:01.000Z',
      rawPayload: JSON.stringify({ channel: 'follow' }),
      parsed,
      parseError: null
    });
    expect(recorded.inserted).toBe(true);

    // 判定前：项目不存在
    expect(await findProjectKeyByDedupeKey(pool!, parsed.legacyDedupeKey!)).toBeNull();

    const project = await resolveProject(pool!, { projectKey: 'project', parsed, source: 'natural' });
    expect(project.exists).toBe(false);
    expect(project.star).toBe(0);

    const outcome = await decide({
      eventId: 'evt-1',
      parsed,
      project: { projectId: project.projectId, star: project.star, displayPushCount: project.displayPushCount, exists: false },
      starLevels: [3, 8, 13, 18, 23],
      isDuplicate: false,
      inFlight: false,
      configVersionId: null,
      decidedAt: '2026-09-14T00:00:02.000Z'
    });
    expect(outcome.reasonCode).toBe('CLASSIFY_ALLOWED');

    const persisted = await persistDecision(pool!, {
      eventId: 'evt-1',
      projectId: project.projectId,
      projectKey: 'project',
      dedupeKey: parsed.legacyDedupeKey,
      persistence: {
        outcome,
        configVersionId: null,
        decidedAt: '2026-09-14T00:00:02.000Z',
        channelMessage: { chatId: '-100123', messageId: 777 }
      }
    });
    expect(persisted.decisionId).toBe(buildDecisionId('evt-1'));
    expect(persisted.decisionAlreadyExisted).toBe(false);

    // 判定记录：原因码、星级与前后值都可解释
    const decision = await pool!.query(
      `SELECT reason_code, star, previous_star, max_star, common_follow_count, project_key
       FROM decisions WHERE event_id = 'evt-1'`
    );
    expect(decision.rows[0]).toMatchObject({
      reason_code: 'CLASSIFY_ALLOWED',
      star: 1,
      previous_star: 0,
      max_star: 5,
      common_follow_count: 5,
      project_key: 'project'
    });

    // 项目：星级与展示序号已更新，真实发送次数单独计数，去重键可回查
    const updated = await pool!.query(
      `SELECT star, display_push_count, confirmed_send_count, legacy_dedupe_key, pool_state
       FROM projects WHERE project_id = $1`,
      [project.projectId]
    );
    expect(updated.rows[0]).toMatchObject({
      star: 1,
      display_push_count: 1,
      confirmed_send_count: 1,
      legacy_dedupe_key: parsed.legacyDedupeKey,
      pool_state: 'monitored'
    });
    expect(await findProjectKeyByDedupeKey(pool!, parsed.legacyDedupeKey!)).toBe('project');

    // 投递记录：只登记频道主消息这一意图，报告尚未生成
    const delivery = await pool!.query(
      `SELECT purpose, target_chat_id, message_id, sent_at FROM delivery_records WHERE project_id = $1`,
      [project.projectId]
    );
    expect(delivery.rows).toHaveLength(1);
    expect(delivery.rows[0]).toMatchObject({
      purpose: 'channel_main',
      target_chat_id: '-100123',
      message_id: '777'
    });
    expect(delivery.rows[0]?.sent_at).not.toBeNull();

    // 接收记录被标记为已处理
    const event = await pool!.query(`SELECT processed_at FROM inbound_events WHERE event_id = 'evt-1'`);
    expect(event.rows[0]?.processed_at).not.toBeNull();
  });

  itDb('同一接收记录不会产生第二条判定', async () => {
    const parsed: ParsedAlphaEvent = {
      channel: 'follow',
      title: 't',
      link: 'https://x.com/dup',
      content: 'c',
      upstreamPushAtSec: 1,
      commonFollowCount: 5,
      legacyDedupeKey: 'k-dup',
      projectKey: 'dup',
      displayName: 'dup'
    };
    await recordInboundEvent(pool!, {
      eventId: 'evt-dup',
      collectorId: 'collector-decision',
      ingestSeq: 10,
      receivedAt: '2026-09-14T00:00:03.000Z',
      rawPayload: '{}',
      parsed,
      parseError: null
    });
    const project = await resolveProject(pool!, { projectKey: 'dup', parsed, source: 'natural' });
    const outcome = await decide({
      eventId: 'evt-dup',
      parsed,
      project: { projectId: project.projectId, star: 0, displayPushCount: 0, exists: false },
      starLevels: [3, 8, 13, 18, 23],
      isDuplicate: false,
      inFlight: false,
      configVersionId: null,
      decidedAt: '2026-09-14T00:00:04.000Z'
    });
    const first = await persistDecision(pool!, {
      eventId: 'evt-dup',
      projectId: project.projectId,
      projectKey: 'dup',
      dedupeKey: parsed.legacyDedupeKey,
      persistence: { outcome, configVersionId: null, decidedAt: '2026-09-14T00:00:04.000Z' }
    });
    const second = await persistDecision(pool!, {
      eventId: 'evt-dup',
      projectId: project.projectId,
      projectKey: 'dup',
      dedupeKey: parsed.legacyDedupeKey,
      persistence: { outcome, configVersionId: null, decidedAt: '2026-09-14T00:00:05.000Z' }
    });
    expect(first.decisionId).not.toBeNull();
    expect(second.decisionId).toBeNull();
    expect(second.decisionAlreadyExisted).toBe(true);
  });

  itDb('未达门槛与解析失败也能落库，且不产生投递记录', async () => {
    const parsed: ParsedAlphaEvent = {
      channel: 'follow',
      title: 't',
      link: 'https://x.com/small',
      content: 'c',
      upstreamPushAtSec: 1,
      commonFollowCount: 1,
      legacyDedupeKey: 'k-small',
      projectKey: 'small',
      displayName: 'small'
    };
    await recordInboundEvent(pool!, {
      eventId: 'evt-small',
      collectorId: 'collector-decision',
      ingestSeq: 20,
      receivedAt: '2026-09-14T00:00:06.000Z',
      rawPayload: '{}',
      parsed,
      parseError: null
    });
    const project = await resolveProject(pool!, { projectKey: 'small', parsed, source: 'natural' });
    const outcome = await decide({
      eventId: 'evt-small',
      parsed,
      project: { projectId: project.projectId, star: 0, displayPushCount: 0, exists: false },
      starLevels: [3, 8, 13, 18, 23],
      isDuplicate: false,
      inFlight: false,
      configVersionId: null,
      decidedAt: '2026-09-14T00:00:07.000Z'
    });
    expect(outcome.reasonCode).toBe('BELOW_THRESHOLD');
    await persistDecision(pool!, {
      eventId: 'evt-small',
      projectId: project.projectId,
      projectKey: 'small',
      dedupeKey: parsed.legacyDedupeKey,
      persistence: { outcome, configVersionId: null, decidedAt: '2026-09-14T00:00:07.000Z' }
    });

    const decisions = await pool!.query(`SELECT reason_code FROM decisions ORDER BY decided_at`);
    expect(decisions.rows.map((row) => row.reason_code)).toContain('BELOW_THRESHOLD');
    const deliveries = await pool!.query(
      `SELECT count(*)::int AS c FROM delivery_records WHERE project_id = $1`,
      [project.projectId]
    );
    expect(deliveries.rows[0]?.c).toBe(0);

    // 解析失败：保留接收记录，判定只记原因码
    const failedEvent = await recordInboundEvent(pool!, {
      eventId: 'evt-broken',
      collectorId: 'collector-decision',
      ingestSeq: 21,
      receivedAt: '2026-09-14T00:00:08.000Z',
      rawPayload: '{broken:',
      parsed: {
        channel: null,
        title: null,
        link: null,
        content: null,
        upstreamPushAtSec: null,
        commonFollowCount: null,
        legacyDedupeKey: null,
        projectKey: null,
        displayName: null
      },
      parseError: 'Unexpected end of JSON input'
    });
    expect(failedEvent.inserted).toBe(true);
    const failed = await persistEventLevelDecision(pool!, {
      eventId: 'evt-broken',
      reasonCode: 'PARSE_ERROR',
      decidedAt: '2026-09-14T00:00:09.000Z'
    });
    expect(failed.decisionId).not.toBeNull();
    const stored = await pool!.query(`SELECT parse_error FROM inbound_events WHERE event_id = 'evt-broken'`);
    expect(stored.rows[0]?.parse_error).toBe('Unexpected end of JSON input');
  });

  itDb('入站流水线：解析 → 接收记录 → 判定 → 项目状态（未达门槛也留痕）', async () => {
    const raw = JSON.stringify({
      channel: 'follow',
      title: 'Alice 关注了 NewProject',
      link: 'https://x.com/newproject',
      content: '你关注的 5 个用户也关注了ta',
      push_at: 1_789_283_635,
      commonFollowCount: 1
    });

    const result = await handleInboundEvent({
      pool: pool!,
      collectorId: 'collector-pipeline',
      ingestSeq: 1,
      raw,
      receivedAt: '2026-09-14T01:00:00.000Z',
      starLevels: [3, 8, 13, 18, 23]
    });

    expect(result.reasonCode).toBe('BELOW_THRESHOLD');
    expect(result.pushed).toBe(false);
    expect(result.eventId).toBe(buildInboundEventId('collector-pipeline', 1));

    // 未达门槛的账号也建立了跟踪记录，页面才能回答“到底收到过没有”。
    const project = await pool!.query(
      `SELECT project_key, star, display_push_count, first_event_at, last_event_at FROM projects WHERE project_key = 'newproject'`
    );
    expect(project.rows).toHaveLength(1);
    expect(project.rows[0]).toMatchObject({ star: 0, display_push_count: 0 });
    expect(project.rows[0]?.first_event_at).not.toBeNull();

    // 接收记录里 push_at 被真实落盘（历史实现从未保存过它）
    const event = await pool!.query(
      `SELECT upstream_push_at_sec, legacy_dedupe_key, common_follow_count, processed_at
       FROM inbound_events WHERE event_id = $1`,
      [result.eventId]
    );
    expect(event.rows[0]).toMatchObject({ upstream_push_at_sec: '1789283635', common_follow_count: 1 });
    expect(String(event.rows[0]?.legacy_dedupe_key)).toContain('follow|https://x.com/newproject|');
    expect(event.rows[0]?.processed_at).not.toBeNull();
  });

  itDb('入站流水线：同一去重键重复到达记 DEDUPE_REPEAT，不同事件不误判重复', async () => {
    const raw = JSON.stringify({
      channel: 'follow',
      title: 'Alice 关注了 PushProject',
      link: 'https://x.com/pushproject',
      content: '你关注的 5 个用户也关注了ta',
      push_at: 1_789_283_700,
      commonFollowCount: 5
    });

    const first = await handleInboundEvent({
      pool: pool!,
      collectorId: 'collector-pipeline',
      ingestSeq: 10,
      raw,
      receivedAt: '2026-09-14T02:00:00.000Z',
      starLevels: [3, 8, 13, 18, 23],
      send: async () => ({ chatId: '-100777', messageId: 4242 })
    });
    expect(first.reasonCode).toBe('PUSHED');
    expect(first.pushed).toBe(true);

    const project = await pool!.query(
      `SELECT star, display_push_count, confirmed_send_count FROM projects WHERE project_key = 'pushproject'`
    );
    expect(project.rows[0]).toMatchObject({ star: 1, display_push_count: 1, confirmed_send_count: 1 });

    // 完全相同的原始消息再次到达 → 同一事件 ID，判定唯一约束拒绝重复判定
    const duplicate = await handleInboundEvent({
      pool: pool!,
      collectorId: 'collector-pipeline',
      ingestSeq: 10,
      raw,
      receivedAt: '2026-09-14T02:01:00.000Z',
      starLevels: [3, 8, 13, 18, 23],
      send: async () => ({ chatId: '-100777', messageId: 4243 })
    });
    expect(duplicate.decisionId).toBeNull();

    // 同一账号的新事件（push_at 不同）→ 新事件 ID，去重键不同，不应被判为重复
    const nextRaw = JSON.stringify({
      channel: 'follow',
      title: 'Bob 关注了 PushProject',
      link: 'https://x.com/pushproject',
      content: '你关注的 9 个用户也关注了ta',
      push_at: 1_789_283_900,
      commonFollowCount: 9
    });
    const next = await handleInboundEvent({
      pool: pool!,
      collectorId: 'collector-pipeline',
      ingestSeq: 11,
      raw: nextRaw,
      receivedAt: '2026-09-14T02:02:00.000Z',
      starLevels: [3, 8, 13, 18, 23],
      send: async () => ({ chatId: '-100777', messageId: 4244 })
    });
    expect(next.reasonCode).toBe('PUSHED');
    expect(next.outcome?.isRepeat).toBe(false);
    expect(next.outcome?.star).toBe(2);

    const reasons = await pool!.query(`SELECT reason_code FROM decisions ORDER BY decided_at`);
    expect(reasons.rows.map((row) => row.reason_code)).toEqual(['PUSHED', 'PUSHED']);
  });

  itDb('入站流水线：推送失败记 SEND_FAILED，不回写星级与展示序号', async () => {
    const raw = JSON.stringify({
      channel: 'follow',
      title: 'Alice 关注了 FailProject',
      link: 'https://x.com/failproject',
      content: '你关注的 5 个用户也关注了ta',
      push_at: 1_789_284_000,
      commonFollowCount: 5
    });

    const result = await handleInboundEvent({
      pool: pool!,
      collectorId: 'collector-pipeline',
      ingestSeq: 20,
      raw,
      receivedAt: '2026-09-14T03:00:00.000Z',
      starLevels: [3, 8, 13, 18, 23],
      send: async () => {
        throw new Error('telegram 503');
      },
      warn: () => undefined
    });

    expect(result.reasonCode).toBe('SEND_FAILED');
    expect(result.pushed).toBe(false);
    const project = await pool!.query(
      `SELECT star, display_push_count, confirmed_send_count FROM projects WHERE project_key = 'failproject'`
    );
    expect(project.rows[0]).toMatchObject({ star: 0, display_push_count: 0, confirmed_send_count: 0 });
    const deliveries = await pool!.query(`SELECT count(*)::int AS c FROM delivery_records`);
    expect(deliveries.rows[0]?.c).toBe(0);
  });

  itDb('入站流水线：解析失败与心跳都保留接收记录并给出原因码', async () => {
    const broken = await handleInboundEvent({
      pool: pool!,
      collectorId: 'collector-pipeline',
      ingestSeq: 30,
      raw: '{broken:',
      receivedAt: '2026-09-14T04:00:00.000Z',
      starLevels: [3, 8, 13, 18, 23]
    });
    expect(broken.reasonCode).toBe('PARSE_ERROR');

    const heartbeat = await handleInboundEvent({
      pool: pool!,
      collectorId: 'collector-pipeline',
      ingestSeq: 31,
      raw: JSON.stringify({ channel: 'heartbeat' }),
      receivedAt: '2026-09-14T04:01:00.000Z',
      starLevels: [3, 8, 13, 18, 23]
    });
    expect(heartbeat.reasonCode).toBe('HEARTBEAT');

    const stored = await pool!.query(
      `SELECT event_id, parse_error FROM inbound_events WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
      [[buildInboundEventId('collector-pipeline', 30), buildInboundEventId('collector-pipeline', 31)]]
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0]?.parse_error).toBeTruthy();

    const reasons = await pool!.query(`SELECT reason_code FROM decisions ORDER BY decided_at`);
    expect(reasons.rows.map((row) => row.reason_code)).toEqual(['PARSE_ERROR', 'HEARTBEAT']);
  });

  itDb('CA 表按项目 + 链 + 地址唯一，并区分来源', async () => {
    await pool!.query(
      `INSERT INTO project_contract_addresses (project_id, chain, address, source, raw_snippet)
       VALUES ('p1', 'sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'analysis', '上下文片段')`
    );
    await expect(
      pool!.query(
        `INSERT INTO project_contract_addresses (project_id, chain, address, source)
         VALUES ('p1', 'sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'manual')`
      )
    ).rejects.toThrow(/project_contract_addresses_pkey/);
    await expect(
      pool!.query(`INSERT INTO project_contract_addresses (project_id, chain, address, source) VALUES ('p1', 'eth', '0xabc', 'guessed')`)
    ).rejects.toThrow(/project_ca_source_valid/);
  });
});
