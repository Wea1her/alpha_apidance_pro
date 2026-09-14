import 'dotenv/config';
import { createStoragePool, resolveDatabaseUrl } from './client.js';
import { defaultMigrationsDirectory, runMigrations } from './migrate.js';

/**
 * 迁移入口：`npm run db:migrate`
 *
 * 连接串来自 DATABASE_URL；未配置时直接失败并给出提示，不做静默降级
 * （第 9 节：数据库不可用时必须暴露异常，不能伪装成空状态）。
 */
async function main(): Promise<void> {
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL，无法执行迁移。请在 .env 中配置后再运行。');
    process.exitCode = 1;
    return;
  }

  const pool = createStoragePool({ connectionString: databaseUrl, applicationName: 'daxinjiankong-migrate' });
  try {
    const summary = await runMigrations({
      client: pool,
      directory: defaultMigrationsDirectory(process.cwd()),
      log: (message) => console.info(message),
    });
    if (summary.applied.length === 0) {
      console.info(`没有待执行的迁移（已应用 ${summary.skipped.length} 个版本）。`);
    } else {
      console.info(`迁移完成：新增 ${summary.applied.length} 个版本（${summary.applied.join(', ')}）。`);
    }
  } catch (error) {
    console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.close();
  }
}

await main();
