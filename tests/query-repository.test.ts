import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import {
  buildTelegramLink,
  decodeCursor,
  encodeCursor,
  listDecisionTimeline,
  listProjects,
  readProjectDetail,
  readHealthSnapshot
} from '../src/storage/query-repository.js';

/**
 * 查询层（第 7 节、Q14、Q95）集成测试：需要真实 PostgreSQL；不可用时跳过。
 */

let pool: StoragePool | null = null;
let available = false;

function itDb(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available) return;
    await fn();
  });
}

beforeAll(async () => {
  pool = await openTestDatabase();
  available = pool !== null;
  if (available) await resetSchemaAndMigrate(pool!);
});

beforeEach(async () => {
  if (!available) return;
  // 强制重跑迁移：新增的语句级触发器与 runtime_counters 需要存在，否则健康快照读不到计数。
  // 触发器已在数据被清空后重建，计数会由迁移里的回填逻辑重新对齐到 0。
  await resetSchemaAndMigrate(pool!, { forceAll: true });
});

afterAll(async () => {
  if (pool) await pool.close();
});

/** 造 count 个项目，星级与加入时间按索引变化，便于验证排序与分页。 */
async function seedProjects(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const star = index % 5;
    const enteredAt = new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString();
    await pool!.query(
      `INSERT INTO projects (project_id, project_key, display_name, source, pool_state, star, entered_pool_at)
       VALUES ($1, $2, $3, 'natural', 'monitored', $4, $5::timestamptz)`,
      [`proj-${String(index).padStart(3, '0')}`, `account${String(index).padStart(3, '0')}`, `Account ${index}`, star, enteredAt]
    );
  }
}

describe('游标编解码', () => {
  it('可往返且非法游标返回 null', () => {
    const encoded = encodeCursor({ star: 3, enteredPoolAt: '2026-09-01T00:00:00.000Z', projectId: 'p1' });
    expect(decodeCursor(encoded)).toEqual({ star: 3, enteredPoolAt: '2026-09-01T00:00:00.000Z', projectId: 'p1' });
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });
});

describe('项目列表', () => {
  itDb('按星级降序、加入时间降序、项目 ID 升序稳定排序', async () => {
    await seedProjects(12);
    const result = await listProjects(pool!, { limit: 20 });

    expect(result.rows).toHaveLength(12);
    const sortKeys: Array<[number, string, string]> = result.rows.map((row) => [row.star, row.enteredPoolAt, row.projectId]);
    const sorted = [...sortKeys].sort((a, b) => {
      if (a[0] !== b[0]) return b[0] - a[0];
      if (a[1] !== b[1]) return a[1] < b[1] ? 1 : -1;
      return a[2] < b[2] ? -1 : 1;
    });
    expect(sortKeys).toEqual(sorted);
  });

  itDb('游标翻页不漏不重', async () => {
    await seedProjects(12);
    const first = await listProjects(pool!, { limit: 5 });
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).not.toBeNull();

    const second = await listProjects(pool!, { limit: 5, cursor: first.page.nextCursor });
    const third = await listProjects(pool!, { limit: 5, cursor: second.page.nextCursor });

    const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row.projectId);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(third.page.hasMore).toBe(false);
    expect(third.page.nextCursor).toBeNull();
  });

  itDb('翻页期间插入新数据不会造成重复（keyset 而非 OFFSET）', async () => {
    await seedProjects(6);
    const first = await listProjects(pool!, { limit: 3 });

    // 插入一个高星级、最新加入的项目：它会排在首页，但不应在后续页里重复出现
    await pool!.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state, star, entered_pool_at)
       VALUES ('proj-new', 'newcomer', 'natural', 'monitored', 4, now())`
    );

    const second = await listProjects(pool!, { limit: 3, cursor: first.page.nextCursor });
    const ids = [...first.rows, ...second.rows].map((row) => row.projectId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  itDb('支持账号搜索与星级、状态、是否有 CA 过滤', async () => {
    await seedProjects(6);
    await pool!.query(
      `INSERT INTO project_contract_addresses (project_id, chain, address, source)
       VALUES ('proj-000', 'sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'analysis')`
    );
    await pool!.query(`UPDATE projects SET pool_state = 'excluded', excluded_at = now(), exclusion_reason = 'manual' WHERE project_id = 'proj-005'`);

    const bySearch = await listProjects(pool!, { search: 'Account 3' });
    expect(bySearch.rows.map((row) => row.projectKey)).toEqual(['account003']);

    const byStar = await listProjects(pool!, { stars: [0] });
    expect(byStar.rows.length).toBeGreaterThan(0);
    for (const row of byStar.rows) expect(row.star).toBe(0);

    const excluded = await listProjects(pool!, { poolState: 'excluded' });
    expect(excluded.rows.map((row) => row.projectId)).toEqual(['proj-005']);

    const withCa = await listProjects(pool!, { hasContractAddress: true });
    expect(withCa.rows.map((row) => row.projectId)).toEqual(['proj-000']);
    const withoutCa = await listProjects(pool!, { hasContractAddress: false });
    expect(withoutCa.rows.some((row) => row.projectId === 'proj-000')).toBe(false);
  });

  itDb('limit 被限制在合理范围内，且版本号单调递增', async () => {
    await seedProjects(5);
    const result = await listProjects(pool!, { limit: 999 });
    expect(result.page.limit).toBeLessThanOrEqual(200);
    const versions = result.rows.map((row) => Number(row.version.split('-')[1]));
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  itDb('没有数据时返回空列表而不是报错', async () => {
    const result = await listProjects(pool!);
    expect(result.rows).toEqual([]);
    expect(result.page.hasMore).toBe(false);
  });
});

