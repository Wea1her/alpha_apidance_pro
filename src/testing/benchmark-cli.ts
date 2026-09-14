import 'dotenv/config';
import { createStoragePool, resolveDatabaseUrl } from '../storage/client.js';
import { formatIngestReport, formatQueryReport, runIngestScenario, runQueryScenario } from './benchmark.js';

/**
 * 压测入口：`npm run bench -- --scenario=query --sessions=10 --duration=15`
 *
 * 直接使用 DATABASE_URL。**禁止指向生产库**：脚本会写入合成流量。
 * 压测应在临时 VM 或隔离库里执行（Q20、验收方案第 3 节）。
 */
function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const databaseUrl = resolveDatabaseUrl();
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL；压测需要指向隔离的压测库。');
  process.exit(1);
}
if (!/bench|test/i.test(databaseUrl)) {
  console.error('拒绝执行：DATABASE_URL 看起来不是测试/压测库（库名需含 test 或 bench）。');
  process.exit(1);
}

const scenario = arg('scenario', 'query');
const pool = createStoragePool({ connectionString: databaseUrl, max: 20, applicationName: 'daxinjiankong-bench' });

try {
  if (scenario === 'ingest') {
    const result = await runIngestScenario(pool, {
      rate: Number(arg('rate', '20')),
      seconds: Number(arg('seconds', '60')),
      batchSize: Number(arg('batch', '10')),
    });
    console.info(formatIngestReport(result));
  } else {
    const result = await runQueryScenario(pool, {
      sessions: Number(arg('sessions', '10')),
      durationMs: Number(arg('duration', '15')) * 1_000,
      intervalMs: Number(arg('interval', '2000')),
      includeDetail: arg('detail', 'true') === 'true',
    });
    console.info(formatQueryReport(result));
  }
} catch (error) {
  console.error(`压测失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.close();
}
