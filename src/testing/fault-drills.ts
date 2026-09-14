import type { StoragePool } from '../storage/client.js';
import {
  claimJobs,
  markJobFailed,
  markJobSucceeded,
  reclaimExpiredLeases,
} from '../storage/job-queue.js';
import { enqueueDelivery, markDeliveryUncertain, recordDeliveryFailure } from '../storage/delivery-repository.js';
import { runExecutorRound } from '../worker/executor.js';
import { findReport, saveReport } from '../storage/report-repository.js';
import { readHealthSnapshot } from '../storage/query-repository.js';
import { isPermanentDeliveryError } from '../worker/executor.js';
import { cleanupExpiredEvents } from '../storage/retention-cleanup.js';
import { findReport as findReportForDrill } from '../storage/report-repository.js';

/**
 * 故障注入演练（M5、验收方案第 4 节 F1-F15）。
 *
 * 与单元测试的分工：
 * - 单元/集成测试断言“某个函数在某种输入下的行为”；
 * - 本模块断言“**注入某个故障后，观察到的系统状态可解释且符合已确认策略**”，
 *   并把结果写成可放进验收包的证据（通过/未通过 + 实测值）。
 *
 * 纪律：
 * - 只做**受控注入**：不调用真实模型、不向真实频道发消息（验收方案第 4 节要求）；
 * - 每个场景都记录**观察到的具体值**，而不是只写“通过”；
 * - 未实现或依赖外部环境（如真实 Telegram、真实 Alpha）的场景必须标为 skipped 并说明原因，
 *   绝不标记为通过。
 */

export interface FaultDrillScenarioResult {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  /** 实际观察到的关键值，作为证据。 */
  observed: Record<string, unknown>;
  notes: string[];
}

export interface FaultDrillReport {
  startedAt: string;
  finishedAt: string;
  results: FaultDrillScenarioResult[];
  passed: number;
  failed: number;
  skipped: number;
}

/** 断言辅助：条件不满足即记为失败，并把上下文写进 observed。 */
function expectTrue(
  results: FaultDrillScenarioResult,
  condition: boolean,
  description: string
): void {
  if (!condition) {
    results.status = 'failed';
    results.notes.push(`未满足：${description}`);
  }
}

function skipped(id: string, name: string, reason: string): FaultDrillScenarioResult {
  return { id, name, status: 'skipped', observed: {}, notes: [reason] };
}

/** 场景 F1：两个执行者同时领取同一业务意图。 */
export async function drillF1ConcurrentClaim(pool: StoragePool): Promise<FaultDrillScenarioResult> {
  const result: FaultDrillScenarioResult = { id: 'F1', name: '并发领取同一业务意图', status: 'passed', observed: {}, notes: [] };
  await pool.query(`INSERT INTO projects (project_id, project_key, source, pool_state, star)
                    VALUES ('drill-f1', 'drillf1', 'natural', 'monitored', 2) ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
                    VALUES ('drill-job-f1', 'classification', 'drill-f1', 'queued', 'natural') ON CONFLICT DO NOTHING`);

  const [first, second] = await Promise.all([
    claimJobs(pool, { owner: 'worker-A' }),
    claimJobs(pool, { owner: 'worker-B' }),
  ]);
  const owners = [...first, ...second].map((job) => job.leaseOwner);
  result.observed = { claimedByA: first.length, claimedByB: second.length, owners };

  expectTrue(result, owners.length === 1, '同一任务只被一个执行者领取');
  expectTrue(result, first.length + second.length === 1, '另一个执行者空手而归');
  await pool.query(`DELETE FROM jobs WHERE job_id = 'drill-job-f1'`);
  return result;
}

