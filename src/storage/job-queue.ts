import type { StoragePool } from './client.js';
import type { JobKind, JobStage, ReasonCode } from '../../shared/domain.js';

/**
 * 任务队列：数据库行锁 + 到期租约 + 执行代次。
 *
 * 依据：第 5 节“任务领取使用数据库行锁与到期租约，记录持有者和执行代次；
 * 续租和结果提交都检查当前代次。网络请求不占用长数据库事务”、第 8.1 节初值
 * （租约 30 秒，每 10 秒续租）。
 *
 * 核心不变量：
 * - 同一任务同一时刻只有一个有效持有者；
 * - 每次领取让 lease_generation 自增，旧代次的写入一律被拒绝（F1、F3）；
 * - 租约过期表示执行者失联，可被其他 worker 接管；
 * - next_attempt_at 是主动退避，到点前任何 worker 都不应领取。
 */

export interface JobRow {
  jobId: string;
  kind: JobKind;
  projectId: string | null;
  triggerEventId: string | null;
  stage: JobStage;
  attempts: number;
  leaseGeneration: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  triggeredBy: 'natural' | 'restore';
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  lastErrorClass?: ReasonCode | null;
}

export interface ClaimOptions {
  owner: string;
  /** 租约时长（毫秒）；默认 30 秒。 */
  leaseMs?: number;
  /** 只在指定任务类型中领取。 */
  kinds?: readonly JobKind[];
  /** 每次领取的最大数量。 */
  limit?: number;
  now?: Date;
}

export interface HeartbeatResult {
  renewed: boolean;
  leaseExpiresAt: string | null;
}

export interface SettleResult {
  applied: boolean;
  /** 被拒绝的原因：代次过期、持有者不匹配或任务不存在。 */
  rejection: 'stale_generation' | 'not_owner' | 'not_found' | null;
}

const DEFAULT_LEASE_MS = 30_000;

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function mapRow(row: Record<string, unknown>): JobRow {
  return {
    jobId: String(row.job_id),
    kind: String(row.kind) as JobKind,
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    triggerEventId:
      row.trigger_event_id === null || row.trigger_event_id === undefined ? null : String(row.trigger_event_id),
    stage: String(row.stage) as JobStage,
    attempts: Number(row.attempts ?? 0),
    leaseGeneration: Number(row.lease_generation ?? 0),
    leaseOwner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
    leaseExpiresAt: toIso(row.lease_expires_at),
    triggeredBy: String(row.triggered_by) as 'natural' | 'restore',
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    nextAttemptAt: toIso(row.next_attempt_at),
  };
}

/**
 * 领取可执行任务：按创建时间先到先得，串行化在数据库层完成。
 *
 * 领取条件：阶段为 queued/failed，且（无退避或退避已到点）。
 * 每次领取 attempts+1、lease_generation+1，并写入持有者与到期时间。
 */
