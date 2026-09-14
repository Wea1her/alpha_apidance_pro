import 'dotenv/config';
import { formatE2EReport, runE2ELatency } from './e2e-latency.js';

/**
 * 端到端延迟采集入口：
 *   npm run bench:e2e -- --base-url=http://127.0.0.1:3080 --sessions=10 --duration=20
 *
 * 只发只读请求；需要服务已在运行（npm run api:start）。
 */
function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const baseUrl = arg('base-url', process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3080');
const result = await runE2ELatency({
  baseUrl,
  sessions: Number(arg('sessions', '10')),
  durationMs: Number(arg('duration', '20')) * 1_000,
  intervalMs: Number(arg('interval', '2000')),
  cookie: arg('cookie', process.env.E2E_COOKIE ?? '') || null,
});
console.info(formatE2EReport(result, { listP95Ms: Number(arg('target-p95', '1000')), stateVisibleMs: 3_000 }));
if (result.errors > 0 || result.list.p95 > Number(arg('target-p95', '1000'))) process.exitCode = 2;
