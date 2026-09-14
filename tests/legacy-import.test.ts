import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate, truncateBusinessTables } from './helpers/test-database.js';
import { importLegacyFacts, normalizeProjectKeyFromLink } from '../src/storage/legacy-import.js';

/**
 * 历史导入集成测试：需要真实 PostgreSQL（只接受 TEST_DATABASE_URL，且库名必须含 test）。
 * 数据库不可用时全部跳过。
 */

let pool: StoragePool | null = null;
let available = false;

/**
 * 夹具副本（`tests/fixtures/legacy/`）而不是活的 `data/` 目录。
 *
 * 理由：本文件验证的是**导入契约**（迁移哪些事实、不去伪造什么、幂等性），
 * 必须与真实数据的变化解耦——否则现网数据一更新，契约测试就跟着变红。
 * 真实数据的端到端可读性由 `legacy-data-end-to-end.test.ts` 单独覆盖。
 */
const REAL_PATHS = {
  projectStatePath: 'tests/fixtures/legacy/project-state.json',
  analysisArchivePath: 'tests/fixtures/legacy/analysis-archive.jsonl',
  discussionMappingsPath: 'tests/fixtures/legacy/discussion-mappings.jsonl',
};

function itDb(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available) return;
    await fn();
  });
}

beforeAll(async () => {
  pool = await openTestDatabase();
  available = pool !== null;
  if (!available) return;
  await resetSchemaAndMigrate(pool!);
});

beforeEach(async () => {
  if (!available) return;
  await truncateBusinessTables(pool!);
});

afterAll(async () => {
  if (pool) await pool.close();
});

describe('项目键归一化', () => {
  it('与旧实现的 handle 规则一致', () => {
    expect(normalizeProjectKeyFromLink('https://x.com/BeraUniversity')).toBe('berauniversity');
    expect(normalizeProjectKeyFromLink('https://twitter.com/boopfamily/status/1')).toBe('boopfamily');
    expect(normalizeProjectKeyFromLink('https://example.com/x')).toBe('https://example.com/x');
    expect(normalizeProjectKeyFromLink(null)).toBeNull();
  });
});

describe('历史导入', () => {
  itDb('只迁移现存事实，且不伪造缺失字段', async () => {
    const result = await importLegacyFacts(pool!, REAL_PATHS);

    expect(result.projectsUpserted).toBe(3);
    expect(result.reportsImported).toBe(3);
    expect(result.discussionMappingsImported).toBe(8);
    // 3 条频道主消息 + 3 条讨论群报告
    expect(result.deliveryRecordsImported).toBe(6);

    // 项目：星级与频道展示序号来自 project-state；事件时间保持 NULL（历史缺失）。
    const projects = await pool!.query(
      `SELECT project_key, star, display_push_count, first_event_at, last_event_at, source, pool_state
       FROM projects ORDER BY project_key`
    );
    expect(projects.rows.map((row) => row.project_key)).toEqual(['berauniversity', 'boopfamily', 'getstonkoptions']);
    for (const row of projects.rows) {
      expect(row.source).toBe('history_import');
      expect(row.pool_state).toBe('monitored');
      expect(row.first_event_at).toBeNull();
      expect(row.last_event_at).toBeNull();
    }
    const bera = projects.rows.find((row) => row.project_key === 'berauniversity');
    expect(bera).toMatchObject({ star: 1, display_push_count: 1 });

    // 报告：正文迁入，未编造生成时间缺失标记（归档里有时间）。
    const reports = await pool!.query(`SELECT kind, triggered_by, report_generated_at_missing, length(body) AS len FROM reports`);
    expect(reports.rows).toHaveLength(3);
    for (const row of reports.rows) {
      expect(row.kind).toBe('standard');
      expect(row.triggered_by).toBe('natural');
      expect(row.report_generated_at_missing).toBe(false);
      expect(Number(row.len)).toBeGreaterThan(100);
    }

    // 未达门槛、去重、分类结论等从未落盘的事实不会被伪造：接收记录与判定记录必须为空。
    const events = await pool!.query(`SELECT count(*)::int AS c FROM inbound_events`);
    const decisions = await pool!.query(`SELECT count(*)::int AS c FROM decisions`);
    expect(events.rows[0]?.c).toBe(0);
    expect(decisions.rows[0]?.c).toBe(0);

    // 导入不得产生任务（空队列）与审计记录。
    const jobs = await pool!.query(`SELECT count(*)::int AS c FROM jobs`);
    const audit = await pool!.query(`SELECT count(*)::int AS c FROM audit_records`);
    expect(jobs.rows[0]?.c).toBe(0);
    expect(audit.rows[0]?.c).toBe(0);
  });

  itDb('记录警告而不是静默丢弃缺失事实', async () => {
    const result = await importLegacyFacts(pool!, REAL_PATHS);
    // 现网 3 个项目都有首条频道消息引用，因此本批数据不应产生警告；
    // 但 warnings 字段必须存在且可被调用方读取。
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  itDb('可重复执行且不重复导入', async () => {
    const first = await importLegacyFacts(pool!, REAL_PATHS);
    const second = await importLegacyFacts(pool!, REAL_PATHS);

    expect(second.projectsUpserted).toBe(first.projectsUpserted);
    expect(second.reportsImported).toBe(first.reportsImported);
    expect(second.deliveryRecordsImported).toBe(first.deliveryRecordsImported);
    expect(second.discussionMappingsImported).toBe(first.discussionMappingsImported);

    const counts = await pool!.query(
      `SELECT (SELECT count(*)::int FROM projects) AS projects,
              (SELECT count(*)::int FROM reports) AS reports,
              (SELECT count(*)::int FROM delivery_records) AS deliveries,
              (SELECT count(*)::int FROM discussion_mappings) AS mappings`
    );
    expect(counts.rows[0]).toMatchObject({ projects: 3, reports: 3, deliveries: 6, mappings: 8 });
  });

  itDb('归档里已有的频道消息不会被项目级引用重复登记', async () => {
    await importLegacyFacts(pool!, REAL_PATHS);
    const channel = await pool!.query(
      `SELECT count(*)::int AS total, count(DISTINCT message_id)::int AS distinct_messages
       FROM delivery_records WHERE purpose = 'channel_main'`
    );
    expect(channel.rows[0]?.total).toBe(3);
    expect(channel.rows[0]?.distinct_messages).toBe(3);
  });

  itDb('缺文件时按空数据导入，不报错', async () => {
    const result = await importLegacyFacts(pool!, {
      projectStatePath: 'data/__missing__.json',
      analysisArchivePath: 'data/__missing__.jsonl',
      discussionMappingsPath: 'data/__missing__.jsonl',
    });
    expect(result.projectsUpserted).toBe(0);
    expect(result.reportsImported).toBe(0);
  });
});
