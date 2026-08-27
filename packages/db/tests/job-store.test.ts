import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/jobs/job-store.js';
import { migrateDatabase } from '../src/migrate.js';

describe('JobStore', () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it('returns the existing job when the idempotency key is enqueued again', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const jobs = new JobStore(database);

    const first = await jobs.enqueue({
      type: 'screen_account',
      idempotencyKey: 'screen:project-1',
      payload: { projectId: 'project-1' },
      priority: 10
    });
    const repeated = await jobs.enqueue({
      type: 'screen_account',
      idempotencyKey: 'screen:project-1',
      payload: { projectId: 'project-1' },
      priority: 99
    });

    expect(repeated).toEqual(first);
  });

  it('claims due jobs by priority without claiming future jobs', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const jobs = new JobStore(database);
    const now = new Date('2026-08-26T08:00:00.000Z');

    await jobs.enqueue({
      type: 'research_project',
      idempotencyKey: 'research:low',
      payload: { projectId: 'low' },
      priority: 100,
      runAfter: now
    });
    await jobs.enqueue({
      type: 'screen_account',
      idempotencyKey: 'screen:high',
      payload: { projectId: 'high' },
      priority: 10,
      runAfter: now
    });
    await jobs.enqueue({
      type: 'screen_account',
      idempotencyKey: 'screen:future',
      payload: { projectId: 'future' },
      priority: 1,
      runAfter: new Date('2026-08-26T09:00:00.000Z')
    });

    await expect(jobs.claim({ workerId: 'worker-1', now })).resolves.toMatchObject({
      idempotencyKey: 'screen:high',
      status: 'running'
    });
    await expect(jobs.claim({ workerId: 'worker-1', now })).resolves.toMatchObject({
      idempotencyKey: 'research:low',
      status: 'running'
    });
    await expect(jobs.claim({ workerId: 'worker-1', now })).resolves.toBeNull();
  });

  it('retries failed jobs after the delay and marks exhausted jobs dead', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const jobs = new JobStore(database);
    const firstAttemptAt = new Date('2026-08-26T08:00:00.000Z');

    await jobs.enqueue({
      type: 'research_project',
      idempotencyKey: 'research:retry',
      payload: { projectId: 'project-1' },
      maxAttempts: 2,
      runAfter: firstAttemptAt
    });
    const first = await jobs.claim({ workerId: 'worker-1', now: firstAttemptAt });
    expect(first).not.toBeNull();

    await expect(
      jobs.fail({
        jobId: first!.id,
        workerId: 'worker-1',
        error: 'temporary failure',
        now: firstAttemptAt,
        retryDelayMs: 60_000
      })
    ).resolves.toMatchObject({ status: 'retry' });
    await expect(jobs.claim({ workerId: 'worker-1', now: firstAttemptAt })).resolves.toBeNull();

    const secondAttemptAt = new Date('2026-08-26T08:01:00.000Z');
    const second = await jobs.claim({ workerId: 'worker-1', now: secondAttemptAt });
    expect(second).not.toBeNull();
    await expect(
      jobs.fail({
        jobId: second!.id,
        workerId: 'worker-1',
        error: 'permanent failure',
        now: secondAttemptAt,
        retryDelayMs: 60_000
      })
    ).resolves.toMatchObject({ status: 'dead' });
    await expect(
      jobs.claim({ workerId: 'worker-1', now: new Date('2026-08-26T09:00:00.000Z') })
    ).resolves.toBeNull();
  });

  it('recovers an abandoned claim and keeps completed work out of the queue', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const jobs = new JobStore(database);
    const startedAt = new Date('2026-08-26T08:00:00.000Z');

    await jobs.enqueue({
      type: 'screen_account',
      idempotencyKey: 'screen:abandoned',
      payload: { projectId: 'project-1' },
      runAfter: startedAt
    });
    const abandoned = await jobs.claim({ workerId: 'worker-lost', now: startedAt });
    expect(abandoned).not.toBeNull();

    await expect(
      jobs.recoverAbandoned({
        lockedBefore: new Date('2026-08-26T08:04:00.000Z'),
        now: new Date('2026-08-26T08:05:00.000Z')
      })
    ).resolves.toBe(1);

    const recovered = await jobs.claim({
      workerId: 'worker-healthy',
      now: new Date('2026-08-26T08:05:00.000Z')
    });
    expect(recovered?.id).toBe(abandoned?.id);
    await jobs.complete({
      jobId: recovered!.id,
      workerId: 'worker-healthy',
      now: new Date('2026-08-26T08:06:00.000Z')
    });

    await expect(
      jobs.claim({ workerId: 'worker-healthy', now: new Date('2026-08-26T09:00:00.000Z') })
    ).resolves.toBeNull();
  });
});
