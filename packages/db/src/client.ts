import postgres, { type Sql } from 'postgres';
import type { MigrationDatabase } from './migrate.js';

export interface PostgresDatabase extends MigrationDatabase {
  close(): Promise<void>;
}

export function createPostgresDatabase(databaseUrl: string): PostgresDatabase {
  const sql: Sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10
  });

  return {
    async exec(statement) {
      await sql.unsafe(statement);
    },
    async query<T>(statement: string, params: unknown[] = []) {
      const rows = await sql.unsafe(statement, params as Parameters<Sql['unsafe']>[1]);
      return { rows: [...rows] as T[] };
    },
    async transaction<T>(callback: (database: MigrationDatabase) => Promise<T>): Promise<T> {
      return await sql.begin(async (transaction) => callback({
        async exec(statement: string) {
          await transaction.unsafe(statement);
        },
        async query<R>(statement: string, params: unknown[] = []) {
          const rows = await transaction.unsafe(statement, params as Parameters<Sql['unsafe']>[1]);
          return { rows: [...rows] as R[] };
        }
      })) as T;
    },
    async close() {
      await sql.end({ timeout: 5 });
    }
  };
}
