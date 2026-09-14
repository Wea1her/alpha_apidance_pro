import { performance } from 'node:perf_hooks';
import type { StoragePool } from '../storage/client.js';
import { listDecisionTimeline, listProjects, readProjectDetail } from '../storage/query-repository.js';
import {
  DECISION_COLUMNS,
  DECISION_PARAMS_PER_ROW,
  DECISION_ROW_SPECS,
  INBOUND_EVENT_COLUMNS,
  INBOUND_EVENT_PARAMS_PER_ROW,
  INBOUND_EVENT_ROW_SPECS,
  buildBatchInsert,
  buildValueRow,
} from './sql-batch.js';

/**
 * 压测/基准脚本（M5、验收方案第 3 节）。
 *
 * 依据：验收方案要求“10 个独立浏览器会话持续在线、每 2 秒一次混合查询、
 * 同时维持 2 秒轮询刷新；中途以每秒 20 条持续 60 秒制造高峰”，
 * 并采集列表 p50/p95/p99、状态可见延迟、入站成功计数与可查询记录数一致。
 *
 * **计量边界（必须如实标注）**：本脚本在数据层（repository 层）测量，
 * 不含 HTTP 解析、前端渲染与浏览器网络。因此它验证的是“数据库与查询计划是否达标”，
 * 不能替代端到端 p95 验收；端到端数据需用 Playwright 在浏览器里采（验收方案第 3 节）。
 *
 * 用法：
 *   TEST_DATABASE_URL=... tsx src/testing/benchmark.ts --scenario=query --sessions=10 --duration=15
 *   TEST_DATABASE_URL=... tsx src/testing/benchmark.ts --scenario=ingest --rate=20 --seconds=60
 */

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** 最近秩次分位数：小样本下比插值更保守，避免用插值掩盖长尾。 */
export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
    return sorted[index]!;
  };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
    mean: total / sorted.length,
  };
}

export interface QueryScenarioOptions {
  sessions: number;
  durationMs: number;
  /** 每会话的请求间隔（验收方案：平均每 2 秒一次）。 */
  intervalMs?: number;
  /** 是否混入项目详情查询（更重的查询）。 */
  includeDetail?: boolean;
}

export interface QueryScenarioResult {
  sessions: number;
  durationMs: number;
  requests: number;
  errors: number;
  list: LatencySummary;
  detail: LatencySummary;
  /** 端到端轮询延迟目标未在此验证——仅数据层。 */
  scope: 'repository-layer';
}

