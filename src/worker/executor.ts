import type { StoragePool } from '../storage/client.js';
import {
  claimJobs,
  markJobDeadLetter,
  markJobFailed,
  markJobSucceeded,
  markJobWaitingDependency,
  reclaimExpiredLeases,
  type JobRow,
} from '../storage/job-queue.js';
import {
  claimPendingDeliveries,
  deferDeliveryForDependency,
  enqueueDelivery,
  markDeliverySent,
  recordDeliveryFailure,
  type DeliveryRow,
} from '../storage/delivery-repository.js';
import { findReport, saveReport, type SaveReportInput } from '../storage/report-repository.js';

/**
 * 生成与投递解耦的执行器。
 *
 * 依据：
 * - Q5：报告生成不依赖 Telegram；投递失败不影响报告已完成的状态；
 * - F4：正文保存后重试只读已保存正文，不再次调用模型；
 * - Q55-D：投递是独立记录，报告可以没有投递（手动触发场景）；
 * - 第 8.1 节：投递预算、依赖等待与永久失败的区分；
 * - Q101：投递积压作为运行状态指标。
 *
 * 执行器不直接调用 Telegram 或模型：两者都由调用方注入，便于在影子期替换为
 * 只记录不产生外部副作用的实现。
 */

export interface GenerateReportResult {
  body: string;
  model: string | null;
  promptVersion: string | null;
  generatedAt: string;
  triggeredBy: 'natural' | 'restore';
  usage?: SaveReportInput['usage'];
  /** 正文尚未就绪（例如模型仍在生成）：本次不提交结果，等待依赖。 */
  notReady?: boolean;
}

export interface RunExecutorOptions {
  pool: StoragePool;
  /** 执行者标识；用于租约归属与代次校验。 */
  owner: string;
  classifyKinds?: readonly ('classification' | 'standard' | 'deep')[];
  /** 生成报告；返回 notReady 表示需要等待而不消耗重试预算。 */
  generate?: (job: JobRow) => Promise<GenerateReportResult | null>;
  /** 发送投递；抛错即视为失败。 */
  send: (delivery: DeliveryRow, reportBody: string | null) => Promise<{ chatId: string | number; messageId: number }>;
  /** 单轮最多处理的生成任务与投递任务数。 */
  jobLimit?: number;
  deliveryLimit?: number;
  /** 依赖未就绪时的重新检查时间（毫秒）。 */
  dependencyRetryMs?: number;
  /** 讨论群 chatId；未配置表示报告只进网页、不投递（Q51-A 的手动触发场景）。 */
  discussionChatId?: string;
  /** 由任务推导讨论线程根消息；历史映射缺失时返回 null。 */
  discussionThreadMessageId?: (job: JobRow) => number | null;
  now?: Date;
  warn?: (message: string) => void;
}

export interface ExecutorRoundResult {
  reclaimed: string[];
  jobsClaimed: number;
  jobsSucceeded: number;
  jobsFailed: number;
  jobsWaiting: number;
  deliveriesClaimed: number;
  deliveriesSent: number;
  deliveriesFailed: number;
  deliveriesAbandoned: number;
}

function emptyRound(): ExecutorRoundResult {
  return {
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

/** 判断投递错误是否为永久错误：这类错误重试没有意义，保留记录等人工修复。 */
export function isPermanentDeliveryError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('chat not found') ||
    text.includes('bot was blocked') ||
    text.includes('bot is not a member') ||
    text.includes('user is deactivated') ||
    text.includes('chat_id is empty') ||
    text.includes('message thread not found') ||
    text.includes('not enough rights') ||
    text.includes('forbidden')
  );
}

function backoffMs(attempts: number): number {
  // 带抖动的指数退避，上限 5 分钟；第 8.1 节要求网络故障与 429 采用退避。
  const base = Math.min(2 ** Math.min(attempts, 8) * 1000, 5 * 60_000);
  return base;
}

/**
 * 执行一轮：回收过期租约 → 处理生成任务 → 处理待投递。
 *
 * 生成任务完成后登记投递意图；投递只读取已保存正文，绝不重新生成（F4）。
 */
