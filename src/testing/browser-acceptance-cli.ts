import 'dotenv/config';
import { createStoragePool, resolveDatabaseUrl, type StoragePool } from '../storage/client.js';
import { formatBrowserAcceptanceReport, runBrowserAcceptance } from './browser-acceptance.js';

/**
 * 浏览器端验收入口：
 *   npm run bench:browser -- --base-url=http://127.0.0.1:3080 --access-key=... --sessions=10 --duration=20
 *
 * 需要服务已在运行（npm run api:start）。默认复用系统 Chrome，不下载自带浏览器。
 * `--with-visibility` 会向数据库写入一条状态并观测页面可见时间（需要 --database-url）。
 */

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const baseUrl = arg('base-url', process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3080')!;
const accessKey = arg('access-key', process.env.E2E_ACCESS_KEY ?? '') || null;
const databaseUrl = arg('database-url') ?? resolveDatabaseUrl();

let pool: StoragePool | null = null;
let commitMarker: Parameters<typeof runBrowserAcceptance>[0]['commitMarker'];

if (process.argv.includes('--with-visibility')) {
  if (!databaseUrl) {
    console.error('启用 --with-visibility 需要 --database-url 或 DATABASE_URL');
    process.exit(1);
  }
  pool = createStoragePool({ connectionString: databaseUrl, max: 4, applicationName: 'djk-browser-visibility' });
  const marker = `VIS-${Date.now().toString(36).toUpperCase()}`;

  // 写一条“可展示的状态”：新项目 + 一条判定记录，页面列表与时间线都会显示它。
  commitMarker = {
    marker,
    commit: async (text: string) => {
      const projectId = `vis-${text}`;
      const projectKey = text.toLowerCase();
      // 用最高星：项目列表按 (星级 DESC, 加入时间 DESC) 排序且只取前若干条，
      // 若用低星，新项目会被大量高星项目挤出可见范围，造成“看不见”的假象（这正是首次实测的教训）。
      await pool!.query(
        `INSERT INTO projects (project_id, project_key, display_name, source, pool_state, star, entered_pool_at)
         VALUES ($1, $2, $3, 'natural', 'monitored', 9, now()) ON CONFLICT DO NOTHING`,
        [projectId, projectKey, text]
      );
      const eventId = `${projectId}-evt`;
      await pool!.query(
        `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload)
         VALUES ($1, 'visibility-probe', $2, now(), '{}') ON CONFLICT DO NOTHING`,
        [eventId, Math.floor(Date.now() % 1_000_000)]
      );
      await pool!.query(
        `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at, star)
         VALUES ($1, $2, $3, $4, 'PUSHED', now(), 9) ON CONFLICT DO NOTHING`,
        [`${projectId}-dec`, eventId, projectId, projectKey]
      );
      const committedAt = new Date();
      console.info(`已提交状态标记 ${text}（${committedAt.toISOString()}），等待页面显示…`);
      return { committedAt };
    },
  };
}

try {
  const result = await runBrowserAcceptance({
    baseUrl,
    accessKey,
    sessions: Number(arg('sessions', '10')),
    durationMs: Number(arg('duration', '20')) * 1_000,
    pollIntervalMs: Number(arg('interval', '2000')),
    ...(commitMarker ? { commitMarker } : {}),
    ...(arg('chrome-path') ? { executablePath: arg('chrome-path')! } : {}),
  });
  console.info(
    formatBrowserAcceptanceReport(result, {
      listP95Ms: Number(arg('target-p95', '1000')),
      stateVisibleMs: Number(arg('target-visible', '3000')),
    })
  );
  const failedChecks = result.checks.filter((check) => !check.passed).length;
  if (result.errors.length > 0 || failedChecks > 0) process.exitCode = 2;
} catch (error) {
  console.error(`浏览器验收失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.close();
}
