import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createStoragePool, type StoragePool } from '../storage/client.js';

const execFileAsync = promisify(execFile);

/**
 * 备份与恢复演练（M5、验收方案第 5 节、第 10.1 节）。
 *
 * 已确认目标：**最多丢 1 小时数据（RPO ≤1h）、2 小时内恢复（RTO ≤2h）**（Q11）。
 * 硬约束（第 10.1 节）：
 * - 以“服务器外已经完成且能验证恢复的备份”为准；
 * - **RPO 按备份实际覆盖的数据时间点计算，不能用上传完成时间代替**；
 * - 只检查本机备份命令成功不算合格备份；
 * - 恢复必须在空环境完成（不读原机数据目录），并核验账号、报告、任务、线程引用与权限。
 *
 * 本模块不引入新依赖：加密用系统 `gpg`（对称口令），生产建议按 Q27 改用 `age`；
 * 切换只需替换 encrypt/decrypt 两个实现，其余流程不变。
 */

export interface BackupManifest {
  /** 备份文件名（不含路径）。 */
  fileName: string;
  createdAt: string;
  /** 备份实际覆盖的数据时间点：库内最新一次接收记录的时间。 */
  coveredDataThrough: string | null;
  /** 各关键表行数，用于恢复后比对。 */
  rowCounts: Record<string, number>;
  /** 内容指纹：用于确认恢复出的数据与备份一致。 */
  contentHash: string;
  encrypted: boolean;
  schemaMigrationVersions: string[];
}

export interface CreateBackupOptions {
  /** 宿主机上的输出目录。 */
  outputDirectory: string;
  /** 生成备份的目标时间；用于 RPO 计算与文件名。 */
  now?: Date;
  /** 对称加密口令；提供时用 gpg 加密（生产按 Q27 换成 age）。 */
  passphrase?: string | null;
  /** 覆盖 pg_dump 调用方式（测试用）。 */
  runner?: CommandRunner;
  /** 数据库连接串。 */
  connectionString: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: CommandRunner = async (command, args) => {
  const result = await execFileAsync(command, [...args], { maxBuffer: 1024 * 1024 * 256 });
  return { stdout: result.stdout, stderr: result.stderr };
};

/** 需要核验行数的关键表（与验收方案第 5 节一致）。 */
export const BACKUP_VERIFY_TABLES = [
  'projects',
  'inbound_events',
  'decisions',
  'reports',
  'delivery_records',
  'jobs',
  'discussion_mappings',
  'config_versions',
  'access_credentials',
  'sessions',
] as const;

/** 读取库内备份覆盖的数据时间点与行数（备份前调用，结果写进 manifest）。 */
export async function readBackupSnapshot(pool: StoragePool): Promise<{
  coveredDataThrough: string | null;
  rowCounts: Record<string, number>;
  contentHash: string;
  schemaMigrationVersions: string[];
}> {
  const counts: Record<string, number> = {};
  for (const table of BACKUP_VERIFY_TABLES) {
    const result = await pool.query(`SELECT count(*)::int AS c FROM ${table}`);
    counts[table] = Number(result.rows[0]?.c ?? 0);
  }

  const latest = await pool.query(`SELECT max(received_at) AS latest FROM inbound_events`);
  const latestValue = latest.rows[0]?.latest;
  const coveredDataThrough =
    latestValue instanceof Date ? latestValue.toISOString() : latestValue ? String(latestValue) : null;

  // 内容指纹：所有接收记录的 (event_id, dedupe_key, push_at) 摘要。
  // 用它确认“恢复出来的确实是这份备份”，而不只是行数相同。
  const digest = await pool.query(
    `SELECT md5(coalesce(string_agg(event_id || ':' || coalesce(legacy_dedupe_key, '') || ':' ||
              coalesce(upstream_push_at_sec::text, ''), ',' ORDER BY event_id), '')) AS hash
       FROM inbound_events`
  );

  const migrations = await pool.query(`SELECT version FROM schema_migrations ORDER BY version`);

  return {
    coveredDataThrough,
    rowCounts: counts,
    contentHash: String(digest.rows[0]?.hash ?? ''),
    schemaMigrationVersions: migrations.rows.map((row) => String(row.version)),
  };
}

/** 导出数据库为自定义格式的 dump 文件（pg_dump -Fc）。 */
export async function dumpDatabase(options: {
  connectionString: string;
  outputPath: string;
  runner?: CommandRunner;
}): Promise<{ bytes: number }> {
  const runner = options.runner ?? defaultRunner;
  await mkdir(dirname(options.outputPath), { recursive: true });
  const result = await runner('pg_dump', ['--format=custom', '--no-owner', '--file', options.outputPath, options.connectionString]);
  void result;
  const info = await stat(options.outputPath);
  return { bytes: info.size };
}

/** 用对称口令加密备份（生产按 Q27 改用 age）。 */
export async function encryptBackup(options: {
  inputPath: string;
  outputPath: string;
  passphrase: string;
  runner?: CommandRunner;
}): Promise<{ bytes: number }> {
  const runner = options.runner ?? defaultRunner;
  await runner('gpg', [
    '--batch',
    '--yes',
    '--symmetric',
    '--cipher-algo',
    'AES256',
    '--passphrase',
    options.passphrase,
    '--output',
    options.outputPath,
    options.inputPath,
  ]);
  const info = await stat(options.outputPath);
  return { bytes: info.size };
}

/** 解密备份。 */
export async function decryptBackup(options: {
  inputPath: string;
  outputPath: string;
  passphrase: string;
  runner?: CommandRunner;
}): Promise<void> {
  const runner = options.runner ?? defaultRunner;
  await runner('gpg', [
    '--batch',
    '--yes',
    '--decrypt',
    '--passphrase',
    options.passphrase,
    '--output',
    options.outputPath,
    options.inputPath,
  ]);
}

/** 校验文件是否可读且非空；返回大小（字节）。 */
export async function verifyBackupFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`备份文件不可用：${path}`);
  }
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return { bytes: info.size, sha256: hash.digest('hex') };
}