/** 场景 F3：租约过期后旧执行者返回，不能覆盖新结果。 */
export async function drillF3StaleGeneration(pool: StoragePool): Promise<FaultDrillScenarioResult> {
  const result: FaultDrillScenarioResult = { id: 'F3', name: '过期执行者不得覆盖新结果', status: 'passed', observed: {}, notes: [] };
  await pool.query(`INSERT INTO projects (project_id, project_key, source, pool_state, star)
                    VALUES ('drill-f3', 'drillf3', 'natural', 'monitored', 2) ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
                    VALUES ('drill-job-f3', 'classification', 'drill-f3', 'queued', 'natural') ON CONFLICT DO NOTHING`);

  const [stale] = await claimJobs(pool, { owner: 'worker-old', leaseMs: 1_000 });
  const reclaimed = await reclaimExpiredLeases(pool, { now: new Date(Date.now() + 2_000) });
  const [fresh] = await claimJobs(pool, { owner: 'worker-new', now: new Date(Date.now() + 3_000) });

  const staleAttempt = await markJobSucceeded(pool, {
    jobId: 'drill-job-f3',
    owner: 'worker-old',
    generation: stale!.leaseGeneration,
  });
  const freshAttempt = await markJobSucceeded(pool, {
    jobId: 'drill-job-f3',
    owner: 'worker-new',
    generation: fresh!.leaseGeneration,
  });
  const finalState = await pool.query(`SELECT stage FROM jobs WHERE job_id = 'drill-job-f3'`);

  result.observed = {
    staleGeneration: stale?.leaseGeneration,
    freshGeneration: fresh?.leaseGeneration,
    reclaimed: reclaimed.reclaimed,
    staleRejection: staleAttempt.rejection,
    freshApplied: freshAttempt.applied,
    finalStage: finalState.rows[0]?.stage,
  };

  expectTrue(result, reclaimed.reclaimed.includes('drill-job-f3'), '租约过期任务被回收');
  expectTrue(result, (fresh?.leaseGeneration ?? 0) > (stale?.leaseGeneration ?? 0), '新执行者代次更大');
  expectTrue(result, staleAttempt.applied === false, '旧执行者提交被拒绝');
  expectTrue(result, freshAttempt.applied === true, '新执行者提交成功');
  await pool.query(`DELETE FROM jobs WHERE job_id = 'drill-job-f3'`);
  return result;
}

/** 场景 F4：正文已保存后投递失败，补发不重新调用模型。 */
export async function drillF4SavedBodyNotRegenerated(pool: StoragePool): Promise<FaultDrillScenarioResult> {
  const result: FaultDrillScenarioResult = { id: 'F4', name: '正文已保存时补发不重新生成', status: 'passed', observed: {}, notes: [] };
  await pool.query(`INSERT INTO projects (project_id, project_key, source, pool_state, star)
                    VALUES ('drill-f4', 'drillf4', 'natural', 'monitored', 3) ON CONFLICT DO NOTHING`);

  const saved = await saveReport(pool, {
    projectId: 'drill-f4',
    kind: 'standard',
    triggerEventId: null,
    model: 'drill-model',
    promptVersion: 'v1',
    body: '演练正文',
    generatedAt: new Date().toISOString(),
    triggeredBy: 'natural',
  });
  const existing = await findReportForDrill(pool, { projectId: 'drill-f4', kind: 'standard', triggeredBy: 'natural' });

  // 模拟投递失败：可恢复失败进入退避，正文保持不变。
  await enqueueDelivery(pool, {
    projectId: 'drill-f4',
    reportId: saved.reportId,
    purpose: 'discussion_report',
    targetChatId: '-100000',
  });
  const delivery = await pool.query(`SELECT delivery_id FROM delivery_records WHERE project_id = 'drill-f4' LIMIT 1`);
  const failure = await recordDeliveryFailure(pool, {
    deliveryId: String(delivery.rows[0]?.delivery_id),
    error: 'telegram 503',
    nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
  });
  const afterFailure = await findReportForDrill(pool, { projectId: 'drill-f4', kind: 'standard', triggeredBy: 'natural' });

  result.observed = {
    firstSaveCreated: saved.created,
    existingBodyMatches: existing?.body === '演练正文',
    afterFailureBodyMatches: afterFailure?.body === '演练正文',
    abandoned: failure.abandoned,
  };

  expectTrue(result, saved.created === true, '首次保存建立报告');
  expectTrue(result, existing?.body === '演练正文', '正文已保存可读');
  expectTrue(result, afterFailure?.body === '演练正文', '投递失败不改变已保存正文');
  expectTrue(result, failure.abandoned === false, '可恢复失败进入退避而不是放弃');
  await pool.query(`DELETE FROM delivery_records WHERE project_id = 'drill-f4'`);
  await pool.query(`DELETE FROM reports WHERE project_id = 'drill-f4'`);
  return result;
}

