import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../db/src/migrate.js';
import { AlphaHookIngestor } from '../src/hook-ingestor.js';

describe('AlphaHookIngestor', () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it('persists a decoded event and schedules exactly one job', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const ingestor = new AlphaHookIngestor(database);
    const payload = {
      event_id: 'evt-hook-1',
      type: 'follow',
      user_id: '12345',
      content: '你关注的 8 个用户也关注了ta'
    };

    await expect(ingestor.ingest(payload)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      decodeStatus: 'decoded'
    });
    await expect(ingestor.ingest(payload)).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      decodeStatus: 'decoded'
    });

    const raw = await database.query<{ count: string }>('select count(*)::text as count from raw_events');
    const jobs = await database.query<{ count: string }>('select count(*)::text as count from jobs');
    expect(raw.rows[0]?.count).toBe('1');
    expect(jobs.rows[0]?.count).toBe('1');
  });

  it('keeps invalid payloads for inspection without creating work', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const ingestor = new AlphaHookIngestor(database);

    await expect(ingestor.ingest('not-an-object')).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      decodeStatus: 'invalid'
    });

    const raw = await database.query<{ decode_status: string; decode_error: string }>(
      'select decode_status, decode_error from raw_events'
    );
    const jobs = await database.query<{ count: string }>('select count(*)::text as count from jobs');
    expect(raw.rows[0]).toMatchObject({ decode_status: 'invalid' });
    expect(raw.rows[0]?.decode_error).toContain('must be an object');
    expect(jobs.rows[0]?.count).toBe('0');
  });
});
