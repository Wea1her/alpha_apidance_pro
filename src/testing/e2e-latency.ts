import { performance } from 'node:perf_hooks';
import { summarizeLatencies, type LatencySummary } from './benchmark.js';

/**
 * 端到端延迟采集（M5、验收方案第 3 节）。
 *
 * 与 `benchmark.ts` 的区别：这里打的是**真实 HTTP 接口**，覆盖网络栈、Fastify 路由、
 * JSON 序列化与鉴权，比数据层更接近验收口径。但它仍不含浏览器渲染，
 * 因此与“状态可见 ≤3 秒”的完整口径仍需浏览器端采集（验收方案第 3 节要求 Playwright）。
 *
 * 只做只读请求，不触发模型调用或任务创建（第 8 节）。
 */

export interface E2ESessionConfig {
  baseUrl: string;
  sessions: number;
  durationMs: number;
  intervalMs: number;
  /** 已登录会话的 Cookie；未提供时只打公开只读接口。 */
  cookie?: string | null;
}

export interface E2EResult {
  baseUrl: string;
  sessions: number;
  durationMs: number;
  requests: number;
  errors: number;
  statusCounts: Record<string, number>;
  list: LatencySummary;
  detail: LatencySummary;
  health: LatencySummary;
  /** 采样口径说明，避免被当成完整端到端结论。 */
  scope: string;
}

interface Collect {
  list: number[];
  detail: number[];
  health: number[];
  errors: number;
  statusCounts: Record<string, number>;
}

async function timedFetch(url: string, cookie: string | null | undefined): Promise<{ ms: number; status: number; body: unknown }> {
  const started = performance.now();
  const response = await fetch(url, {
    headers: cookie ? { cookie } : undefined,
  });
  const text = await response.text();
  const ms = performance.now() - started;
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ms, status: response.status, body };
}

function record(collect: Collect, bucket: number[], ms: number, status: number): void {
  bucket.push(ms);
  collect.statusCounts[String(status)] = (collect.statusCounts[String(status)] ?? 0) + 1;
  if (status >= 400) collect.errors += 1;
}

async function runSession(config: E2ESessionConfig, collect: Collect, stopAt: number): Promise<void> {
  let round = 0;
  // 每个会话先取一个项目 ID，用于详情页请求（模拟真实浏览）。
  let projectId: string | null = null;
  while (performance.now() < stopAt) {
    round += 1;
    try {
      if (round % 5 === 0) {
        const result = await timedFetch(`${config.baseUrl}/api/health`, config.cookie);
        record(collect, collect.health, result.ms, result.status);
      } else {
        const query = round % 3 === 0 ? '?limit=20&stars=3,4,5' : '?limit=50';
        const result = await timedFetch(`${config.baseUrl}/api/projects${query}`, config.cookie);
        record(collect, collect.list, result.ms, result.status);
        const rows = (result.body as { rows?: Array<{ projectId: string }> } | null)?.rows;
        if (!projectId && rows && rows.length > 0) projectId = rows[0]!.projectId;
        if (projectId && round % 3 === 1) {
          const detail = await timedFetch(`${config.baseUrl}/api/projects/${encodeURIComponent(projectId)}`, config.cookie);
          record(collect, collect.detail, detail.ms, detail.status);
        }
      }
    } catch {
      collect.errors += 1;
    }
    const elapsed = performance.now() - stopAt + config.intervalMs;
    const wait = Math.max(0, config.intervalMs - (performance.now() % config.intervalMs));
    void elapsed;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** 并发打真实 HTTP 接口并采集分位数。 */
export async function runE2ELatency(config: E2ESessionConfig): Promise<E2EResult> {
  const collect: Collect = { list: [], detail: [], health: [], errors: 0, statusCounts: {} };
  const startedAt = performance.now();
  const stopAt = startedAt + config.durationMs;
  await Promise.all(Array.from({ length: config.sessions }, () => runSession(config, collect, stopAt)));

  return {
    baseUrl: config.baseUrl,
    sessions: config.sessions,
    durationMs: Math.round(performance.now() - startedAt),
    requests: collect.list.length + collect.detail.length + collect.health.length,
    errors: collect.errors,
    statusCounts: collect.statusCounts,
    list: summarizeLatencies(collect.list),
    detail: summarizeLatencies(collect.detail),
    health: summarizeLatencies(collect.health),
    scope: 'HTTP 端到端（不含浏览器渲染与前端 JS 执行）',
  };
}

export function formatE2EReport(result: E2EResult, targets: { listP95Ms?: number; stateVisibleMs?: number } = {}): string {
  const listTarget = targets.listP95Ms ?? 1_000;
  const lines: string[] = [];
  lines.push('## 端到端延迟采集（HTTP）');
  lines.push('');
  lines.push(`目标：${result.baseUrl}；并发会话 ${result.sessions}；时长 ${(result.durationMs / 1000).toFixed(1)}s；请求 ${result.requests}；错误 ${result.errors}`);
  lines.push(`状态码分布：${JSON.stringify(result.statusCounts)}`);
  lines.push('');
  lines.push('| 接口 | n | p50 | p95 | p99 | max |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  const row = (label: string, summary: LatencySummary): string =>
    `| ${label} | ${summary.count} | ${summary.p50.toFixed(0)}ms | ${summary.p95.toFixed(0)}ms | ${summary.p99.toFixed(0)}ms | ${summary.max.toFixed(0)}ms |`;
  lines.push(row('列表 /api/projects', result.list));
  lines.push(row('详情 /api/projects/:id', result.detail));
  lines.push(row('健康 /api/health', result.health));
  lines.push('');
  lines.push(
    `列表 p95 ${result.list.p95.toFixed(0)}ms 对目标 ≤${listTarget}ms：${result.list.p95 <= listTarget ? '达标' : '未达标'}`
  );
  lines.push('');
  lines.push(`计量边界：${result.scope}。`);
  if (targets.stateVisibleMs) {
    lines.push(
      `注意：“状态可见 ≤${targets.stateVisibleMs}ms”包含浏览器渲染与轮询间隔，` +
        '本报告只能证明服务端响应时间，完整口径需浏览器端采集。'
    );
  }
  return lines.join('\n');
}
