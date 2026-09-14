import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import {
  claimJobs,
  heartbeatJob,
  markJobDeadLetter,
  markJobFailed,
  markJobSucceeded,
  markJobWaitingDependency,
  readJobQueueMetrics,
  reclaimExpiredLeases
} from '../src/storage/job-queue.js';

/**
 * 任务队列租约语义：需要真实 PostgreSQL；不可用时全部跳过。
 * 覆盖验收方案 F1（重复领取）与 F3（过期执行者覆盖新结果）。
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
  await pool!.query('TRUNCATE jobs, projects, inbound_events RESTART IDENTITY CASCADE');
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, source, pool_state, star)
     VALUES ('proj-1', 'projectone', 'natural', 'monitored', 1)`
  );
});

afterAll(async () => {
  if (pool) await pool.close();
});

/** 建立一条待执行任务，返回 job_id。 */
async function insertJob(
  jobId: string,
  options: { kind?: string; stage?: string; triggeredBy?: string; createdAt?: string } = {}
): Promise<void> {
  await pool!.query(
    `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by, created_at)
     VALUES ($1, $2, 'proj-1', $3, $4, COALESCE($5::timestamptz, now()))`,
    [jobId, options.kind ?? 'classification', options.stage ?? 'queued', options.triggeredBy ?? 'natural', options.createdAt ?? null]
  );
}

describe('任务领取与租约', () => {
  itDb('领取任务会自增尝试次数与执行代次，并写入持有者', async () => {
    await insertJob('job-1');
    const claimed = await claimJobs(pool!, { owner: 'worker-A' });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      jobId: 'job-1',
      stage: 'running',
      attempts: 1,
      leaseGeneration: 1,
      leaseOwner: 'worker-A'
    });
    expect(claimed[0]?.leaseExpiresAt).not.toBeNull();
  });

  itDb('同一任务不会被两个 worker 同时领取（F1）', async () => {
    await insertJob('job-1');
    const [first, second] = await Promise.all([
      claimJobs(pool!, { owner: 'worker-A' }),
      claimJobs(pool!, { owner: 'worker-B' })
    ]);
    const owners = [...first, ...second].map((job) => job.leaseOwner);
    expect(owners).toHaveLength(1);
    // 只有一个持有者拿到任务，另一个空手而归
    expect([first.length, second.length].sort()).toEqual([0, 1]);
  });

  itDb('按创建时间先到先得，且 limit 生效', async () => {
    await insertJob('job-old', { createdAt: '2026-09-14T00:00:00.000Z' });
    await insertJob('job-new', { createdAt: '2026-09-14T01:00:00.000Z' });
    const claimed = await claimJobs(pool!, { owner: 'worker-A', limit: 2 });
    expect(claimed.map((job) => job.jobId)).toEqual(['job-old', 'job-new']);
  });

  itDb('未到退避时间的任务不会被领取', async () => {
    await insertJob('job-backoff');
    await pool!.query(
      `UPDATE jobs SET stage = 'failed', next_attempt_at = now() + interval '10 minutes' WHERE job_id = 'job-backoff'`
    );
    const claimed = await claimJobs(pool!, { owner: 'worker-A' });
    expect(claimed).toHaveLength(0);

    const due = await claimJobs(pool!, { owner: 'worker-A', now: new Date(Date.now() + 11 * 60 * 1000) });
    expect(due.map((job) => job.jobId)).toEqual(['job-backoff']);
  });

  itDb('可按任务类型过滤领取', async () => {
    await insertJob('job-standard', { kind: 'classification' });
    await insertJob('job-deep', { kind: 'deep' });
    const claimed = await claimJobs(pool!, { owner: 'worker-A', kinds: ['deep'] });
    expect(claimed.map((job) => job.jobId)).toEqual(['job-deep']);
  });
});

describe('续租与结果提交的代次校验', () => {
  itDb('持有者可以续租，非持有者不能', async () => {
    await insertJob('job-1');
    const [job] = await claimJobs(pool!, { owner: 'worker-A' });
    const renewed = await heartbeatJob(pool!, {
      jobId: 'job-1',
      owner: 'worker-A',
      generation: job!.leaseGeneration,
      leaseMs: 60_000
    });
    expect(renewed.renewed).toBe(true);

    const stolen = await heartbeatJob(pool!, { jobId: 'job-1', owner: 'worker-B', generation: job!.leaseGeneration });
    expect(stolen.renewed).toBe(false);
  });

  itDb('成功提交必须匹配持有者与代次', async () => {
    await insertJob('job-1');
    const [job] = await claimJobs(pool!, { owner: 'worker-A' });

    const wrongOwner = await markJobSucceeded(pool!, {
      jobId: 'job-1',
      owner: 'worker-B',
      generation: job!.leaseGeneration
    });
    expect(wrongOwner).toMatchObject({ applied: false, rejection: 'not_owner' });

    const ok = await markJobSucceeded(pool!, {
      jobId: 'job-1',
      owner: 'worker-A',
      generation: job!.leaseGeneration
    });
    expect(ok).toMatchObject({ applied: true, rejection: null });

    const row = await pool!.query(`SELECT stage, finished_at, lease_owner FROM jobs WHERE job_id = 'job-1'`);
    expect(row.rows[0]?.stage).toBe('succeeded');
    expect(row.rows[0]?.finished_at).not.toBeNull();
    expect(row.rows[0]?.lease_owner).toBeNull();
  });

  itDb('租约过期后新执行者接管，旧代次无法覆盖新结果（F3）', async () => {
    await insertJob('job-1');
    const [first] = await claimJobs(pool!, { owner: 'worker-A', leaseMs: 1000 });

    // 租约过期 → 回收
    const reclaimed = await reclaimExpiredLeases(pool!, { now: new Date(Date.now() + 2000) });
    expect(reclaimed.reclaimed).toEqual(['job-1']);
    const afterReclaim = await pool!.query(`SELECT stage, lease_owner, lease_expires_at FROM jobs WHERE job_id = 'job-1'`);
    expect(afterReclaim.rows[0]).toMatchObject({ stage: 'failed', lease_owner: null, lease_expires_at: null });

    // 新执行者接管：代次继续自增（回收把 next_attempt_at 设为回收时刻，需在到点后领取）
    const [second] = await claimJobs(pool!, { owner: 'worker-B', now: new Date(Date.now() + 5000) });
    expect(second).toMatchObject({ leaseOwner: 'worker-B', leaseGeneration: first!.leaseGeneration + 1 });

    // 旧执行者带着旧代次提交 → 必须被拒绝，不能覆盖新结果
    const stale = await markJobSucceeded(pool!, {
      jobId: 'job-1',
      owner: 'worker-A',
      generation: first!.leaseGeneration
    });
    expect(stale).toMatchObject({ applied: false, rejection: 'not_owner' });

    // 即便持有者名相同，只要代次过期也必须被拒绝
    const staleSameOwner = await markJobSucceeded(pool!, {
      jobId: 'job-1',
      owner: 'worker-B',
      generation: first!.leaseGeneration
    });
    expect(staleSameOwner).toMatchObject({ applied: false, rejection: 'stale_generation' });

    const stillRunning = await pool!.query(`SELECT stage FROM jobs WHERE job_id = 'job-1'`);
    expect(stillRunning.rows[0]?.stage).toBe('running');
  });
});

