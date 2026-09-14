import { performance } from 'node:perf_hooks';
import type { StoragePool } from '../storage/client.js';
import { runExecutorRound, type RunExecutorOptions, type ExecutorRoundResult } from './executor.js';
import { cleanupExpiredEvents, type CleanupOptions, type CleanupResult } from '../storage/retention-cleanup.js';

/**
 * Worker 调度循环（M2/M5）：把任务执行与保留期清理接入同一个常驻循环。
 *
 * 依据：
 * - 第 5 节：保留期清理必须**按小批量后台执行**，不能阻塞在线查询；
 * - 第 10.1 节：清理是常驻职责，不是人工动作；
 * - Q101：循环状态（清理是否滞后、上次清理时间）要能在运行状态页看到。
 *
 * 设计取舍：
 * - 清理有独立的最小间隔（默认 1 小时）：它按天级窗口生效，频繁跑只是浪费；
 * - 清理失败**不能影响任务执行**：任务失败会重试，清理下一轮再来；
 * - 每轮的结果都返回，调用方（CLI）负责日志与告警判断，本模块不直接发通知。
 */

export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface WorkerCycleOptions {
  pool: StoragePool;
  owner: string;
  now?: Date;
  /** 上一轮清理时间；早于间隔则本轮跳过清理。 */
  lastCleanupAt?: Date | null;
  cleanupIntervalMs?: number;
  cleanup?: CleanupOptions;
  /** 执行器选项；send 必填（由调用方决定真实发送还是影子期只记录）。 */
  executor: Omit<RunExecutorOptions, 'pool' | 'owner' | 'now'>;
  warn?: (message: string) => void;
}

export interface WorkerCycleResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  executor: ExecutorRoundResult;
  /** 本轮未执行清理时为 null（未到间隔）。 */
  cleanup: CleanupResult | null;
  cleanupSkipped: boolean;
  /** 本轮结束后应记录的清理时间（供下一轮判断间隔）。 */
  cleanupAt: Date | null;
  errors: string[];
}

/**
 * 执行一轮：先处理任务，再判断是否需要清理。
 *
 * 顺序有意为先任务后清理：清理会长时间占用 I/O，放在后面可以避免拖延任务领取。
 */
export async function runWorkerCycle(options: WorkerCycleOptions): Promise<WorkerCycleResult> {
  const now = options.now ?? new Date();
  const warn = options.warn ?? (() => undefined);
  const startedAt = performance.now();
  const errors: string[] = [];

  let executorResult: ExecutorRoundResult;
  try {
    executorResult = await runExecutorRound({
      pool: options.pool,
      owner: options.owner,
      now,
      ...options.executor,
    });
  } catch (error) {
    // 执行器整轮失败不应让常驻循环退出：记录后由下一轮重试。
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`执行器整轮失败：${message}`);
    warn(`执行器整轮失败（将由下一轮重试）：${message}`);
    executorResult = {
      reclaimed: [],
      jobsClaimed: 0,
      jobsSucceeded: 0,
      jobsFailed: 0,
      jobsWaiting: 0,
      deliveriesClaimed: 0,
      deliveriesSent: 0,
      deliveriesFailed: 0,
      deliveriesAbandoned: 0,
    };
  }

  const intervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  const dueForCleanup =
    !options.lastCleanupAt || now.getTime() - options.lastCleanupAt.getTime() >= intervalMs;

  let cleanup: CleanupResult | null = null;
  if (dueForCleanup) {
    try {
      cleanup = await cleanupExpiredEvents(options.pool, { ...(options.cleanup ?? {}), now });
    } catch (error) {
      // 清理失败不影响任务执行，也不终止循环（下一轮再来）。
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`保留期清理失败：${message}`);
      warn(`保留期清理失败（不影响任务执行）：${message}`);
    }
  }

  const finishedAt = performance.now();
  return {
    startedAt: new Date(now.getTime() - (finishedAt - startedAt)).toISOString(),
    finishedAt: now.toISOString(),
    durationMs: Math.round(finishedAt - startedAt),
    executor: executorResult,
    cleanup,
    cleanupSkipped: !dueForCleanup,
    cleanupAt: cleanup ? now : (options.lastCleanupAt ?? null),
    errors,
  };
}

/** 循环状态摘要，供运行状态页与告警判断。 */
export interface WorkerLoopStatus {
  cycles: number;
  lastCycleAt: string | null;
  lastCleanupAt: string | null;
  /** 清理是否已超过 2 个间隔没有成功执行（需要告警）。 */
  cleanupStale: boolean;
  consecutiveErrors: number;
}

export function describeWorkerLoop(input: {
  cycles: number;
  lastCycleAt: Date | null;
  lastCleanupAt: Date | null;
  consecutiveErrors: number;
  now?: Date;
  cleanupIntervalMs?: number;
}): WorkerLoopStatus {
  const now = input.now ?? new Date();
  const intervalMs = input.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  const cleanupStale =
    input.lastCleanupAt === null || now.getTime() - input.lastCleanupAt.getTime() > intervalMs * 2;
  return {
    cycles: input.cycles,
    lastCycleAt: input.lastCycleAt?.toISOString() ?? null,
    lastCleanupAt: input.lastCleanupAt?.toISOString() ?? null,
    cleanupStale,
    consecutiveErrors: input.consecutiveErrors,
  };
}
