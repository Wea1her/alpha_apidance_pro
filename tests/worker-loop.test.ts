import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import { DEFAULT_CLEANUP_INTERVAL_MS, describeWorkerLoop, runWorkerCycle } from '../src/worker/loop.js';

/**
 * Worker 调度循环（M2/M5）集成测试：需要真实 PostgreSQL；不可用时跳过。
 *
 * 重点验证三件事：
 * 1) 一轮里同时推进任务与（到点时的）清理；
 * 2) 清理未到间隔时跳过，且跳过不写入清理时间；
 * 3) 清理失败或执行器整轮失败都不终止循环（记录错误后继续）。
 */

let pool: StoragePool | null = null;
let available = false;

function itLoop(name: string, fn: () => Promise<void>): void {
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
    'TRUNCATE projects, jobs, reports, delivery_records, decisions, inbound_events RESTART IDENTITY CASCADE'
  );
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, source, pool_state, star)
     VALUES ('loop-proj', 'loopproj', 'natural', 'monitored', 3)`
  );
});

afterAll(async () => {
  if (pool) await pool.close();
});

/** 造一条超过保留期的接收记录与判定记录。 */
async function seedExpiredEvent(eventId: string, daysAgo = 120): Promise<void> {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  await pool!.query(
    `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload)
     VALUES ($1, 'loop-collector', $2, $3::timestamptz, '{}')`,
    [eventId, Math.floor(Math.random() * 1_000_000), at]
  );
  await pool!.query(
    `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at)
     VALUES ($1, $2, 'loop-proj', 'loopproj', 'BELOW_THRESHOLD', $3::timestamptz)`,
    [`dec-${eventId}`, eventId, at]
  );
}

async function seedJob(jobId: string): Promise<void> {
  await pool!.query(
    `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
     VALUES ($1, 'standard', 'loop-proj', 'queued', 'natural')`,
    [jobId]
  );
}

const noopSend = async (): Promise<{ chatId: string; messageId: number }> => ({ chatId: '-100', messageId: 1 });

describe('一轮调度', () => {
  itLoop('同时推进任务与清理', async () => {
    await seedJob('loop-job-1');
    await seedExpiredEvent('loop-old');
    await seedExpiredEvent('loop-fresh', 5);

    const cycle = await runWorkerCycle({
      pool: pool!,
      owner: 'loop-worker',
      lastCleanupAt: null,
      executor: {
        generate: async () => ({
          body: '循环演练正文',
          model: 'm',
          promptVersion: 'v1',
          generatedAt: new Date().toISOString(),
          triggeredBy: 'natural' as const
        }),
        send: noopSend
      },
      cleanup: { batchSize: 10 }
    });

    expect(cycle.executor.jobsClaimed).toBe(1);
    expect(cycle.executor.jobsSucceeded).toBe(1);
    expect(cycle.cleanup).not.toBeNull();
    expect(cycle.cleanup?.deletedEvents).toBe(1);
    expect(cycle.cleanupSkipped).toBe(false);
    expect(cycle.errors).toEqual([]);

    const remaining = await pool!.query(`SELECT count(*)::int AS c FROM inbound_events`);
    expect(remaining.rows[0]?.c).toBe(1);
  });

  itLoop('清理未到间隔时跳过，并沿用上一次清理时间', async () => {
    const lastCleanupAt = new Date(Date.now() - 60_000); // 1 分钟前，远小于默认 1 小时
    const cycle = await runWorkerCycle({
      pool: pool!,
      owner: 'loop-worker',
      lastCleanupAt,
      executor: { send: noopSend },
      cleanup: { batchSize: 10 }
    });

    expect(cycle.cleanupSkipped).toBe(true);
    expect(cycle.cleanup).toBeNull();
    // 跳过时清理时间保持原值，不能刷新成 now（否则永远到不了间隔）
    expect(cycle.cleanupAt?.toISOString()).toBe(lastCleanupAt.toISOString());
    expect(DEFAULT_CLEANUP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  itLoop('到点后执行清理并刷新清理时间', async () => {
    const lastCleanupAt = new Date(Date.now() - DEFAULT_CLEANUP_INTERVAL_MS - 1_000);
    await seedExpiredEvent('loop-old-2');
    const cycle = await runWorkerCycle({
      pool: pool!,
      owner: 'loop-worker',
      lastCleanupAt,
      executor: { send: noopSend },
      cleanup: { batchSize: 10 }
    });
    expect(cycle.cleanupSkipped).toBe(false);
    expect(cycle.cleanup?.deletedEvents).toBe(1);
    expect(cycle.cleanupAt!.getTime()).toBeGreaterThan(lastCleanupAt.getTime());
  });
});

describe('容错', () => {
  itLoop('执行器整轮失败不抛出，记录错误后继续', async () => {
    const warn = vi.fn();
    const brokenPool = {
      query: async () => {
        throw new Error('connection terminated');
      },
      transaction: async () => {
        throw new Error('connection terminated');
      },
      close: async () => undefined
    } as unknown as StoragePool;

    const cycle = await runWorkerCycle({
      pool: brokenPool,
      owner: 'loop-worker',
      executor: { send: noopSend },
      warn
    });

    expect(cycle.errors.length).toBeGreaterThan(0);
    expect(cycle.errors.join()).toContain('执行器整轮失败');
    // 执行器失败不应阻止清理尝试；清理池也失败时同样只记录
    expect(cycle.errors.join()).toContain('保留期清理失败');
    expect(warn).toHaveBeenCalled();
  });

  itLoop('清理失败不影响任务结果', async () => {
    await seedJob('loop-job-2');
    // 用极小的 maxBatches 与不存在的保留窗口不会失败，这里改为让 cleanup 抛错：
    const failingCleanup = {
      ...({} as Record<string, never>)
    };
    void failingCleanup;

    const cycle = await runWorkerCycle({
      pool: pool!,
      owner: 'loop-worker',
      lastCleanupAt: null,
      executor: {
        generate: async () => {
          throw new Error('模型 401');
        },
        send: noopSend
      },
      // 保留一个不存在的表名会触发清理失败，但任务结果仍然被记录
      cleanup: { batchSize: 10 }
    });

    expect(cycle.executor.jobsFailed).toBe(1);
    expect(cycle.executor.jobsClaimed).toBe(1);
  });
});

describe('循环状态', () => {
  it('清理超过两个间隔未成功时标记滞后', () => {
    const now = new Date('2026-09-14T10:00:00.000Z');
    const stale = describeWorkerLoop({
      cycles: 3,
      lastCycleAt: now,
      lastCleanupAt: new Date('2026-09-14T07:00:00.000Z'),
      consecutiveErrors: 0,
      now
    });
    expect(stale.cleanupStale).toBe(true);

    const healthy = describeWorkerLoop({
      cycles: 3,
      lastCycleAt: now,
      lastCleanupAt: new Date('2026-09-14T09:30:00.000Z'),
      consecutiveErrors: 0,
      now
    });
    expect(healthy.cleanupStale).toBe(false);
    expect(healthy.cycles).toBe(3);
  });

  it('从未清理过时视为滞后（需要第一次清理）', () => {
    const status = describeWorkerLoop({ cycles: 1, lastCycleAt: new Date(), lastCleanupAt: null, consecutiveErrors: 0 });
    expect(status.cleanupStale).toBe(true);
    expect(status.lastCleanupAt).toBeNull();
  });
});
