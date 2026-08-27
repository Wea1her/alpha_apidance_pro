import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationDatabase {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run the callback on one database connection inside a transaction when supported. */
  transaction?<T>(callback: (database: MigrationDatabase) => Promise<T>): Promise<T>;
}

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrateDatabase(database: MigrationDatabase): Promise<void> {
  if (database.transaction) {
    await database.transaction(async (transaction) => {
      // API and Worker start together in production. The advisory transaction lock
      // makes the migration check-and-apply sequence single-writer without relying
      // on a pool connection staying pinned across separate exec calls.
      await transaction.exec('select pg_advisory_xact_lock(742391);');
      await migrateOnDatabase(transaction);
    });
    return;
  }

  await migrateOnDatabase(database);
}

async function migrateOnDatabase(database: MigrationDatabase): Promise<void> {
  await database.exec(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = await database.query<{ name: string }>('select name from schema_migrations');
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    if (appliedNames.has(file)) continue;
    const sql = await readFile(join(migrationsDirectory, file), 'utf8');
    await database.exec(sql);
    await database.query('insert into schema_migrations (name) values ($1)', [file]);
  }
}
