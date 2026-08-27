import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../src/migrate.js';
import { OutboxStore } from '../src/outbox/outbox-store.js';

describe('OutboxStore', () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it('tracks delivery independently for each consumer', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const outbox = new OutboxStore(database);

    const first = await outbox.append({
      type: 'project.visible',
      aggregateType: 'project',
      aggregateId: 'project-1',
      version: 1,
      payload: { projectId: 'project-1' },
      idempotencyKey: 'project.visible:project-1:1'
    });
    const repeated = await outbox.append({
      type: 'project.visible',
      aggregateType: 'project',
      aggregateId: 'project-1',
      version: 1,
      payload: { projectId: 'project-1' },
      idempotencyKey: 'project.visible:project-1:1'
    });
    expect(repeated).toEqual(first);

    await expect(outbox.listPending('sse')).resolves.toEqual([first]);
    await expect(outbox.listPending('telegram')).resolves.toEqual([first]);

    await outbox.markDelivered(first.id, 'sse');

    await expect(outbox.listPending('sse')).resolves.toEqual([]);
    await expect(outbox.listPending('telegram')).resolves.toEqual([first]);
  });
});
