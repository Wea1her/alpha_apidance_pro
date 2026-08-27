import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '@alpha-research/db';
import { buildApp } from '../src/app.js';

describe('Alpha Hook route', () => {
  const databases: PGlite[] = [];
  const apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it('accepts a valid secret and returns before downstream processing', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const app = await buildApp({
      database,
      accessKeyHash: 'unused',
      hookSecret: 'hook-secret',
      allowedOrigin: 'https://private.example',
      secureCookies: false
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/alpha/hook-secret',
      payload: { event_id: 'evt-1', user_id: '42', type: 'follow', content: '你关注的 8 个用户也关注了ta' }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, duplicate: false, status: 'decoded' });

    const repeated = await app.inject({
      method: 'POST',
      url: '/webhooks/alpha/hook-secret',
      payload: { event_id: 'evt-1', user_id: '42', type: 'follow', content: '你关注的 8 个用户也关注了ta' }
    });
    expect(repeated.statusCode).toBe(200);
  });

  it('does not reveal whether an invalid secret exists', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const app = await buildApp({
      database,
      accessKeyHash: 'unused',
      hookSecret: 'hook-secret',
      allowedOrigin: 'https://private.example',
      secureCookies: false
    });
    apps.push(app);
    await expect(
      app.inject({ method: 'POST', url: '/webhooks/alpha/wrong-secret', payload: { type: 'heartbeat' } })
    ).resolves.toMatchObject({ statusCode: 404 });
  });

  it('retains malformed JSON as an invalid raw event', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const app = await buildApp({ database, accessKeyHash: 'unused', hookSecret: 'hook-secret', allowedOrigin: 'https://private.example', secureCookies: false });
    apps.push(app);
    const response = await app.inject({
      method: 'POST', url: '/webhooks/alpha/hook-secret',
      headers: { 'content-type': 'application/json' }, payload: '{bad-json'
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, status: 'invalid' });
    const raw = await database.query<{ count: string }>(`select count(*)::text as count from raw_events where decode_status = 'invalid'`);
    expect(raw.rows[0]?.count).toBe('1');
  });
});
