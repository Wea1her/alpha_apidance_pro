import 'dotenv/config';
import { createStoragePool, resolveDatabaseUrl } from '../storage/client.js';
import { formatFaultDrillReport, runFaultDrills } from './fault-drills.js';

/**
 * 故障注入演练入口：`npm run drill:faults`
 *
 * 使用 DATABASE_URL，并且拒绝在库名不含 test/bench 的库上执行（会写演练数据）。
 * 未实现的场景会明确标为 skipped，不会被算作通过。
 */
const databaseUrl = resolveDatabaseUrl();
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL；演练需要指向隔离的测试/压测库。');
  process.exit(1);
}
if (!/bench|test/i.test(databaseUrl)) {
  console.error('拒绝执行：DATABASE_URL 看起来不是测试/压测库（库名需含 test 或 bench）。');
  process.exit(1);
}

const pool = createStoragePool({ connectionString: databaseUrl, max: 8, applicationName: 'djk-fault-drill' });
try {
  const report = await runFaultDrills(pool);
  console.info(formatFaultDrillReport(report));
  // 有失败场景时以非零退出码结束，便于放进自动化验收。
  if (report.failed > 0) process.exitCode = 2;
} catch (error) {
  console.error(`演练失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.close();
}
