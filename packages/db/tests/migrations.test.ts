import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../src/migrate.js';

describe('migrateDatabase', () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it('creates the agreed core tables and can be run repeatedly', async () => {
    const database = new PGlite();
    databases.push(database);

    await migrateDatabase(database);
    await migrateDatabase(database);

    const result = await database.query<{ tablename: string }>(
      `select tablename
       from pg_tables
       where schemaname = 'public'
       order by tablename`
    );

    expect(result.rows.map((row) => row.tablename)).toEqual([
      'access_sessions',
      'ai_provider_profiles',
      'ai_provider_runs',
      'alpha_monitors',
      'calendar_events',
      'evidence',
      'jobs',
      'ledger_entries',
      'login_attempts',
      'outbox_deliveries',
      'outbox_events',
      'personal_notes',
      'project_aliases',
      'projects',
      'raw_events',
      'report_versions',
      'schema_migrations',
      'screening_decisions',
      'signals',
      'surges',
      'trench_memberships'
    ]);
  });
});