export async function runExecutorRound(options: RunExecutorOptions): Promise<ExecutorRoundResult> {
  const pool = options.pool;
  const warn = options.warn ?? (() => undefined);
  const now = options.now ?? new Date();
  const result = emptyRound();

  // 1. 回收失联执行者的租约
  const reclaimed = await reclaimExpiredLeases(pool, { now });
  result.reclaimed = reclaimed.reclaimed;

  // 2. 生成任务
  const jobs = await claimJobs(pool, {
    owner: options.owner,
    limit: options.jobLimit ?? 5,
    ...(options.classifyKinds ? { kinds: options.classifyKinds } : {}),
    now,
  });
  result.jobsClaimed = jobs.length;

  for (const job of jobs) {
    try {
      const outcome = await runGenerationJob({ options, job, now });
      if (outcome === 'succeeded') result.jobsSucceeded += 1;
      else if (outcome === 'waiting') result.jobsWaiting += 1;
      else result.jobsFailed += 1;
    } catch (error) {
      warn(`生成任务失败：${job.jobId} ${error instanceof Error ? error.message : String(error)}`);
      await markJobFailed(pool, {
        jobId: job.jobId,
        owner: options.owner,
        generation: job.leaseGeneration,
        error: error instanceof Error ? error.message : String(error),
        nextAttemptAt: new Date(now.getTime() + backoffMs(job.attempts)).toISOString(),
        now,
      });
      result.jobsFailed += 1;
    }
  }

  // 3. 待投递
  const deliveries = await claimPendingDeliveries(pool, { limit: options.deliveryLimit ?? 10, now });
  result.deliveriesClaimed = deliveries.length;

  for (const delivery of deliveries) {
    const report = delivery.reportId ? await findReportById(pool, delivery.reportId) : null;
    if (delivery.reportId && !report) {
      // 依赖缺失：报告还没保存好，等下一轮；不消耗投递预算（Q133 的依赖等待语义）。
      await deferDeliveryForDependency(pool, {
        deliveryId: delivery.deliveryId,
        reason: '报告尚未保存完成',
        nextAttemptAt: new Date(now.getTime() + (options.dependencyRetryMs ?? 30_000)).toISOString(),
        now,
      });
      continue;
    }

    try {
      const sent = await options.send(delivery, report?.body ?? null);
      await markDeliverySent(pool, { deliveryId: delivery.deliveryId, chatId: sent.chatId, messageId: sent.messageId, sentAt: now });
      result.deliveriesSent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`投递失败：${delivery.deliveryId} ${message}`);
      const failure = await recordDeliveryFailure(pool, {
        deliveryId: delivery.deliveryId,
        error: message,
        permanent: isPermanentDeliveryError(message),
        nextAttemptAt: new Date(now.getTime() + backoffMs(delivery.attempts)).toISOString(),
        now,
      });
      result.deliveriesFailed += 1;
      if (failure.abandoned) result.deliveriesAbandoned += 1;
    }
  }

  return result;
}

async function runGenerationJob(input: {
  options: RunExecutorOptions;
  job: JobRow;
  now: Date;
}): Promise<'succeeded' | 'failed' | 'waiting'> {
  const { options, job, now } = input;
  const pool = options.pool;

  if (!options.generate) {
    // 没有生成实现（例如影子期）：标记等待，不产生外部副作用。
    await markJobWaitingDependency(pool, {
      jobId: job.jobId,
      owner: options.owner,
      generation: job.leaseGeneration,
      reason: '未配置生成器（影子模式）',
      nextAttemptAt: new Date(now.getTime() + (options.dependencyRetryMs ?? 60_000)).toISOString(),
      now,
    });
    return 'waiting';
  }

  // F4 的关键：正文已保存就直接复用，绝不再调用模型。
  const kind = job.kind === 'deep' ? 'deep' : 'standard';
  const triggeredBy = job.triggeredBy;
  const existing = job.projectId
    ? await findReport(pool, { projectId: job.projectId, kind, triggeredBy })
    : null;
  if (existing) {
    await markJobSucceeded(pool, { jobId: job.jobId, owner: options.owner, generation: job.leaseGeneration, now });
    return 'succeeded';
  }

  const generated = await options.generate(job);
  if (!generated || generated.notReady) {
    await markJobWaitingDependency(pool, {
      jobId: job.jobId,
      owner: options.owner,
      generation: job.leaseGeneration,
      reason: '生成尚未完成',
      nextAttemptAt: new Date(now.getTime() + (options.dependencyRetryMs ?? 60_000)).toISOString(),
      now,
    });
    return 'waiting';
  }

  if (!job.projectId) {
    await markJobDeadLetter(pool, {
      jobId: job.jobId,
      owner: options.owner,
      generation: job.leaseGeneration,
      error: '任务缺少项目，无法保存报告',
      now,
    });
    return 'failed';
  }

  const saved = await saveReport(pool, {
    projectId: job.projectId,
    kind,
    triggerEventId: job.triggerEventId,
    model: generated.model,
    promptVersion: generated.promptVersion,
    body: generated.body,
    generatedAt: generated.generatedAt,
    triggeredBy: generated.triggeredBy,
    usage: generated.usage ?? null,
  });

  await markJobSucceeded(pool, { jobId: job.jobId, owner: options.owner, generation: job.leaseGeneration, now });

  // 讨论群报告需要线程映射；映射由投递侧在实际发送时确认，这里只登记意图。
  if (options.discussionChatId) {
    await enqueueDelivery(pool, {
      projectId: job.projectId,
      reportId: saved.reportId,
      purpose: 'discussion_report',
      targetChatId: options.discussionChatId,
      targetThreadMessageId: options.discussionThreadMessageId?.(job) ?? null,
      shardIndex: 0,
    });
  }

  return 'succeeded';
}

/** 读取报告正文；投递路径只依赖它，不依赖生成逻辑。 */
async function findReportById(pool: StoragePool, reportId: string): Promise<{ body: string } | null> {
  const result = await pool.query(`SELECT body FROM reports WHERE report_id = $1`, [reportId]);
  const row = result.rows[0];
  return row ? { body: String(row.body) } : null;
}