export async function claimJobs(pool: StoragePool, options: ClaimOptions): Promise<JobRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const limit = options.limit ?? 1;

  // 租约归属由“持有者 + 代次”共同确定：代次在领取时自增，旧代次立即失效。
  return pool.transaction(async (client) => {
    // 使用 FOR UPDATE SKIP LOCKED，避免两个 worker 抢同一条。
    const candidates = await client.query(
      `SELECT job_id FROM jobs
        WHERE stage IN ('queued', 'failed')
          AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz)
          AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
        ORDER BY created_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), options.kinds ? [...options.kinds] : null, limit]
    );

    const claimed: JobRow[] = [];
    for (const row of candidates.rows) {
      const updated = await client.query(
        `UPDATE jobs
            SET stage = 'running',
                attempts = attempts + 1,
                lease_generation = lease_generation + 1,
                lease_owner = $2,
                lease_expires_at = ($1::timestamptz + ($3::int * interval '1 millisecond')),
                started_at = COALESCE(started_at, $1::timestamptz),
                heartbeat_at = $1::timestamptz,
                updated_at = $1::timestamptz
          WHERE job_id = $4
          RETURNING *`,
        [now.toISOString(), options.owner, leaseMs, String(row.job_id)]
      );
      const mapped = updated.rows[0];
      if (mapped) claimed.push(mapRow(mapped));
    }
    return claimed;
  });
}

/** 续租：只有当前持有者能续，且续租会顺手延长到期时间。 */
export async function heartbeatJob(
  pool: StoragePool,
  input: { jobId: string; owner: string; generation: number; leaseMs?: number; now?: Date }
): Promise<HeartbeatResult> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const result = await pool.query(
    `UPDATE jobs
        SET lease_expires_at = ($1::timestamptz + ($2::int * interval '1 millisecond')),
            heartbeat_at = $1::timestamptz,
            updated_at = $1::timestamptz
      WHERE job_id = $3 AND lease_owner = $4 AND lease_generation = $5 AND stage = 'running'
      RETURNING lease_expires_at`,
    [now.toISOString(), leaseMs, input.jobId, input.owner, input.generation]
  );
  const row = result.rows[0];
  if (!row) return { renewed: false, leaseExpiresAt: null };
  return { renewed: true, leaseExpiresAt: toIso(row.lease_expires_at) };
}

/**
 * 结果提交：必须同时匹配持有者与代次，否则视为过期执行者，拒绝写入。
 */
async function settle(
  pool: StoragePool,
  input: {
    jobId: string;
    owner: string;
    generation: number;
    stage: JobStage;
    lastError?: string | null;
    nextAttemptAt?: string | null;
    now?: Date;
  }
): Promise<SettleResult> {
  const now = input.now ?? new Date();
  return pool.transaction(async (client) => {
    const current = await client.query(
      `SELECT job_id, lease_owner, lease_generation, stage FROM jobs WHERE job_id = $1 FOR UPDATE`,
      [input.jobId]
    );
    const row = current.rows[0];
    if (!row) return { applied: false, rejection: 'not_found' as const };
    if (String(row.lease_owner ?? '') !== input.owner) {
      return { applied: false, rejection: 'not_owner' as const };
    }
    // 代次必须完全一致：不一致说明任务已被其他执行者接管（F3）。
    if (Number(row.lease_generation ?? 0) !== input.generation) {
      return { applied: false, rejection: 'stale_generation' as const };
    }

    // 除“仍在运行”之外的状态都释放租约：
    // - succeeded / dead_letter：终态，不再执行；
    // - failed：可恢复失败，退避到点后由任意 worker 重新领取；
    // - waiting_dependency：等依赖满足后重新领取。
    const releasesLease = input.stage !== 'running';
    await client.query(
      `UPDATE jobs
          SET stage = $2,
              last_error = $3,
              next_attempt_at = $4::timestamptz,
              finished_at = CASE WHEN $5::boolean THEN $1::timestamptz ELSE finished_at END,
              lease_owner = CASE WHEN $5::boolean THEN NULL ELSE lease_owner END,
              lease_expires_at = CASE WHEN $5::boolean THEN NULL ELSE lease_expires_at END,
              updated_at = $1::timestamptz
        WHERE job_id = $6`,
      [
        now.toISOString(),
        input.stage,
        input.lastError ?? null,
        input.nextAttemptAt ?? null,
        releasesLease,
        input.jobId,
      ]
    );
    return { applied: true, rejection: null };
  });
}

export async function markJobSucceeded(
  pool: StoragePool,
  input: { jobId: string; owner: string; generation: number; now?: Date }
): Promise<SettleResult> {
  return settle(pool, { ...input, stage: 'succeeded' });
}

/** 可恢复失败：进入带退避的等待，租约释放，等待其他执行者后续领取。 */
export async function markJobFailed(
  pool: StoragePool,
  input: {
    jobId: string;
    owner: string;
    generation: number;
    error: string;
    nextAttemptAt?: string | null;
    now?: Date;
  }
): Promise<SettleResult> {
  return settle(pool, {
    jobId: input.jobId,
    owner: input.owner,
    generation: input.generation,
    stage: 'failed',
    lastError: input.error,
    nextAttemptAt: input.nextAttemptAt ?? null,
    now: input.now,
  });
}

/** 永久失败或预算耗尽：进入死信，不再自动重试，但保留完整历史。 */
export async function markJobDeadLetter(
  pool: StoragePool,
  input: { jobId: string; owner: string; generation: number; error: string; now?: Date }
): Promise<SettleResult> {
  return settle(pool, {
    jobId: input.jobId,
    owner: input.owner,
    generation: input.generation,
    stage: 'dead_letter',
    lastError: input.error,
    now: input.now,
  });
}

/** 等待依赖（如讨论映射未就绪）：既不消耗模型重试预算，也不占用租约。 */
export async function markJobWaitingDependency(
  pool: StoragePool,
  input: { jobId: string; owner: string; generation: number; reason: string; nextAttemptAt?: string | null; now?: Date }
): Promise<SettleResult> {
  return settle(pool, {
    jobId: input.jobId,
    owner: input.owner,
    generation: input.generation,
    stage: 'waiting_dependency',
    lastError: input.reason,
    nextAttemptAt: input.nextAttemptAt ?? null,
    now: input.now,
  });
}

/** 过期租约回收：把失联执行者的任务放回可领取状态。 */
export async function reclaimExpiredLeases(
  pool: StoragePool,
  options: { now?: Date; limit?: number } = {}
): Promise<{ reclaimed: string[] }> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  return pool.transaction(async (client) => {
    const expired = await client.query(
      `SELECT job_id FROM jobs
        WHERE stage = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1::timestamptz
        ORDER BY lease_expires_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), limit]
    );
    const reclaimed: string[] = [];
    for (const row of expired.rows) {
      const jobId = String(row.job_id);
      await client.query(
        `UPDATE jobs
            SET stage = 'failed',
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = COALESCE(last_error, '租约过期，执行者失联'),
                next_attempt_at = $1::timestamptz,
                updated_at = $1::timestamptz
          WHERE job_id = $2`,
        [now.toISOString(), jobId]
      );
      reclaimed.push(jobId);
    }
    return { reclaimed };
  });
}