export interface CreateBackupResult {
  manifest: BackupManifest;
  /** 落在磁盘上的文件路径（加密后）。 */
  backupPath: string;
  bytes: number;
}

/**
 * 完整备份流程：读快照 → pg_dump → 可选加密 → 校验文件。
 *
 * 注意：本函数只负责生成备份并如实记录“覆盖到哪个数据时间点”；
 * 上传到服务器外对象存储由部署脚本完成（第 10.1 节）。
 */
export async function createBackup(
  pool: StoragePool,
  options: CreateBackupOptions
): Promise<CreateBackupResult> {
  const now = options.now ?? new Date();
  const snapshot = await readBackupSnapshot(pool);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const plainPath = join(options.outputDirectory, `djk-${stamp}.dump`);
  const encrypted = Boolean(options.passphrase && options.passphrase.length > 0);
  const backupPath = encrypted ? `${plainPath}.gpg` : plainPath;

  const dumpOptions: { connectionString: string; outputPath: string; runner?: CommandRunner } = {
    connectionString: options.connectionString,
    outputPath: plainPath,
  };
  if (options.runner) dumpOptions.runner = options.runner;
  await dumpDatabase(dumpOptions);

  if (encrypted) {
    const encryptOptions: { inputPath: string; outputPath: string; passphrase: string; runner?: CommandRunner } = {
      inputPath: plainPath,
      outputPath: backupPath,
      passphrase: options.passphrase!,
    };
    if (options.runner) encryptOptions.runner = options.runner;
    await encryptBackup(encryptOptions);
  }

  const verified = await verifyBackupFile(backupPath);
  const manifest: BackupManifest = {
    fileName: backupPath.split('/').pop() ?? backupPath,
    createdAt: now.toISOString(),
    coveredDataThrough: snapshot.coveredDataThrough,
    rowCounts: snapshot.rowCounts,
    contentHash: snapshot.contentHash,
    encrypted,
    schemaMigrationVersions: snapshot.schemaMigrationVersions,
  };
  await writeFile(`${backupPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { manifest, backupPath, bytes: verified.bytes };
}

/** 计算 RPO：故障时间与备份实际覆盖时间点之差（毫秒）。 */
export function computeRpoMs(input: { coveredDataThrough: string | null; failureAt: Date }): number | null {
  if (!input.coveredDataThrough) return null;
  const covered = new Date(input.coveredDataThrough).getTime();
  if (Number.isNaN(covered)) return null;
  return Math.max(0, input.failureAt.getTime() - covered);
}

/** 计算 RTO：恢复开始到校验完成的时间（毫秒）。 */
export function computeRtoMs(input: { recoveryStartedAt: Date; verifiedAt: Date }): number {
  return Math.max(0, input.verifiedAt.getTime() - input.recoveryStartedAt.getTime());
}

export interface RestoreVerification {
  countsMatch: boolean;
  hashMatch: boolean;
  migrationsMatch: boolean;
  actual: {
    rowCounts: Record<string, number>;
    contentHash: string;
    coveredDataThrough: string | null;
    schemaMigrationVersions: string[];
  };
  differences: string[];
}

/** 恢复后核验：行数、内容指纹、迁移版本三者都要一致。 */
export function verifyRestore(manifest: BackupManifest, actual: RestoreVerification['actual']): RestoreVerification {
  const differences: string[] = [];

  for (const [table, expected] of Object.entries(manifest.rowCounts)) {
    const got = actual.rowCounts[table];
    if (got !== expected) differences.push(`表 ${table} 行数不一致：期望 ${expected}，实际 ${got ?? '缺失'}`);
  }
  const countsMatch = differences.length === 0;

  const hashMatch = manifest.contentHash === actual.contentHash;
  if (!hashMatch) differences.push(`内容指纹不一致：期望 ${manifest.contentHash}，实际 ${actual.contentHash}`);

  const expectedMigrations = [...manifest.schemaMigrationVersions].sort().join(',');
  const actualMigrations = [...actual.schemaMigrationVersions].sort().join(',');
  const migrationsMatch = expectedMigrations === actualMigrations;
  if (!migrationsMatch) {
    differences.push(`迁移版本不一致：期望 ${expectedMigrations}，实际 ${actualMigrations}`);
  }

  return { countsMatch, hashMatch, migrationsMatch, actual, differences };
}

/** 在目标库上执行恢复（空环境）。 */
export async function restoreDatabase(options: {
  connectionString: string;
  dumpPath: string;
  passphrase?: string | null;
  runner?: CommandRunner;
}): Promise<void> {
  const runner = options.runner ?? defaultRunner;
  let inputPath = options.dumpPath;

  if (options.passphrase && options.dumpPath.endsWith('.gpg')) {
    const decryptedPath = options.dumpPath.replace(/\.gpg$/, '.restored.dump');
    const decryptOptions: { inputPath: string; outputPath: string; passphrase: string; runner?: CommandRunner } = {
      inputPath: options.dumpPath,
      outputPath: decryptedPath,
      passphrase: options.passphrase,
    };
    if (options.runner) decryptOptions.runner = options.runner;
    await decryptBackup(decryptOptions);
    inputPath = decryptedPath;
  }

  // pg_restore 走连接串；--clean --if-exists 让恢复可重复执行。
  await runner('pg_restore', ['--no-owner', '--clean', '--if-exists', '--dbname', options.connectionString, inputPath]);
}

/** 恢复后重新读取核验数据。 */
export async function readRestoredSnapshot(
  connectionString: string
): Promise<RestoreVerification['actual']> {
  const pool = createStoragePool({ connectionString, max: 4, applicationName: 'djk-restore-verify' });
  try {
    const snapshot = await readBackupSnapshot(pool);
    return {
      rowCounts: snapshot.rowCounts,
      contentHash: snapshot.contentHash,
      coveredDataThrough: snapshot.coveredDataThrough,
      schemaMigrationVersions: snapshot.schemaMigrationVersions,
    };
  } finally {
    await pool.close();
  }
}

/** 演练报告：把 RPO/RTO 与核验结果写成可放进验收包的 Markdown。 */
export function formatDrillReport(input: {
  manifest: BackupManifest;
  verification: RestoreVerification;
  rpoMs: number | null;
  rtoMs: number;
  backupBytes: number;
  rpoTargetMs?: number;
  rtoTargetMs?: number;
}): string {
  const rpoTarget = input.rpoTargetMs ?? 60 * 60 * 1000;
  const rtoTarget = input.rtoTargetMs ?? 2 * 60 * 60 * 1000;
  const rpoOk = input.rpoMs !== null && input.rpoMs <= rpoTarget;
  const rtoOk = input.rtoMs <= rtoTarget;
  const passed = rpoOk && rtoOk && input.verification.differences.length === 0;

  const lines: string[] = [];
  lines.push('## 备份恢复演练报告');
  lines.push('');
  lines.push(`- 备份文件：${input.manifest.fileName}（${(input.backupBytes / 1024 / 1024).toFixed(2)} MB，${input.manifest.encrypted ? '已加密' : '未加密'}）`);
  lines.push(`- 备份覆盖数据时间点：${input.manifest.coveredDataThrough ?? '无数据'}`);
  lines.push(`- 备份生成时间：${input.manifest.createdAt}`);
  lines.push('');
  lines.push('| 指标 | 实测 | 目标 | 结论 |');
  lines.push('|---|---:|---:|---|');
  lines.push(
    `| RPO（数据丢失） | ${input.rpoMs === null ? '无法计算' : `${(input.rpoMs / 60000).toFixed(1)} 分钟`} | ≤ 60 分钟 | ${rpoOk ? '达标' : '未达标'} |`
  );
  lines.push(`| RTO（恢复耗时） | ${(input.rtoMs / 60000).toFixed(1)} 分钟 | ≤ 120 分钟 | ${rtoOk ? '达标' : '未达标'} |`);
  lines.push('');
  lines.push('### 恢复核验');
  lines.push('');
  lines.push(`- 行数一致：${input.verification.countsMatch ? '是' : '否'}`);
  lines.push(`- 内容指纹一致：${input.verification.hashMatch ? '是' : '否'}`);
  lines.push(`- 迁移版本一致：${input.verification.migrationsMatch ? '是' : '否'}`);
  for (const difference of input.verification.differences) lines.push(`  - ${difference}`);
  lines.push('');
  lines.push(`### 结论：${passed ? '**通过**' : '**未通过**'}`);
  lines.push('');
  lines.push('说明：RPO 按备份实际覆盖的数据时间点计算，不使用上传完成时间（第 10.1 节）。');
  return lines.join('\n');
}
