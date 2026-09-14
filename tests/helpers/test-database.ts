import { readFileSync } from 'node:fs';
import { createStoragePool, type StoragePool } from '../../src/storage/client.js';
import { defaultMigrationsDirectory, listMigrationFiles, runMigrations } from '../../src/storage/migrate.js';

/**
 * 存储层集成测试的共享助手。
 *
 * 安全约束：只接受 TEST_DATABASE_URL，且库名必须包含 "test"——本助手会 DROP SCHEMA，
 * 绝不能指向生产库。数据库不可用时返回 null，调用方跳过用例。
 */

const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:55432/daxinjiankong_test';
const TEST_ENV_FILE = '.env.test';

/**
 * 读取 .env.test（若存在）填充 TEST_DATABASE_URL。
 * 这里不引入 dotenv：worker 进程不一定继承 CLI 的 --env-file，直接读文件最可靠。
 */
function loadTestEnvFile(): void {
  if (process.env.TEST_DATABASE_URL?.trim()) return;
  try {
    const content = readFileSync(TEST_ENV_FILE, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key === 'TEST_DATABASE_URL' && value.length > 0) {
        process.env.TEST_DATABASE_URL = value;
        return;
      }
    }
  } catch {
    // 没有 .env.test 时保持未配置状态，由调用方跳过。
  }
}

export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;
  try {
    if (!new URL(raw).pathname.includes('test')) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 连接测试库；不可用返回 null（不抛错，便于用例静默跳过）。 */
export async function openTestDatabase(): Promise<StoragePool | null> {
  loadTestEnvFile();
  const connectionString = resolveTestDatabaseUrl();
  if (!connectionString) return null;
  try {
    const pool = createStoragePool({ connectionString, max: 4, applicationName: 'daxinjiankong-test' });
    await pool.query('SELECT 1');
    // 双保险：连接成功后再确认库名，绝不操作非测试库。
    const current = await pool.query('SELECT current_database() AS name');
    const name = String(current.rows[0]?.name ?? '');
    if (!name.includes('test')) {
      await pool.close();
      return null;
    }
    return pool;
  } catch {
    return null;
  }
}

/**
 * 重建 public schema 并执行全部迁移；返回结果供断言。
 *
 * 传 forceAll 时会把迁移文件重新执行一遍（schema 刚被重建，记录表也一并清空了）。
 * 用例级隔离建议直接用本函数，语义等同于“全新环境”。
 */
export async function resetSchemaAndMigrate(
  pool: StoragePool,
  options: { forceAll?: boolean } = {}
): Promise<{ applied: string[] }> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  const directory = defaultMigrationsDirectory(process.cwd());
  const only = options.forceAll ? (await listMigrationFiles(directory)).map((file) => file.version) : undefined;
  const summary = await runMigrations({ client: pool, directory, only });
  return { applied: summary.applied };
}

/** 清空业务表但保留 schema 与已应用迁移记录。 */
export async function truncateBusinessTables(pool: StoragePool): Promise<void> {
  await pool.query(
    `TRUNCATE delivery_records, decisions, reports, jobs, project_contract_addresses, project_identifiers,
              projects, inbound_events, discussion_mappings, config_versions, audit_records RESTART IDENTITY CASCADE`
  );
}
