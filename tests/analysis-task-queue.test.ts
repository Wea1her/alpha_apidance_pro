import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisTaskQueue, startAnalysisRetryWorker } from '../src/analysis-task-queue.js';

async function createQueue(options: { maxAttempts?: number; baseDelayMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'analysis-task-queue-'));
  const queue = new AnalysisTaskQueue({
    filePath: join(dir, 'analysis-tasks.jsonl'),
    deadLetterPath: join(dir, 'analysis-dead-letter.jsonl'),
    maxAttempts: options.maxAttempts,
    baseDelayMs: options.baseDelayMs ?? 1000,
    maxDelayMs: 10_000
  });
  return { dir, queue };
}

const task = {
  taskKey: '-1003903535780:88',
  projectKey: 'b',
  channelChatId: -1003903535780,
  channelMessageId: 88,
  title: 'A 关注了 B',
  content: '用户简介: builder',
  link: 'https://x.com/b',
  count: 12,
  star: 3
};

describe('AnalysisTaskQueue', () => {
  it('persists tasks and returns due items', async () => {
    const { queue } = await createQueue();
    await queue.enqueue(task, new Date('2026-05-16T00:00:00.000Z'));

    await expect(queue.listDue(new Date('2026-05-16T00:00:01.000Z'))).resolves.toMatchObject([
      {
        taskKey: task.taskKey,
        retryCount: 0,
        projectKey: 'b'
      }
    ]);
  });

  it('upserts tasks by key instead of duplicating them', async () => {
    const { queue } = await createQueue();
    await queue.enqueue(task, new Date('2026-05-16T00:00:00.000Z'));
    await queue.enqueue({ ...task, star: 4 }, new Date('2026-05-16T00:00:01.000Z'));

    const records = await queue.listAll();
    expect(records).toHaveLength(1);
    expect(records[0].star).toBe(4);
  });

  it('moves tasks to dead letter after max attempts', async () => {
    const { dir, queue } = await createQueue({ maxAttempts: 1 });
    await queue.enqueue(task, new Date('2026-05-16T00:00:00.000Z'));

    await expect(queue.markFailure(task.taskKey, new Error('mapping pending'))).resolves.toBe('dead-letter');
    await expect(queue.listAll()).resolves.toEqual([]);

    const deadLetter = await readFile(join(dir, 'analysis-dead-letter.jsonl'), 'utf8');
    expect(deadLetter).toContain(task.taskKey);
    expect(deadLetter).toContain('mapping pending');
  });
});

describe('startAnalysisRetryWorker', () => {
  it('removes tasks after successful processing', async () => {
    const { queue } = await createQueue();
    await queue.enqueue(task, new Date('2026-05-16T00:00:00.000Z'));

    const process = vi.fn().mockResolvedValue({ status: 'done' });
    const stop = startAnalysisRetryWorker({
      queue,
      process,
      intervalMs: 60_000,
      info: vi.fn(),
      warn: vi.fn()
    });

    await vi.waitFor(() => {
      expect(process).toHaveBeenCalledTimes(1);
    });
    stop();

    await expect(queue.listAll()).resolves.toEqual([]);
  });

  it('keeps tasks for retry when process requests retry', async () => {
    const { queue } = await createQueue();
    await queue.enqueue(task, new Date('2026-05-16T00:00:00.000Z'));

    const process = vi.fn().mockResolvedValue({ status: 'retry', reason: 'mapping pending' });
    const stop = startAnalysisRetryWorker({
      queue,
      process,
      intervalMs: 60_000,
      info: vi.fn(),
      warn: vi.fn()
    });

    await vi.waitFor(() => {
      expect(process).toHaveBeenCalledTimes(1);
    });
    stop();

    const records = await queue.listAll();
    expect(records).toHaveLength(1);
    expect(records[0].retryCount).toBe(1);
    expect(records[0].lastError).toContain('mapping pending');
  });
});
