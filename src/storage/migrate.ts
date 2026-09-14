import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 迁移执行器：按文件名顺序执行 migrations/*.sql，并在 schema_migrations 中记录已应用版本。
 *
 * 约束：
 * - 每个文件的 SQL 自行包含 BEGIN/COMMIT；迁移器不再包一层事务，避免嵌套事务语义混乱。
 * - 已应用的版本不会重复执行；同一版本内容变化需要新增迁移文件，不修改历史文件。
 * - 失败时抛出错误并停止，不做部分回退（PostgreSQL 的 DDL 事务保证单文件原子性）。
 */

export interface MigrationClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface AppliedMigration {
  version: string;
  name: string;
  appliedAt: string;
}

export interface MigrationSummary {
  applied: string[];
  skipped: string[];
}

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function parseMigrationFileName(fileName: string): { version: string; name: string } | null {
  const matched = MIGRATION_FILE_PATTERN.exec(fileName);
  if (!matched) return null;
  return { version: matched[1]!, name: matched[2]! };
}

export async function listMigrationFiles(directory: string): Promise<Array<{ version: string; name: string; path: string }>> {
  const entries = await readdir(directory);
  return entries
    .map((fileName) => {
      const parsed = parseMigrationFileName(fileName);
      return parsed ? { ...parsed, path: join(directory, fileName) } : null;
    })
    .filter((entry): entry is { version: string; name: string; path: string } => entry !== null)
    .sort((a, b) => a.version.localeCompare(b.version));
}

async function ensureMigrationsTable(client: MigrationClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function listAppliedMigrations(client: MigrationClient): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(client);
  const result = await client.query('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
  return result.rows.map((row) => ({
    version: String(row.version),
    name: String(row.name),
    appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
  }));
}

export interface RunMigrationsOptions {
  client: MigrationClient;
  directory: string;
  /** 迁移目录里出现但尚未应用的版本号（默认全部）。 */
  only?: readonly string[];
  log?: (message: string) => void;
}

export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationSummary> {
  const log = options.log ?? (() => undefined);
  await ensureMigrationsTable(options.client);

  const files = await listMigrationFiles(options.directory);
  const applied = new Set((await listAppliedMigrations(options.client)).map((row) => row.version));
  const only = options.only ? new Set(options.only) : null;

  const summary: MigrationSummary = { applied: [], skipped: [] };
  for (const file of files) {
    if (only && !only.has(file.version)) continue;
    if (applied.has(file.version)) {
      summary.skipped.push(file.version);
      continue;
    }

    const sql = await readFile(file.path, 'utf8');
    log(`应用迁移 ${file.version}_${file.name}`);
    await options.client.query(sql);
    await options.client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
      file.version,
      file.name,
    ]);
    summary.applied.push(file.version);
  }

  return summary;
}

/** 默认迁移目录：仓库根部 migrations/。 */
export function defaultMigrationsDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, 'migrations');
}