describe('判定时间线', () => {
  async function seedDecisions(count: number): Promise<void> {
    // 判定记录引用项目，先建被引用的项目。
    await pool!.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state, star)
       VALUES ('proj-000', 'account000', 'natural', 'monitored', 1) ON CONFLICT DO NOTHING`
    );
    for (let index = 0; index < count; index += 1) {
      const eventId = `evt-${String(index).padStart(3, '0')}`;
      await pool!.query(
        `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload, title, link, upstream_push_at_sec)
         VALUES ($1, 'collector-q', $2, now(), '{}', $3, $4, $5)`,
        [eventId, index + 1, `Title ${index}`, `https://x.com/account${index}`, 1_789_000_000 + index]
      );
      await pool!.query(
        `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at, common_follow_count)
         VALUES ($1, $2, 'proj-000', 'account000', $3, $4::timestamptz, $5)`,
        [
          `dec-${String(index).padStart(3, '0')}`,
          eventId,
          index % 2 === 0 ? 'BELOW_THRESHOLD' : 'PUSHED',
          new Date(Date.UTC(2026, 8, 14, 0, index)).toISOString(),
          index
        ]
      );
    }
  }

  itDb('按判定时间倒序返回，并联表带出原始输入', async () => {
    await seedDecisions(4);
    const result = await listDecisionTimeline(pool!, { limit: 10 });

    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]?.reasonCode).toBe('PUSHED');
    expect(result.rows[0]?.title).toBe('Title 3');
    expect(result.rows[0]?.upstreamPushAtSec).toBe(1_789_000_003);
    expect(result.rows[0]?.projectKey).toBe('account000');
  });

  itDb('游标翻页不漏不重，支持原因码过滤', async () => {
    await seedDecisions(6);
    const first = await listDecisionTimeline(pool!, { limit: 4 });
    const second = await listDecisionTimeline(pool!, { limit: 4, cursor: first.page.nextCursor });
    const ids = [...first.rows, ...second.rows].map((row) => row.decisionId);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);

    const onlyPushed = await listDecisionTimeline(pool!, { reasonCodes: ['PUSHED'], limit: 10 });
    expect(onlyPushed.rows.every((row) => row.reasonCode === 'PUSHED')).toBe(true);
    expect(onlyPushed.rows).toHaveLength(3);
  });

  itDb('分类异常后放行的分支带出 error 而不是伪造类型', async () => {
    await pool!.query(
      `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload)
       VALUES ('evt-x', 'collector-q', 99, now(), '{}')`
    );
    await pool!.query(
      `INSERT INTO decisions (decision_id, event_id, reason_code, decided_at, classification_error)
       VALUES ('dec-x', 'evt-x', 'CLASSIFY_ERROR_ALLOWED', now(), '分类超时')`
    );
    const result = await listDecisionTimeline(pool!, { reasonCodes: ['CLASSIFY_ERROR_ALLOWED'] });
    expect(result.rows[0]).toMatchObject({
      classificationType: null,
      classificationError: '分类超时'
    });
  });
});

