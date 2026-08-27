import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '@alpha-research/db';
import { registerEventRoute } from '../src/routes/events.js';

describe('events SSE route', () => {
  const databases: PGlite[] = [];
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });

  it('delivers outbox events as default browser messages with a time-safe cursor', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const createdAt = '2026-08-27T03:00:00.000Z';
    await database.query(
      `insert into outbox_events (type, aggregate_type, aggregate_id, version, payload, idempotency_key, created_at)
       values ('signal.created', 'project', 'project-1', 1, '{}'::jsonb, 'sse-test-1', $1),
              ('report.ready', 'project', 'project-1', 2, '{}'::jsonb, 'sse-test-2', $1)`,
      [createdAt]
    );
    const app = Fastify(); apps.push(app); registerEventRoute(app, { database, pollMs: 1, maxDurationMs: 10 }); await app.ready();
    const response = await app.inject({ method: 'GET', url: '/events' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: {"type":"signal.created"');
    expect(response.body).toContain('data: {"type":"report.ready"');
    expect(response.body).not.toContain('event: signal.created');
    expect(response.body).toContain(`id: ${createdAt}|`);
  });
});