/** 一个会话的混合查询负载：列表 + 不同筛选 + 偶尔详情。 */
async function runSession(
  pool: StoragePool,
  options: QueryScenarioOptions,
  collect: { list: number[]; detail: number[]; errors: number },
  stopAt: number
): Promise<void> {
  const intervalMs = options.intervalMs ?? 2_000;
  let round = 0;
  while (performance.now() < stopAt) {
    const started = performance.now();
    try {
      round += 1;
      // 混合查询：分页、搜索、星级筛选、状态筛选（验收方案第 3 节）。
      switch (round % 4) {
        case 0:
          await listProjects(pool, { limit: 50 });
          break;
        case 1:
          await listProjects(pool, { limit: 20, search: 'synth000' });
          break;
        case 2:
          await listProjects(pool, { limit: 20, stars: [3, 4, 5], poolState: 'monitored' });
          break;
        default:
          await listDecisionTimeline(pool, { limit: 50 });
          break;
      }
      collect.list.push(performance.now() - started);

      if (options.includeDetail) {
        const detailStarted = performance.now();
        const projects = await listProjects(pool, { limit: 1 });
        const projectId = projects.rows[0]?.projectId;
        if (projectId) {
          await readProjectDetail(pool, { projectId });
          collect.detail.push(performance.now() - detailStarted);
        }
      }
    } catch {
      collect.errors += 1;
    }
    const elapsed = performance.now() - started;
    const wait = Math.max(0, intervalMs - elapsed);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** 并发会话混合查询（验收方案：10 个独立会话、每 2 秒一次、持续 15 分钟）。 */
export async function runQueryScenario(
  pool: StoragePool,
  options: QueryScenarioOptions
): Promise<QueryScenarioResult> {
  const collect = { list: [] as number[], detail: [] as number[], errors: 0 };
  const startedAt = performance.now();
  const stopAt = startedAt + options.durationMs;

  await Promise.all(
    Array.from({ length: options.sessions }, () => runSession(pool, options, collect, stopAt))
  );

  return {
    sessions: options.sessions,
    durationMs: Math.round(performance.now() - startedAt),
    requests: collect.list.length + collect.detail.length,
    errors: collect.errors,
    list: summarizeLatencies(collect.list),
    detail: summarizeLatencies(collect.detail),
    scope: 'repository-layer',
  };
}

export interface IngestScenarioOptions {
  /** 目标写入速率（条/秒）。 */
  rate: number;
  seconds: number;
  /** 每批条数；越小越接近逐条写入的提交开销。 */
  batchSize?: number;
  /** 事件接收者：默认写 inbound_events + decisions，与流水线一致。 */
  collectorId?: string;
}

export interface IngestScenarioResult {
  targetRate: number;
  achievedRate: number;
  written: number;
  seconds: number;
  /** 写入计数与可查询计数是否一致（验收方案要求一致）。 */
  countsMatch: boolean;
  writtenCount: number;
  queryableCount: number;
}

/**
 * 入站高峰：以目标速率写入接收记录与判定记录。
 *
 * 只写这两张表：分类、模型调用与 Telegram 投递都应由受控适配器替代（验收方案第 3 节第 5 条），
 * 因此本场景不触发任何外部调用。
 */
export async function runIngestScenario(
  pool: StoragePool,
  options: IngestScenarioOptions
): Promise<IngestScenarioResult> {
  const batchSize = Math.max(1, options.batchSize ?? Math.max(1, Math.round(options.rate / 4)));
  const prefix = `bench_${Date.now().toString(36)}`;
  // 采集器 ID 每轮唯一：inbound_events 对 (collector_id, ingest_seq) 有唯一约束，
  // 复用同一个 collector_id 会让新一轮的 ingest_seq 与历史行冲突并被 ON CONFLICT 跳过。
  const collectorId = options.collectorId ?? prefix;
  const startedAt = performance.now();
  const endAt = startedAt + options.seconds * 1_000;
  let written = 0;
  let sequence = 0;

  while (performance.now() < endAt) {
    // 按速率反推本批应写多少条，保证目标速率可持续且不无限堆积。
    const targetWritten = Math.floor(((performance.now() - startedAt) / 1_000) * options.rate);
    const toWrite = Math.min(batchSize, Math.max(0, targetWritten - written));
    if (toWrite === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }

    // 合成项目：decisions.project_id 有外键，压测前必须保证对应项目存在；
    // 否则整批判定写入会被外键拒绝（这正是压测先暴露出来的问题）。
    await ensureBenchProjects(pool, toWrite, sequence);

    const eventRows: string[] = [];
    const eventValues: unknown[] = [];
    const decisionRows: string[] = [];
    const decisionValues: unknown[] = [];

    for (let index = 0; index < toWrite; index += 1) {
      sequence += 1;
      const eventId = `${prefix}_${sequence}`;
      const decisionId = `${prefix}_dec_${sequence}`;
      const projectKey = `synth${String(sequence % 50_000).padStart(6, '0')}`;
      const count = sequence % 25;

      // 占位符由纯函数生成，并有单元测试断言“占位符数量 == 参数数量”。
      const eventRow = buildValueRow(index * INBOUND_EVENT_PARAMS_PER_ROW + 1, INBOUND_EVENT_ROW_SPECS);
      eventRows.push(eventRow.values);
      // 参数顺序必须与 INBOUND_EVENT_ROW_SPECS 严格一致：
      // event_id, collector_id, ingest_seq, raw_payload, common_follow_count, legacy_dedupe_key, parse_error
      // （received_at 是 now()、link 固定 NULL，都不占参数）
      eventValues.push(eventId, collectorId, sequence, '{"channel":"follow"}', count, null, null);

      const decisionRow = buildValueRow(index * DECISION_PARAMS_PER_ROW + 1, DECISION_ROW_SPECS);
      decisionRows.push(decisionRow.values);
      // 引用 ensureBenchProjects 建立的项目 ID；形态必须与数据生成器一致（proj_synth_<n>）。
      decisionValues.push(decisionId, eventId, `proj_synth_${sequence % 50_000}`, 'BELOW_THRESHOLD', count, count);
    }

    const events = buildBatchInsert({
      table: 'inbound_events',
      columns: INBOUND_EVENT_COLUMNS,
      rows: eventRows,
      suffix: 'ON CONFLICT DO NOTHING',
    });
    if (events.placeholderCount !== eventValues.length) {
      throw new Error(`占位符与参数数量不一致：${events.placeholderCount} vs ${eventValues.length}`);
    }
    const eventResult = await pool.query(events.sql, eventValues);
        // 诊断：事件没写进去却继续写判定，会导致外键失败且信息不直观。
    const expectedEventRows = eventValues.length / INBOUND_EVENT_PARAMS_PER_ROW;
    if ((eventResult.rowCount ?? 0) !== expectedEventRows) {
      throw new Error(
        `事件批次未全部写入：期望 ${expectedEventRows} 行，实际 ${eventResult.rowCount ?? 0} 行`
      );
    }

    const decisions = buildBatchInsert({
      table: 'decisions',
      columns: DECISION_COLUMNS,
      rows: decisionRows,
      suffix: 'ON CONFLICT DO NOTHING',
    });
    if (decisions.placeholderCount !== decisionValues.length) {
      throw new Error(`占位符与参数数量不一致：${decisions.placeholderCount} vs ${decisionValues.length}`);
    }
    await pool.query(decisions.sql, decisionValues);

    written += toWrite;
  }

  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM inbound_events WHERE collector_id = $1) AS written,
       (SELECT count(*)::int FROM decisions WHERE decision_id LIKE $2) AS queryable`,
    [collectorId, `${prefix}%`]
  );
  const writtenCount = Number(counts.rows[0]?.written ?? 0);
  const queryableCount = Number(counts.rows[0]?.queryable ?? 0);

  return {
    targetRate: options.rate,
    achievedRate: Math.round(written / elapsedSeconds),
    written,
    seconds: Math.round(elapsedSeconds * 10) / 10,
    countsMatch: written === writtenCount && written === queryableCount,
    writtenCount,
    queryableCount,
  };
}

/** 把结果格式化成可粘贴进验收报告的形式。 */
export function formatQueryReport(result: QueryScenarioResult): string {
  const line = (label: string, summary: LatencySummary): string =>
    `${label}: n=${summary.count} p50=${summary.p50.toFixed(0)}ms p95=${summary.p95.toFixed(0)}ms ` +
    `p99=${summary.p99.toFixed(0)}ms max=${summary.max.toFixed(0)}ms`;
  return [
    `并发会话 ${result.sessions}，时长 ${(result.durationMs / 1000).toFixed(1)}s，请求 ${result.requests}，错误 ${result.errors}`,
    line('列表查询', result.list),
    result.detail.count > 0 ? line('项目详情', result.detail) : '项目详情：未执行',
    `计量边界：${result.scope}（不含 HTTP 与浏览器渲染，端到端 p95 需另用 Playwright 采集）`,
  ].join('\n');
}

export function formatIngestReport(result: IngestScenarioResult): string {
  return [
    `目标 ${result.targetRate} 条/秒，实际 ${result.achievedRate} 条/秒，写入 ${result.written} 条，耗时 ${result.seconds}s`,
    `写入计数与可查询计数一致：${result.countsMatch ? '是' : '否'}（记录 ${result.writtenCount}，可查 ${result.queryableCount}）`,
  ].join('\n');
}

/** 为压测的判定记录准备项目行（幂等）。 */
async function ensureBenchProjects(pool: StoragePool, count: number, startSequence: number): Promise<void> {
  const rows: string[] = [];
  const values: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const sequence = startSequence + index;
    const projectKey = `synth${String(sequence % 50_000).padStart(6, '0')}`;
    const base = index * 3;
    rows.push(`($${base + 1}, $${base + 2}, 'monitored', $${base + 3}::int, 'natural')`);
    values.push(`proj_${projectKey}`, projectKey, sequence % 6);
  }
  await pool.query(
    `INSERT INTO projects (project_id, project_key, pool_state, star, source) VALUES ${rows.join(', ')}
     ON CONFLICT DO NOTHING`,
    values
  );
}