export interface JobQueueMetrics {
  queued: number;
  running: number;
  failed: number;
  deadLetter: number;
  waitingDependency: number;
  /** 最久等待时长（毫秒）；队列为空为 null。 */
  oldestWaitMs: number | null;
}

/** 运行状态页需要的业务健康指标（Q101）。 */
export async function readJobQueueMetrics(pool: StoragePool, now = new Date()): Promise<JobQueueMetrics> {
  const counts = await pool.query(
    `SELECT stage, count(*)::int AS count, min(created_at) AS oldest
       FROM jobs
      WHERE stage IN ('queued', 'running', 'failed', 'dead_letter', 'waiting_dependency')
      GROUP BY stage`
  );
  const metrics: JobQueueMetrics = {
    queued: 0,
    running: 0,
    failed: 0,
    deadLetter: 0,
    waitingDependency: 0,
    oldestWaitMs: null,
  };
  for (const row of counts.rows) {
    const stage = String(row.stage);
    const count = Number(row.count ?? 0);
    if (stage === 'queued') metrics.queued = count;
    else if (stage === 'running') metrics.running = count;
    else if (stage === 'failed') metrics.failed = count;
    else if (stage === 'dead_letter') metrics.deadLetter = count;
    else if (stage === 'waiting_dependency') metrics.waitingDependency = count;
    if (stage === 'queued' || stage === 'failed') {
      const oldest = row.oldest instanceof Date ? row.oldest : row.oldest ? new Date(String(row.oldest)) : null;
      if (oldest) {
        const waitMs = now.getTime() - oldest.getTime();
        metrics.oldestWaitMs = metrics.oldestWaitMs === null ? waitMs : Math.max(metrics.oldestWaitMs, waitMs);
      }
    }
  }
  return metrics;
}