describe('失败、等待依赖与死信', () => {
  itDb('可恢复失败进入带退避的等待，并释放租约', async () => {
    await insertJob('job-1');
    const [job] = await claimJobs(pool!, { owner: 'worker-A' });
    const nextAttemptAt = new Date(Date.now() + 30_000).toISOString();
    const result = await markJobFailed(pool!, {
      jobId: 'job-1',
      owner: 'worker-A',
      generation: job!.leaseGeneration,
      error: 'model timeout',
      nextAttemptAt
    });
    expect(result.applied).toBe(true);

    const row = await pool!.query(`SELECT stage, last_error, lease_owner, next_attempt_at FROM jobs WHERE job_id = 'job-1'`);
    expect(row.rows[0]).toMatchObject({ stage: 'failed', last_error: 'model timeout', lease_owner: null });
    expect(row.rows[0]?.next_attempt_at).not.toBeNull();

    // 退避期内不被领取
    expect(await claimJobs(pool!, { owner: 'worker-B' })).toHaveLength(0);
  });

  itDb('等待依赖不占用租约，条件满足后可重新领取', async () => {
    await insertJob('job-1');
    const [job] = await claimJobs(pool!, { owner: 'worker-A' });
    const waiting = await markJobWaitingDependency(pool!, {
      jobId: 'job-1',
      owner: 'worker-A',
      generation: job!.leaseGeneration,
      reason: 'discussion mapping pending'
    });
    expect(waiting.applied).toBe(true);

    const row = await pool!.query(`SELECT stage, lease_owner, lease_expires_at, finished_at FROM jobs WHERE job_id = 'job-1'`);
    expect(row.rows[0]).toMatchObject({ stage: 'waiting_dependency', lease_owner: null, lease_expires_at: null });
    expect(row.rows[0]?.finished_at).not.toBeNull();

    // 等待依赖不是可领取状态（由调用方在依赖就绪时置回 queued）
    expect(await claimJobs(pool!, { owner: 'worker-B' })).toHaveLength(0);
  });

  itDb('死信是终态且不再被领取', async () => {
    await insertJob('job-1');
    const [job] = await claimJobs(pool!, { owner: 'worker-A' });
    await markJobDeadLetter(pool!, {
      jobId: 'job-1',
      owner: 'worker-A',
      generation: job!.leaseGeneration,
      error: '预算耗尽'
    });
    await pool!.query(`UPDATE jobs SET next_attempt_at = NULL WHERE job_id = 'job-1'`);
    expect(await claimJobs(pool!, { owner: 'worker-B' })).toHaveLength(0);

    const row = await pool!.query(`SELECT stage, last_error FROM jobs WHERE job_id = 'job-1'`);
    expect(row.rows[0]).toMatchObject({ stage: 'dead_letter', last_error: '预算耗尽' });
  });
});

describe('运行状态指标（Q101）', () => {
  itDb('统计各阶段数量与最久等待时长', async () => {
    await insertJob('job-queued-old', { createdAt: '2026-09-14T00:00:00.000Z' });
    await insertJob('job-queued-new', { createdAt: '2026-09-14T01:00:00.000Z' });
    await insertJob('job-dead', { stage: 'dead_letter' });

    const now = new Date('2026-09-14T02:00:00.000Z');
    const metrics = await readJobQueueMetrics(pool!, now);
    expect(metrics).toMatchObject({ queued: 2, deadLetter: 1, running: 0, failed: 0 });
    // 最久等待 = now - 最早入队时间 = 2 小时
    expect(metrics.oldestWaitMs).toBe(2 * 60 * 60 * 1000);
  });

  itDb('队列为空时最久等待为 null', async () => {
    const metrics = await readJobQueueMetrics(pool!);
    expect(metrics).toMatchObject({ queued: 0, running: 0, failed: 0, deadLetter: 0 });
    expect(metrics.oldestWaitMs).toBeNull();
  });
});