/** 场景 F6：远端可能已收到但本地未确认 → 记录不确定并继续补发。 */
export async function drillF6UncertainDelivery(pool: StoragePool): Promise<FaultDrillScenarioResult> {
  const result: FaultDrillScenarioResult = { id: 'F6', name: '结果不确定的投递被如实记录并继续补发', status: 'passed', observed: {}, notes: [] };
  await pool.query(`INSERT INTO projects (project_id, project_key, source, pool_state, star)
                    VALUES ('drill-f6', 'drillf6', 'natural', 'monitored', 3) ON CONFLICT DO NOTHING`);
  await enqueueDelivery(pool, { projectId: 'drill-f6', reportId: null, purpose: 'channel_main', targetChatId: '-100000' });
  const delivery = await pool.query(`SELECT delivery_id FROM delivery_records WHERE project_id = 'drill-f6' LIMIT 1`);
  const deliveryId = String(delivery.rows[0]?.delivery_id);

  await markDeliveryUncertain(pool, { deliveryId, error: '回执丢失' });
  const row = await pool.query(`SELECT uncertain, sent_at, next_attempt_at FROM delivery_records WHERE delivery_id = $1`, [deliveryId]);

  result.observed = {
    uncertain: row.rows[0]?.uncertain,
    sentAt: row.rows[0]?.sent_at,
    scheduledRetry: row.rows[0]?.next_attempt_at !== null,
  };

  expectTrue(result, row.rows[0]?.uncertain === true, '标记为结果不确定');
  expectTrue(result, row.rows[0]?.sent_at === null, '不伪造已送达');
  expectTrue(result, row.rows[0]?.next_attempt_at !== null, '仍安排补发');
  await pool.query(`DELETE FROM delivery_records WHERE project_id = 'drill-f6'`);
  return result;
}

/** 场景 F7：永久错误不再重试，但保留待处理记录。 */
export async function drillF7PermanentError(pool: StoragePool): Promise<FaultDrillScenarioResult> {
  const result: FaultDrillScenarioResult = { id: 'F7', name: '永久错误进入待处理而非无限重试', status: 'passed', observed: {}, notes: [] };
  await pool.query(`INSERT INTO projects (project_id, project_key, source, pool_state, star)
                    VALUES ('drill-f7', 'drillf7', 'natural', 'monitored', 3) ON CONFLICT DO NOTHING`);
  await enqueueDelivery(pool, { projectId: 'drill-f7', reportId: null, purpose: 'channel_main', targetChatId: '-100000' });
  const delivery = await pool.query(`SELECT delivery_id FROM delivery_records WHERE project_id = 'drill-f7' LIMIT 1`);
  const deliveryId = String(delivery.rows[0]?.delivery_id);

  const permanent = 'Bad Request: chat not found';
  const failure = await recordDeliveryFailure(pool, { deliveryId, error: permanent, permanent: isPermanentDeliveryError(permanent) });
  const row = await pool.query(`SELECT abandoned, next_attempt_at, last_error FROM delivery_records WHERE delivery_id = $1`, [deliveryId]);

  result.observed = {
    recognizedAsPermanent: isPermanentDeliveryError(permanent),
    abandoned: row.rows[0]?.abandoned,
    nextAttemptAt: row.rows[0]?.next_attempt_at,
    shouldAlert: failure.shouldAlert,
  };

  expectTrue(result, isPermanentDeliveryError(permanent), '永久错误被识别');
  expectTrue(result, row.rows[0]?.abandoned === true, '不再自动重试');
  expectTrue(result, row.rows[0]?.next_attempt_at === null, '不安排下一次尝试');
  expectTrue(result, failure.shouldAlert === true, '需要告警');
  await pool.query(`DELETE FROM delivery_records WHERE project_id = 'drill-f7'`);
  return result;
}