describe('健康快照（Q101）', () => {
  itDb('空库时返回 0 而不是报错', async () => {
    const health = await readHealthSnapshot(pool!);
    expect(health).toMatchObject({
      lastInboundAt: null,
      projects: 0,
      excludedProjects: 0,
      inboundEvents: 0,
      decisions: 0,
      pendingDeliveries: 0
    });
    expect(health.sampledAt).toBeTruthy();
  });

  itDb('统计任务、投递与项目状态', async () => {
    await seedProjects(3);
    await pool!.query(`UPDATE projects SET pool_state = 'excluded', excluded_at = now(), exclusion_reason = 'manual' WHERE project_id = 'proj-001'`);
    await pool!.query(
      `INSERT INTO jobs (job_id, kind, stage, triggered_by) VALUES
        ('j1', 'standard', 'queued', 'natural'),
        ('j2', 'standard', 'failed', 'restore'),
        ('j3', 'deep', 'dead_letter', 'natural')`
    );
    await pool!.query(
      `INSERT INTO delivery_records (delivery_id, project_id, purpose, target_chat_id, abandoned, uncertain)
       VALUES ('d1', 'proj-000', 'channel_main', '-100', false, false),
              ('d2', 'proj-000', 'channel_main', '-101', true, false),
              ('d3', 'proj-000', 'discussion_report', '-102', false, true)`
    );
    await pool!.query(
      `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload)
       VALUES ('evt-h', 'collector-q', 1, now(), '{}')`
    );

    const health = await readHealthSnapshot(pool!);
    expect(health).toMatchObject({
      projects: 3,
      excludedProjects: 1,
      inboundEvents: 1,
      failedJobs: 1,
      deadLetterJobs: 1,
      // 结果不确定的投递仍未送达，因此同时计入“待补发”与“不确定”（Q9）。
      pendingDeliveries: 2,
      abandonedDeliveries: 1,
      uncertainDeliveries: 1
    });
    expect(health.jobs).toMatchObject({ queued: 1, failed: 1, dead_letter: 1 });
    expect(health.lastInboundAt).not.toBeNull();
  });

  it('查询失败时抛错，不返回空数据冒充正常', async () => {
    const broken = {
      query: async () => {
        throw new Error('connection terminated');
      }
    } as unknown as StoragePool;
    await expect(readHealthSnapshot(broken)).rejects.toThrow('connection terminated');
  });
});

describe('项目详情（M4 详情页）', () => {
  itDb('不存在的项目返回 null，而不是空结构', async () => {
    expect(await readProjectDetail(pool!, { projectId: 'missing' })).toBeNull();
  });

  itDb('一次取齐项目、报告、投递、链接与时间线', async () => {
    await seedProjects(1);
    await pool!.query(
      `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload, title, link)
       VALUES ('evt-d', 'c', 1, now(), '{}', 'Alice 关注了 Project', 'https://x.com/account000')`
    );
    // 判定记录引用配置版本，先建版本再引用（外键保证“当时用的是哪套配置”可追溯）。
    await pool!.query(
      `INSERT INTO config_versions (config_version_id, content_hash, effective_at, snapshot)
       VALUES ('cfg-1', 'hash-cfg-1', now(), '{}'::jsonb) ON CONFLICT DO NOTHING`
    );
    await pool!.query(
      `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at, config_version_id)
       VALUES ('dec-d', 'evt-d', 'proj-000', 'account000', 'PUSHED', now(), 'cfg-1')`
    );
    await pool!.query(
      `INSERT INTO reports (report_id, project_id, kind, body, generated_at, triggered_by, model)
       VALUES ('rep-d', 'proj-000', 'standard', '七章正文', now(), 'natural', 'grok-4.3')`
    );
    await pool!.query(
      `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, message_id, sent_at, attempts)
       VALUES ('dlv-d', 'proj-000', 'rep-d', 'discussion_report', '-100999', 4242, now(), 1)`
    );

    const detail = await readProjectDetail(pool!, { projectId: 'proj-000' });
    expect(detail).not.toBeNull();
    expect(detail!.project.projectId).toBe('proj-000');
    expect(detail!.reports[0]).toMatchObject({ kind: 'standard', model: 'grok-4.3' });
    expect(detail!.reports[0]?.generatedAtMissing).toBe(false);
    expect(detail!.deliveries[0]).toMatchObject({ purpose: 'discussion_report', messageId: 4242 });
    expect(detail!.links.discussion).toBe('https://t.me/c/999/4242');
    expect(detail!.timeline[0]).toMatchObject({ reasonCode: 'PUSHED', title: 'Alice 关注了 Project' });
    expect(detail!.latestConfigVersionId).toBe('cfg-1');
  });

  itDb('历史导入的报告没有生成时间时如实标注，不用导入时间冒充', async () => {
    await seedProjects(1);
    await pool!.query(
      `INSERT INTO reports (report_id, project_id, kind, body, generated_at, triggered_by, report_generated_at_missing)
       VALUES ('rep-old', 'proj-000', 'standard', '历史正文', now(), 'natural', true)`
    );
    const detail = await readProjectDetail(pool!, { projectId: 'proj-000' });
    expect(detail!.reports[0]).toMatchObject({ generatedAt: null, generatedAtMissing: true });
  });

  it('消息链接只对可推导的内部频道 ID 生成', () => {
    expect(buildTelegramLink('-1003903535780', 5621)).toBe('https://t.me/c/3903535780/5621');
    expect(buildTelegramLink('12345', 1)).toBeNull();
    // -100 开头的 ID 都可以推导（与旧实现 buildTelegramChannelMessageUrl 一致）。
    expect(buildTelegramLink('-100999', 1)).toBe('https://t.me/c/999/1');
    expect(buildTelegramLink(null, 1)).toBeNull();
    expect(buildTelegramLink('-1003903535780', null)).toBeNull();
  });
});

