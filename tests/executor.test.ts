import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import { runExecutorRound, isPermanentDeliveryError } from '../src/worker/executor.js';
import { enqueueDelivery, claimPendingDeliveries, readDeliveryBacklog } from '../src/storage/delivery-repository.js';
import { findReport, saveReport } from '../src/storage/report-repository.js';
import { claimJobs } from '../src/storage/job-queue.js';

/**
 * 生成/投递解耦执行器（Q5、Q55、F4）集成测试：需要真实 PostgreSQL；不可用时跳过。
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
  await pool!.query('TRUNCATE projects, jobs, reports, delivery_records, decisions, inbound_events, audit_records RESTART IDENTITY CASCADE');
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, source, pool_state, star)
     VALUES ('proj-exec', 'execproject', 'natural', 'monitored', 1)`
  );
});

afterAll(async () => {
  if (pool) await pool.close();
});

async function seedJob(jobId: string, kind = 'standard', triggeredBy = 'natural'): Promise<void> {
  await pool!.query(
    `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by) VALUES ($1, $2, 'proj-exec', 'queued', $3)`,
    [jobId, kind, triggeredBy]
  );
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    pool: pool!,
    owner: 'worker-1',
    generate: async () => ({
      body: '七章分析正文',
      model: 'grok-4.3',
      promptVersion: 'v1',
      generatedAt: '2026-09-14T00:00:00.000Z',
      triggeredBy: 'natural' as const
    }),
    send: vi.fn().mockResolvedValue({ chatId: '-100999', messageId: 888 }),
    discussionChatId: '-100999',
    ...overrides
  } as Parameters<typeof runExecutorRound>[0];
}

describe('生成执行', () => {
  itDb('任务生成报告并登记讨论群投递意图', async () => {
    await seedJob('job-1');
    const result = await runExecutorRound(makeOptions());

    expect(result.jobsSucceeded).toBe(1);
    const report = await findReport(pool!, { projectId: 'proj-exec', kind: 'standard' });
    expect(report?.body).toBe('七章分析正文');
    expect(report?.model).toBe('grok-4.3');

    const deliveries = await pool!.query(`SELECT purpose, report_id FROM delivery_records WHERE project_id = 'proj-exec'`);
    expect(deliveries.rows).toHaveLength(1);
    expect(deliveries.rows[0]?.purpose).toBe('discussion_report');

    const job = await pool!.query(`SELECT stage, lease_owner FROM jobs WHERE job_id = 'job-1'`);
    expect(job.rows[0]).toMatchObject({ stage: 'succeeded', lease_owner: null });
  });

  itDb('正文已保存时复用，不再调用模型（F4）', async () => {
    await saveReport(pool!, {
      projectId: 'proj-exec',
      kind: 'standard',
      triggerEventId: null,
      model: 'grok-4.3',
      promptVersion: 'v1',
      body: '已保存的正文',
      generatedAt: '2026-09-14T00:00:00.000Z',
      triggeredBy: 'natural'
    });
    await seedJob('job-again');

    const generate = vi.fn();
    const result = await runExecutorRound(makeOptions({ generate }));

    expect(result.jobsSucceeded).toBe(1);
    expect(generate).not.toHaveBeenCalled();
    const report = await findReport(pool!, { projectId: 'proj-exec', kind: 'standard' });
    expect(report?.body).toBe('已保存的正文');
  });

  itDb('生成未就绪时进入等待依赖，不消耗失败重试', async () => {
    await seedJob('job-pending');
    const result = await runExecutorRound(
      makeOptions({ generate: async () => ({ notReady: true }) as never })
    );

    expect(result.jobsWaiting).toBe(1);
    expect(result.jobsFailed).toBe(0);
    const job = await pool!.query(`SELECT stage, attempts, lease_owner FROM jobs WHERE job_id = 'job-pending'`);
    expect(job.rows[0]).toMatchObject({ stage: 'waiting_dependency', attempts: 1, lease_owner: null });
  });

  itDb('未配置生成器（影子模式）不产生报告与投递', async () => {
    await seedJob('job-shadow');
    const result = await runExecutorRound(makeOptions({ generate: undefined }));

    expect(result.jobsWaiting).toBe(1);
    expect(await findReport(pool!, { projectId: 'proj-exec', kind: 'standard' })).toBeNull();
    const deliveries = await pool!.query(`SELECT count(*)::int AS c FROM delivery_records`);
    expect(deliveries.rows[0]?.c).toBe(0);
  });
});

describe('投递执行', () => {
  itDb('投递只读取已保存正文，成功后记录消息引用与真实发送次数', async () => {
    const saved = await saveReport(pool!, {
      projectId: 'proj-exec',
      kind: 'standard',
      triggerEventId: null,
      model: null,
      promptVersion: null,
      body: '投递时使用的正文',
      generatedAt: '2026-09-14T00:00:00.000Z',
      triggeredBy: 'natural'
    });
    await enqueueDelivery(pool!, {
      projectId: 'proj-exec',
      reportId: saved.reportId,
      purpose: 'discussion_report',
      targetChatId: '-100999'
    });

    const send = vi.fn().mockResolvedValue({ chatId: '-100999', messageId: 999 });
    const result = await runExecutorRound(makeOptions({ send }));

    expect(result.deliveriesSent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    // 只把正文交给投递，不重新生成
    expect(send.mock.calls[0]?.[1]).toBe('投递时使用的正文');

    const row = await pool!.query(
      `SELECT message_id, sent_at, attempts, uncertain FROM delivery_records WHERE project_id = 'proj-exec'`
    );
    expect(row.rows[0]).toMatchObject({ message_id: '999', uncertain: false, attempts: 1 });
    expect(row.rows[0]?.sent_at).not.toBeNull();

    const project = await pool!.query(`SELECT confirmed_send_count FROM projects WHERE project_id = 'proj-exec'`);
    expect(project.rows[0]?.confirmed_send_count).toBe(1);
  });

  itDb('投递失败按退避重试，预算耗尽后放弃并告警', async () => {
    await enqueueDelivery(pool!, {
      projectId: 'proj-exec',
      reportId: null,
      purpose: 'channel_main',
      targetChatId: '-100123'
    });

    const send = vi.fn().mockRejectedValue(new Error('telegram 503'));
    const first = await runExecutorRound(makeOptions({ send }));
    expect(first.deliveriesFailed).toBe(1);
    expect(first.deliveriesAbandoned).toBe(0);

    const row = await pool!.query(`SELECT attempts, last_error, abandoned, next_attempt_at FROM delivery_records`);
    expect(row.rows[0]).toMatchObject({ attempts: 1, last_error: 'telegram 503', abandoned: false });
    expect(row.rows[0]?.next_attempt_at).not.toBeNull();

    // 把尝试次数推到上限，再失败一次即放弃
    await pool!.query(`UPDATE delivery_records SET attempts = 20, next_attempt_at = NULL`);
    const exhausted = await runExecutorRound(makeOptions({ send }));
    expect(exhausted.deliveriesAbandoned).toBe(1);
    const abandoned = await pool!.query(`SELECT abandoned, next_attempt_at FROM delivery_records`);
    expect(abandoned.rows[0]).toMatchObject({ abandoned: true, next_attempt_at: null });
  });

  itDb('永久错误不再重试，但保留记录供人工修复后重放（F7）', async () => {
    await enqueueDelivery(pool!, {
      projectId: 'proj-exec',
      reportId: null,
      purpose: 'channel_main',
      targetChatId: '-100123'
    });
    const send = vi.fn().mockRejectedValue(new Error('Bad Request: chat not found'));
    const result = await runExecutorRound(makeOptions({ send }));

    expect(result.deliveriesAbandoned).toBe(1);
    const backlog = await readDeliveryBacklog(pool!);
    expect(backlog.abandoned).toBe(1);
    expect(backlog.pending).toBe(0);

    // 记录仍在，人工可以重放
    const row = await pool!.query(`SELECT delivery_id, last_error FROM delivery_records`);
    expect(row.rows).toHaveLength(1);
    expect(String(row.rows[0]?.last_error)).toContain('chat not found');
  });

  itDb('无报告关联的投递（如频道主消息）正文为 null，也能正常发送', async () => {
    await enqueueDelivery(pool!, {
      projectId: 'proj-exec',
      reportId: null,
      purpose: 'channel_main',
      targetChatId: '-100123'
    });
    const send = vi.fn().mockResolvedValue({ chatId: '-100123', messageId: 555 });
    const result = await runExecutorRound(makeOptions({ send }));

    expect(result.deliveriesSent).toBe(1);
    // 频道主消息不需要报告正文
    expect(send.mock.calls[0]?.[1]).toBeNull();
  });

  itDb('投递意图登记是幂等的：同目标同报告不产生第二条', async () => {
    const first = await enqueueDelivery(pool!, {
      projectId: 'proj-exec',
      reportId: null,
      purpose: 'channel_main',
      targetChatId: '-100123'
    });
    const second = await enqueueDelivery(pool!, {
      projectId: 'proj-exec',
      reportId: null,
      purpose: 'channel_main',
      targetChatId: '-100123'
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.deliveryId).toBe(first.deliveryId);
  });

  itDb('投递领取计入尝试次数，且已送达不再被领取', async () => {
    await enqueueDelivery(pool!, {
      projectId: 'proj-exec',
      reportId: null,
      purpose: 'channel_main',
      targetChatId: '-100123'
    });
    const claimed = await claimPendingDeliveries(pool!, { limit: 5 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempts).toBe(1);

    await pool!.query(`UPDATE delivery_records SET sent_at = now(), message_id = 1`);
    expect(await claimPendingDeliveries(pool!, { limit: 5 })).toHaveLength(0);
  });
});

describe('永久错误识别', () => {
  it('识别常见的不可重试错误', () => {
    expect(isPermanentDeliveryError('Bad Request: chat not found')).toBe(true);
    expect(isPermanentDeliveryError('Forbidden: bot was blocked by the user')).toBe(true);
    expect(isPermanentDeliveryError('Bad Request: message thread not found')).toBe(true);
  });

  it('可恢复错误不误判为永久', () => {
    expect(isPermanentDeliveryError('telegram 503')).toBe(false);
    expect(isPermanentDeliveryError('ETIMEDOUT')).toBe(false);
    expect(isPermanentDeliveryError('Too Many Requests: retry after 30')).toBe(false);
  });
});

describe('执行器与租约协作', () => {
  itDb('过期租约在一轮开始时被回收，任务重新可领取', async () => {
    await seedJob('job-stale');
    // 手动占住租约并让它过期
    await pool!.query(
      `UPDATE jobs SET stage = 'running', lease_owner = 'worker-dead', lease_generation = 1,
                        lease_expires_at = now() - interval '1 minute' WHERE job_id = 'job-stale'`
    );

    const result = await runExecutorRound(makeOptions({ generate: undefined }));
    expect(result.reclaimed).toContain('job-stale');
    expect(result.jobsClaimed).toBe(1);
    const job = await pool!.query(`SELECT stage, lease_generation FROM jobs WHERE job_id = 'job-stale'`);
    expect(Number(job.rows[0]?.lease_generation)).toBe(2);
  });
});
