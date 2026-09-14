import 'dotenv/config';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStoragePool, resolveDatabaseUrl } from '../storage/client.js';
import { runMigrations, defaultMigrationsDirectory } from '../storage/migrate.js';
import {
  computeRpoMs,
  computeRtoMs,
  createBackup,
  formatDrillReport,
  readRestoredSnapshot,
  restoreDatabase,
  verifyRestore,
} from './backup-drill.js';

/**
 * 备份恢复演练入口（M5、验收方案第 5 节）：
 *   npm run drill:backup -- --source-url=<源库> --target-url=<空目标库> [--passphrase=...]
 *
 * 流程：读快照 → pg_dump →（可选加密）→ 恢复到空库 → 核验行数/指纹/迁移版本 → 计算 RPO/RTO。
 * 恢复目标库必须与源库不同；脚本不做删除，调用方负责准备空目标库。
 */

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const sourceUrl = arg('source-url') ?? resolveDatabaseUrl();
const targetUrl = arg('target-url');
if (!sourceUrl || !targetUrl) {
  console.error('需要 --source-url 与 --target-url（目标必须是空库，且与源库不同）');
  process.exit(1);
}
if (sourceUrl === targetUrl) {
  console.error('拒绝执行：源库与目标库相同，恢复会覆盖源数据。');
  process.exit(1);
}

const passphrase = arg('passphrase', '') || null;
const workDirectory = arg('work-dir') ?? (await mkdtemp(join(tmpdir(), 'djk-backup-')));
const failureAt = arg('failure-at') ? new Date(arg('failure-at')!) : new Date();

const sourcePool = createStoragePool({ connectionString: sourceUrl, max: 4, applicationName: 'djk-backup-src' });
const targetPool = createStoragePool({ connectionString: targetUrl, max: 4, applicationName: 'djk-backup-dst' });

try {
  // 目标库先迁移到与源库相同的 schema 版本（空环境恢复需要先有结构）。
  await runMigrations({ client: targetPool, directory: defaultMigrationsDirectory(process.cwd()) });

  console.info('== 生成备份 ==');
  const backupOptions: Parameters<typeof createBackup>[1] = {
    connectionString: sourceUrl,
    outputDirectory: workDirectory,
  };
  if (passphrase) backupOptions.passphrase = passphrase;
  const backup = await createBackup(sourcePool, backupOptions);
  console.info(
    `备份完成：${backup.manifest.fileName}（${(backup.bytes / 1024 / 1024).toFixed(2)} MB，` +
      `覆盖到 ${backup.manifest.coveredDataThrough ?? '无数据'}）`
  );

  console.info('== 恢复 ==');
  const recoveryStartedAt = new Date();
  // 清空目标库业务表，确保是“空环境”恢复而不是叠加。
  await targetPool.query(
    `TRUNCATE delivery_records, decisions, reports, jobs, project_contract_addresses, project_identifiers,
              projects, inbound_events, discussion_mappings, config_versions, audit_records,
              tweets, tweet_mentions, tweet_poll_state, sessions, access_credentials RESTART IDENTITY CASCADE`
  );
  const restoreOptions: Parameters<typeof restoreDatabase>[0] = {
    connectionString: targetUrl,
    dumpPath: backup.backupPath,
  };
  if (passphrase) restoreOptions.passphrase = passphrase;
  await restoreDatabase(restoreOptions);

  const actual = await readRestoredSnapshot(targetUrl);
  const verification = verifyRestore(backup.manifest, actual);
  const verifiedAt = new Date();

  const report = formatDrillReport({
    manifest: backup.manifest,
    verification,
    rpoMs: computeRpoMs({ coveredDataThrough: backup.manifest.coveredDataThrough, failureAt }),
    rtoMs: computeRtoMs({ recoveryStartedAt, verifiedAt }),
    backupBytes: backup.bytes,
  });
  console.info(report);
  console.info(`工作目录：${workDirectory}`);
  if (verification.differences.length > 0) process.exitCode = 2;
} catch (error) {
  console.error(`演练失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sourcePool.close();
  await targetPool.close();
}