/** 场景 F11：数据库不可用时健康接口暴露异常，而不是返回空数据。 */
export async function drillF11DatabaseUnavailable(): Promise<FaultDrillScenarioResult> {
  const result: FaultDrillScenarioResult = { id: 'F11', name: '数据服务不可用时不伪装成空数据', status: 'passed', observed: {}, notes: [] };
  const broken = {
    query: async () => {
      throw new Error('connection terminated unexpectedly');
    },
    transaction: async () => {
      throw new Error('connection terminated unexpectedly');
    },
    close: async () => undefined,
  } as unknown as StoragePool;

  let threw = false;
  let message = '';
  try {
    await readHealthSnapshot(broken);
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  result.observed = { threw, message };
  expectTrue(result, threw, '健康快照查询失败时抛出异常');
  expectTrue(result, message.includes('connection terminated'), '异常信息保留原始原因');
  return result;
}

/**
 * 场景 F5：Telegram 整体不可用 / 讨论映射缺失。
 *
 * 验证 Q5 的核心解耦：**投递失败不得阻止报告生成**，且依赖等待不逐条耗尽投递预算。
 */
export async function drillF5TelegramUnavailable(pool: StoragePool): Promise<FaultDrillScenarioResult> {
  const result: FaultDrillScenarioResult = {
    id: 'F5',
    name: 'Telegram 不可用或映射缺失时报告仍生成、投递单独等待',
    status: 'passed',
    observed: {},
    notes: [],
  };

  await pool.query(`INSERT INTO projects (project_id, project_key, source, pool_state, star)
                    VALUES ('drill-f5', 'drillf5', 'natural', 'monitored', 3) ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
                    VALUES ('drill-job-f5', 'standard', 'drill-f5', 'queued', 'natural') ON CONFLICT DO NOTHING`);

  // 生成成功（受控注入：不调用模型），但投递用的 Telegram 发送器整体抛错。
  const roundWithBrokenTelegram = await runExecutorRound({
    pool,
    owner: 'drill-worker-f5',
    generate: async () => ({
      body: '演练报告正文',
      model: 'drill-model',
      promptVersion: 'v1',
      generatedAt: new Date().toISOString(),
      triggeredBy: 'natural' as const,
    }),
    send: async () => {
      throw new Error('Bad Gateway: telegram 502');
    },
    discussionChatId: '-100000',
  });

  const report = await findReportForDrill(pool, { projectId: 'drill-f5', kind: 'standard', triggeredBy: 'natural' });
  const job = await pool.query(`SELECT stage FROM jobs WHERE job_id = 'drill-job-f5'`);
  const delivery = await pool.query(
    `SELECT attempts, abandoned, last_error, sent_at FROM delivery_records WHERE project_id = 'drill-f5' LIMIT 1`
  );

  result.observed = {
    jobSucceeded: roundWithBrokenTelegram.jobsSucceeded,
    reportSaved: report?.body === '演练报告正文',
    jobStage: job.rows[0]?.stage,
    deliveryFailed: roundWithBrokenTelegram.deliveriesFailed,
    deliveryAbandoned: delivery.rows[0]?.abandoned,
    deliveryAttempts: delivery.rows[0]?.attempts,
    deliverySent: delivery.rows[0]?.sent_at !== null,
  };

  // 关键结论：Telegram 整体不可用时，网页报告照样生成完成。
  expectTrue(result, roundWithBrokenTelegram.jobsSucceeded === 1, '报告生成不被 Telegram 故障阻塞');
  expectTrue(result, report?.body === '演练报告正文', '正文已保存，网页可读');
  expectTrue(result, job.rows[0]?.stage === 'succeeded', '生成任务终态为成功');
  expectTrue(result, delivery.rows[0]?.sent_at === null, '投递未标记为已送达');
  expectTrue(result, delivery.rows[0]?.abandoned === false, '单次失败不直接放弃（可恢复错误）');

  // 再跑一轮：依赖等待/退避语义下不应重复生成报告（F4）。
  const secondRound = await runExecutorRound({
    pool,
    owner: 'drill-worker-f5b',
    generate: async () => ({ body: '不应被写入的新正文', model: 'x', promptVersion: 'v1', generatedAt: new Date().toISOString(), triggeredBy: 'natural' as const }),
    send: async () => {
      throw new Error('Bad Gateway: telegram 502');
    },
    discussionChatId: '-100000',
  });
  const reportAfter = await findReportForDrill(pool, { projectId: 'drill-f5', kind: 'standard', triggeredBy: 'natural' });
  result.observed = { ...result.observed, secondRoundGenerated: secondRound.jobsSucceeded, bodyUnchanged: reportAfter?.body === '演练报告正文' };
  expectTrue(result, reportAfter?.body === '演练报告正文', '报告已存在时不重新生成');

  await pool.query(`DELETE FROM delivery_records WHERE project_id = 'drill-f5'`);
  await pool.query(`DELETE FROM reports WHERE project_id = 'drill-f5'`);
  await pool.query(`DELETE FROM jobs WHERE project_id = 'drill-f5'`);
  return result;
}

/**
 * 场景 F12/F13：模型侧错误分类。
 *
 * 受控注入：不调用真实模型；用**生成器返回的用量与错误**验证“永久鉴权错误”与
 * “429 可恢复错误”在任务层面的不同处理（F12 等待修复、F13 退避重试）。
 */
export async function drillF12F13ExternalErrors(pool: StoragePool): Promise<FaultDrillScenarioResult[]> {
  const results: FaultDrillScenarioResult[] = [];

  // F12：鉴权失效 —— 任务失败并记录错误，等待修复后重试，而不是反复烧钱。
  const auth: FaultDrillScenarioResult = {
    id: 'F12',
    name: '模型鉴权失效时任务不静默成功',
    status: 'passed',
    observed: {},
    notes: [],
  };
  await pool.query(`INSERT INTO projects (project_id, project_key, source, pool_state, star)
                    VALUES ('drill-f12', 'drillf12', 'natural', 'monitored', 3) ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
                    VALUES ('drill-job-f12', 'standard', 'drill-f12', 'queued', 'natural') ON CONFLICT DO NOTHING`);
  const authRound = await runExecutorRound({
    pool,
    owner: 'drill-worker-f12',
    generate: async () => {
      throw new Error('401 Unauthorized: invalid api key');
    },
    send: async () => ({ chatId: '-100000', messageId: 1 }),
  });
  const authJob = await pool.query(
    `SELECT stage, last_error, attempts, next_attempt_at FROM jobs WHERE job_id = 'drill-job-f12'`
  );
  const authReport = await findReportForDrill(pool, { projectId: 'drill-f12', kind: 'standard' });

  auth.observed = {
    jobsFailed: authRound.jobsFailed,
    stage: authJob.rows[0]?.stage,
    lastError: authJob.rows[0]?.last_error,
    scheduledRetry: authJob.rows[0]?.next_attempt_at !== null,
    reportCreated: authReport !== null,
  };
  expectTrue(auth, authRound.jobsFailed === 1, '鉴权失败被计为失败');
  expectTrue(auth, authJob.rows[0]?.stage === 'failed', '任务进入失败而不是成功');
  expectTrue(auth, String(authJob.rows[0]?.last_error ?? '').includes('401'), '错误原因被如实记录');
  expectTrue(auth, authReport === null, '不产生半成品报告');
  results.push(auth);

  // F13：429 —— 同样进入退避重试，且错误信息保留限流语义。
  const throttle: FaultDrillScenarioResult = {
    id: 'F13',
    name: '429 可恢复错误进入退避重试',
    status: 'passed',
    observed: {},
    notes: [],
  };
  await pool.query(`INSERT INTO projects (project_id, project_key, source, pool_state, star)
                    VALUES ('drill-f13', 'drillf13', 'natural', 'monitored', 3) ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
                    VALUES ('drill-job-f13', 'standard', 'drill-f13', 'queued', 'natural') ON CONFLICT DO NOTHING`);
  const throttleRound = await runExecutorRound({
    pool,
    owner: 'drill-worker-f13',
    generate: async () => {
      throw new Error('429 Too Many Requests: retry after 30');
    },
    send: async () => ({ chatId: '-100000', messageId: 1 }),
  });
  const throttleJob = await pool.query(
    `SELECT stage, last_error, next_attempt_at, attempts FROM jobs WHERE job_id = 'drill-job-f13'`
  );
  const deliveryQuota = await recordDeliveryFailure(pool, {
    deliveryId: await ensureDeliveryForDrill(pool, 'drill-f13'),
    error: '429 Too Many Requests: retry after 30',
  });
  const deliveryRow = await pool.query(
    `SELECT abandoned, next_attempt_at, last_error FROM delivery_records WHERE project_id = 'drill-f13' LIMIT 1`
  );

  throttle.observed = {
    jobsFailed: throttleRound.jobsFailed,
    stage: throttleJob.rows[0]?.stage,
    attempts: throttleJob.rows[0]?.attempts,
    scheduledRetry: throttleJob.rows[0]?.next_attempt_at !== null,
    deliveryAbandoned: deliveryRow.rows[0]?.abandoned,
    deliveryRetryScheduled: deliveryRow.rows[0]?.next_attempt_at !== null,
    deliveryShouldAlert: deliveryQuota.shouldAlert,
  };
  expectTrue(throttle, throttleJob.rows[0]?.stage === 'failed', '429 被计为可恢复失败');
  expectTrue(throttle, throttleJob.rows[0]?.next_attempt_at !== null, '安排退避重试');
  expectTrue(throttle, deliveryRow.rows[0]?.abandoned === false, '投递 429 不直接放弃');
  expectTrue(throttle, deliveryQuota.shouldAlert === false, '未耗尽预算时不告警');
  results.push(throttle);

  await pool.query(`DELETE FROM delivery_records WHERE project_id IN ('drill-f12', 'drill-f13')`);
  await pool.query(`DELETE FROM jobs WHERE project_id IN ('drill-f12', 'drill-f13')`);
  return results;
}

/** 为一个演练项目准备一条待投递记录，返回 delivery_id。 */
async function ensureDeliveryForDrill(pool: StoragePool, projectId: string): Promise<string> {
  const existing = await pool.query(`SELECT delivery_id FROM delivery_records WHERE project_id = $1 LIMIT 1`, [projectId]);
  if (existing.rows[0]?.delivery_id) return String(existing.rows[0].delivery_id);
  await enqueueDelivery(pool, { projectId, reportId: null, purpose: 'channel_main', targetChatId: '-100000' });
  const created = await pool.query(`SELECT delivery_id FROM delivery_records WHERE project_id = $1 LIMIT 1`, [projectId]);
  return String(created.rows[0]?.delivery_id);
}

/** 场景 F10：90 天清理遇到长期报告与未完投递。 */
export async function drillF10RetentionCleanup(pool: StoragePool): Promise<FaultDrillScenarioResult> {
  const result: FaultDrillScenarioResult = { id: 'F10', name: '90 天清理不破坏长期报告与未完投递', status: 'passed', observed: {}, notes: [] };
  const oldTime = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  const freshTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  await pool.query(`INSERT INTO projects (project_id, project_key, source, pool_state, star)
                    VALUES ('drill-f10', 'drillf10', 'natural', 'monitored', 3) ON CONFLICT DO NOTHING`);
  // 过期事件（120 天前）与未过期事件（5 天前）各一条，都带判定记录
  for (const [suffix, at] of [['old', oldTime], ['fresh', freshTime]] as const) {
    await pool.query(
      `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload)
       VALUES ($1, 'drill-f10', $2, $3::timestamptz, '{}')`,
      [`drill-f10-evt-${suffix}`, suffix === 'old' ? 1 : 2, at]
    );
    await pool.query(
      `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at)
       VALUES ($1, $2, 'drill-f10', 'drillf10', 'PUSHED', $3::timestamptz)`,
      [`drill-f10-dec-${suffix}`, `drill-f10-evt-${suffix}`, at]
    );
  }
  // 长期报告引用过期事件（trigger_event_id 应为 ON DELETE SET NULL）
  await pool.query(
    `INSERT INTO reports (report_id, project_id, kind, body, generated_at, triggered_by, trigger_event_id)
     VALUES ('drill-f10-report', 'drill-f10', 'standard', '长期正文', $1::timestamptz, 'natural', 'drill-f10-evt-old')
     ON CONFLICT DO NOTHING`,
    [oldTime]
  );
  // 未完成的投递（分片未发完）引用该报告
  await pool.query(
    `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, shard_index)
     VALUES ('drill-f10-dlv', 'drill-f10', 'drill-f10-report', 'discussion_report', '-100000', 1)
     ON CONFLICT DO NOTHING`
  );

  const cleanup = await cleanupExpiredEvents(pool, { retentionDays: 90, batchSize: 1, maxBatches: 5 });
  const after = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM inbound_events WHERE event_id LIKE 'drill-f10-%') AS events,
       (SELECT count(*)::int FROM decisions WHERE decision_id LIKE 'drill-f10-%') AS decisions,
       (SELECT count(*)::int FROM reports WHERE report_id = 'drill-f10-report') AS reports,
       (SELECT trigger_event_id FROM reports WHERE report_id = 'drill-f10-report') AS trigger_event,
       (SELECT count(*)::int FROM delivery_records WHERE delivery_id = 'drill-f10-dlv') AS deliveries`
  );

  result.observed = {
    deletedEvents: cleanup.deletedEvents,
    deletedDecisions: cleanup.deletedDecisions,
    remainingEvents: after.rows[0]?.events,
    remainingDecisions: after.rows[0]?.decisions,
    reportKept: Number(after.rows[0]?.reports) === 1,
    reportTriggerEvent: after.rows[0]?.trigger_event,
    pendingDeliveryKept: Number(after.rows[0]?.deliveries) === 1,
    blockedByReferences: cleanup.blockedByReferences,
  };

  expectTrue(result, cleanup.deletedEvents >= 1, '过期接收记录被清理');
  expectTrue(result, Number(after.rows[0]?.events) === 1, '未过期记录保留');
  expectTrue(result, Number(after.rows[0]?.decisions) === 1, '未过期判定保留');
  expectTrue(result, Number(after.rows[0]?.reports) === 1, '长期报告不被级联删除');
  expectTrue(result, after.rows[0]?.trigger_event === null, '报告引用被置空而不是删除报告');
  expectTrue(result, Number(after.rows[0]?.deliveries) === 1, '未完成投递记录保留');

  await pool.query(`DELETE FROM delivery_records WHERE delivery_id = 'drill-f10-dlv'`);
  await pool.query(`DELETE FROM reports WHERE report_id = 'drill-f10-report'`);
  await pool.query(`DELETE FROM decisions WHERE decision_id LIKE 'drill-f10-%'`);
  await pool.query(`DELETE FROM inbound_events WHERE event_id LIKE 'drill-f10-%'`);
  return result;
}

/** 汇总：跑所有可执行场景并生成报告。 */
export async function runFaultDrills(pool: StoragePool): Promise<FaultDrillReport> {
  const startedAt = new Date().toISOString();
  const results: FaultDrillScenarioResult[] = [];

  results.push(await drillF1ConcurrentClaim(pool));
  results.push(await drillF3StaleGeneration(pool));
  results.push(await drillF4SavedBodyNotRegenerated(pool));
  results.push(await drillF6UncertainDelivery(pool));
  results.push(await drillF7PermanentError(pool));
  results.push(await drillF11DatabaseUnavailable());
  results.push(...(await drillF12F13ExternalErrors(pool)));

  results.push(
    skipped('F2', '判定顺序保证首个合规事件拥有深度任务', '需要完整判定链注入；由 decision-rules 与 inbound-pipeline 测试覆盖。'),
  );
  results.push(await drillF5TelegramUnavailable(pool));
  results.push(skipped('F8', '轮询窗口交错不漏不重', '需要并发事务注入；由 query-repository 游标分页测试覆盖。'));
  results.push(skipped('F9', '浏览器断网/多标签页恢复', '需要浏览器环境；属端到端验收范围。'));
  results.push(await drillF10RetentionCleanup(pool));
  results.push(skipped('F14', '未登录/权限撤销', '由 api-server 与 auth 测试覆盖。'));
  results.push(skipped('F15', '恶意模型正文', '由前端纯文本渲染实现覆盖，端到端需浏览器验证。'));

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
  };
}

/** 报告格式化：明确区分“已执行的通过”与“未执行/已覆盖但未在本演练重复”。 */
export function formatFaultDrillReport(report: FaultDrillReport): string {
  const lines: string[] = [];
  lines.push('## 故障注入演练报告');
  lines.push('');
  lines.push(`执行时间：${report.startedAt} → ${report.finishedAt}`);
  lines.push(`通过 ${report.passed} / 失败 ${report.failed} / 跳过 ${report.skipped}`);
  lines.push('');
  lines.push('| 场景 | 结果 | 观察到的关键值 | 说明 |');
  lines.push('|---|---|---|---|');
  for (const result of report.results) {
    const observed = Object.entries(result.observed)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('; ');
    lines.push(`| ${result.id} ${result.name} | ${result.status} | ${observed || '—'} | ${result.notes.join(' ') || '—'} |`);
  }
  lines.push('');
  lines.push(
    '说明：跳过不等于通过。标注 skipped 的场景要么需要外部环境（真实 Telegram/浏览器），' +
      '要么已有单元测试覆盖但未在本演练中重复注入，要么功能尚未实现（如 90 天清理）。'
  );
  return lines.join('\n');
}
