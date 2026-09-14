import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import { DEFAULT_RETENTION_DAYS, cleanupExpiredEvents } from '../src/storage/retention-cleanup.js';

/**
 * 保留策略清理（第 5 节、F10）集成测试：需要真实 PostgreSQL；不可用时跳过。
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
  await pool!.query(
    'TRUNCATE projects, inbound_events, decisions, reports, delivery_records, jobs RESTART IDENTITY CASCADE'
  );
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, source, pool_state, star)
     VALUES ('p1', 'accountone', 'natural', 'monitored', 3)`
  );
});

afterAll(async () => {
  if (pool) await pool.close();
});

async function seedEvent(eventId: string, daysAgo: number, reasonCode = 'PUSHED'): Promise<void> {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  await pool!.query(
    `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload)
     VALUES ($1, 'c', $2, $3::timestamptz, '{}')`,
    [eventId, Math.floor(Math.random() * 100000), at]
  );
  await pool!.query(
    `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at)
     VALUES ($1, $2, 'p1', 'accountone', $3, $4::timestamptz)`,
    [`dec-${eventId}`, eventId, reasonCode, at]
  );
}

describe('保留期清理', () => {
  itDb('默认保留 90 天', async () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
  });

  itDb('删除过期接收记录与判定记录，保留未过期数据', async () => {
    await seedEvent('old-1', 120);
    await seedEvent('old-2', 95);
    await seedEvent('fresh-1', 89);
    await seedEvent('fresh-2', 1);

    const result = await cleanupExpiredEvents(pool!, { batchSize: 10 });
    expect(result.deletedEvents).toBe(2);
    expect(result.deletedDecisions).toBe(2);
    expect(result.hasMore).toBe(false);

    const remaining = await pool!.query(
      `SELECT (SELECT count(*)::int FROM inbound_events) AS events,
              (SELECT count(*)::int FROM decisions) AS decisions`
    );
    expect(remaining.rows[0]).toMatchObject({ events: 2, decisions: 2 });
  });

  itDb('长期报告不被级联删除，触发事件引用被置空', async () => {
    await seedEvent('old-evt', 120);
    await pool!.query(
      `INSERT INTO reports (report_id, project_id, kind, body, generated_at, triggered_by, trigger_event_id)
       VALUES ('rep-1', 'p1', 'standard', '长期正文', now(), 'natural', 'old-evt')`
    );
    await pool!.query(
      `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, shard_index)
       VALUES ('dlv-1', 'p1', 'rep-1', 'discussion_report', '-100', 1)`
    );

    await cleanupExpiredEvents(pool!, { batchSize: 10 });

    const row = await pool!.query(
      `SELECT (SELECT count(*)::int FROM reports) AS reports,
              (SELECT trigger_event_id FROM reports WHERE report_id = 'rep-1') AS trigger_event,
              (SELECT count(*)::int FROM delivery_records) AS deliveries`
    );
    expect(row.rows[0]).toMatchObject({ reports: 1, trigger_event: null, deliveries: 1 });
  });

  itDb('分批清理：maxBatches 限制单次工作量并报告还有剩余', async () => {
    for (let index = 0; index < 6; index += 1) await seedEvent(`old-${index}`, 100 + index);

    const first = await cleanupExpiredEvents(pool!, { batchSize: 2, maxBatches: 1 });
    expect(first.deletedEvents).toBe(2);
    expect(first.hasMore).toBe(true);

    const rest = await cleanupExpiredEvents(pool!, { batchSize: 10, maxBatches: 10 });
    expect(rest.deletedEvents).toBe(4);
    expect(rest.hasMore).toBe(false);
  });

  itDb('没有过期数据时是空操作', async () => {
    await seedEvent('fresh', 1);
    const result = await cleanupExpiredEvents(pool!);
    expect(result).toMatchObject({ deletedEvents: 0, deletedDecisions: 0, hasMore: false });
    const remaining = await pool!.query(`SELECT count(*)::int AS c FROM inbound_events`);
    expect(remaining.rows[0]?.c).toBe(1);
  });

  itDb('自定义保留天数生效', async () => {
    await seedEvent('old', 40);
    const noop = await cleanupExpiredEvents(pool!, { retentionDays: 90 });
    expect(noop.deletedEvents).toBe(0);
    const trimmed = await cleanupExpiredEvents(pool!, { retentionDays: 30 });
    expect(trimmed.deletedEvents).toBe(1);
  });
});