describe('运行指标增量计数（M5 实测瓶颈修复）', () => {
  async function readCounter(key: string): Promise<number | null> {
    const result = await pool!.query(`SELECT value FROM runtime_counters WHERE counter_key = $1`, [key]);
    const value = result.rows[0]?.value;
    return value === undefined || value === null ? null : Number(value);
  }

  /** 用与真实数据相同的方式插入事件与判定（触发器应自动维护计数）。 */
  async function insertEventWithDecision(eventId: string): Promise<void> {
    // 判定记录引用项目，先确保夹具项目存在（本用例级别的 beforeEach 会重建 schema）。
    await pool!.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state, star)
       VALUES ('proj-000', 'account000', 'natural', 'monitored', 0) ON CONFLICT DO NOTHING`
    );
    await pool!.query(
      `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload)
       VALUES ($1, 'counter-collector', $2, now(), '{}')`,
      [eventId, Math.floor(Math.random() * 1_000_000)]
    );
    await pool!.query(
      `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at)
       VALUES ($1, $2, 'proj-000', 'account000', 'BELOW_THRESHOLD', now())`,
      [`dec-${eventId}`, eventId]
    );
  }

  itDb('插入事件与判定后计数与真实行数一致', async () => {
    await insertEventWithDecision('counter-1');
    await insertEventWithDecision('counter-2');

    const real = await pool!.query(
      `SELECT (SELECT count(*)::int FROM inbound_events) AS events,
              (SELECT count(*)::int FROM decisions) AS decisions`
    );
    expect(await readCounter('inbound_events')).toBe(real.rows[0]?.events);
    expect(await readCounter('decisions')).toBe(real.rows[0]?.decisions);
  });

  itDb('删除后计数同步下降，不会出现负数', async () => {
    await insertEventWithDecision('counter-del');
    const before = await readCounter('inbound_events');

    await pool!.query(`DELETE FROM decisions WHERE decision_id = 'dec-counter-del'`);
    await pool!.query(`DELETE FROM inbound_events WHERE event_id = 'counter-del'`);

    expect(await readCounter('inbound_events')).toBe((before ?? 1) - 1);
    expect(await readCounter('decisions')).toBe(0);
  });

  itDb('健康快照读取计数表而不是全表扫描', async () => {
    for (let index = 0; index < 5; index += 1) await insertEventWithDecision(`counter-health-${index}`);
    const health = await readHealthSnapshot(pool!);
    const real = await pool!.query(
      `SELECT (SELECT count(*)::int FROM inbound_events) AS events,
              (SELECT count(*)::int FROM decisions) AS decisions`
    );
    expect(health.inboundEvents).toBe(real.rows[0]?.events);
    expect(health.decisions).toBe(real.rows[0]?.decisions);
  });
});
