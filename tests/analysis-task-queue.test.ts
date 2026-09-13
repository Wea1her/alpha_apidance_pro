import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisTaskQueue, startAnalysisRetryWorker, type AnalysisTaskRecord, type DeepAnalysisProgress } from '../src/analysis-task-queue.js';

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
  mainPushedAt: '2026-05-16T00:00:00.500Z',
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
        projectKey: 'b',
        mainPushedAt: task.mainPushedAt
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
    expect(records[0].mainPushedAt).toBe(task.mainPushedAt);
  });

  it('uses the latest input main push time when upserting tasks', async () => {
    const { queue } = await createQueue();
    await queue.enqueue(task, new Date('2026-05-16T00:00:00.000Z'));
    await queue.enqueue(
      { ...task, mainPushedAt: '2026-05-16T00:00:02.500Z' },
      new Date('2026-05-16T00:00:02.000Z')
    );

    const records = await queue.listAll();
    expect(records).toHaveLength(1);
    expect(records[0].mainPushedAt).toBe('2026-05-16T00:00:02.500Z');
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

  it('dedupes corrupted duplicate task rows by task key', async () => {
    const { dir, queue } = await createQueue();
    const filePath = join(dir, 'analysis-tasks.jsonl');
    const now = '2026-05-16T00:00:00.000Z';
    const duplicateRecord = {
      version: 1,
      ...task,
      retryCount: 0,
      nextRetryAt: now,
      createdAt: now,
      updatedAt: now
    };
    await writeFile(
      filePath,
      `${JSON.stringify(duplicateRecord)}\n${JSON.stringify({ ...duplicateRecord, star: 4 })}\n`,
      'utf8'
    );

    await expect(queue.listDue(new Date('2026-05-16T00:00:01.000Z'))).resolves.toHaveLength(1);

    await queue.markFailure(task.taskKey, new Error('mapping pending'), new Date('2026-05-16T00:00:01.000Z'));
    await expect(queue.listAll()).resolves.toHaveLength(1);
  });

  it('allows only one active processing lock per task key', async () => {
    const { queue } = await createQueue();
    const release = await queue.tryAcquireProcessingLock(task.taskKey);

    expect(release).toEqual(expect.any(Function));
    await expect(queue.tryAcquireProcessingLock(task.taskKey)).resolves.toBeNull();

    await release!();
    const releaseAgain = await queue.tryAcquireProcessingLock(task.taskKey);
    expect(releaseAgain).toEqual(expect.any(Function));
    await releaseAgain!();
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

  it('processes duplicate due task rows only once', async () => {
    const { dir, queue } = await createQueue();
    const filePath = join(dir, 'analysis-tasks.jsonl');
    const now = '2026-05-16T00:00:00.000Z';
    const duplicateRecord = {
      version: 1,
      ...task,
      retryCount: 0,
      nextRetryAt: now,
      createdAt: now,
      updatedAt: now
    };
    await writeFile(
      filePath,
      `${JSON.stringify(duplicateRecord)}\n${JSON.stringify({ ...duplicateRecord, star: 4 })}\n`,
      'utf8'
    );

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
});

describe('deep task persistence', () => {
  const deepTask = { ...task, taskKey: `${task.taskKey}:deep`, star: 5, kind: 'deep' as const };
  const progress: DeepAnalysisProgress = {
    analysisText: '深度报告正文',
    analysisCreatedAt: '2026-09-13T05:00:00.000Z',
    discussionChatId: '-1002',
    replyToMessageId: 99,
    messageTexts: ['Grok 深度分析\n\n深度报告正文'],
    sentMessages: []
  };

  it('keeps the first five-star message through concurrent hits and a queue restart', async () => {
    const { dir, queue } = await createQueue();
    expect(await Promise.all([
      queue.enqueue(deepTask),
      queue.enqueue({ ...deepTask, taskKey: 'later:deep', channelMessageId: 100 })
    ])).toEqual([true, false]);
    const restarted = new AnalysisTaskQueue({
      filePath: join(dir, 'analysis-tasks.jsonl'), deadLetterPath: join(dir, 'analysis-dead-letter.jsonl')
    });
    await expect(restarted.enqueue({ ...deepTask, taskKey: 'after-restart:deep' })).resolves.toBe(false);
    await expect(restarted.listAll()).resolves.toMatchObject([{ channelMessageId: 88, taskKey: deepTask.taskKey }]);
  });

  it('retains generated progress while standard tasks are concurrently enqueued and removed', async () => {
    const { dir, queue } = await createQueue();
    const other = new AnalysisTaskQueue({
      filePath: join(dir, 'analysis-tasks.jsonl'), deadLetterPath: join(dir, 'analysis-dead-letter.jsonl')
    });
    await queue.enqueue(deepTask);
    await queue.enqueue({ ...task, taskKey: 'finished-standard' });
    await Promise.all([
      queue.saveDeepProgress(deepTask.taskKey, progress),
      other.enqueue(task),
      other.remove('finished-standard')
    ]);
    await queue.markFailure(deepTask.taskKey, new Error('retry delivery'));
    const rows = await other.listAll();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.kind === 'deep')).toMatchObject({ deepProgress: progress, retryCount: 1 });
    expect(rows.find((row) => row.kind !== 'deep')?.taskKey).toBe(task.taskKey);
    await expect(queue.saveDeepProgress('missing', progress)).rejects.toThrow('not found');
  });

  it('does not create another deep task after the first one enters dead letter', async () => {
    const { queue } = await createQueue({ maxAttempts: 1 });
    await queue.enqueue(deepTask);
    await queue.saveDeepProgress(deepTask.taskKey, progress);
    await expect(queue.markFailure(deepTask.taskKey, new Error('delivery exhausted'))).resolves.toBe('dead-letter');
    await expect(queue.enqueue({ ...deepTask, taskKey: 'later:deep' })).resolves.toBe(false);
    await expect(queue.enqueue({ ...deepTask, taskKey: 'another:deep', projectKey: 'another' })).resolves.toBe(true);
    await expect(queue.enqueue(task)).resolves.toBe(true);
  });

  it('does not let legacy duplicate tasks bypass a first five-star task in backoff', async () => {
    const { dir, queue } = await createQueue();
    const first = {
      ...deepTask, version: 1, retryCount: 1,
      createdAt: '2026-05-16T00:00:00.000Z', updatedAt: '2026-05-16T00:00:00.000Z',
      nextRetryAt: '2026-05-16T00:01:00.000Z'
    };
    const later = {
      ...first, taskKey: 'later:deep', channelMessageId: 100,
      mainPushedAt: '2026-05-16T00:00:10.000Z', nextRetryAt: '2026-05-16T00:00:10.000Z'
    };
    await writeFile(join(dir, 'analysis-tasks.jsonl'), `${JSON.stringify(later)}\n${JSON.stringify(first)}\n`);
    await expect(queue.listDue(new Date('2026-05-16T00:00:20Z'))).resolves.toEqual([]);
    await expect(queue.listDue(new Date('2026-05-16T00:01:00Z'))).resolves.toMatchObject([{ taskKey: first.taskKey }]);
  });

  it('keeps standard analysis running while an independent deep worker waits on its model', async () => {
    const { queue } = await createQueue();
    await queue.enqueue(deepTask);
    await queue.enqueue(task);
    let complete!: () => void;
    const waiting = new Promise<void>((resolve) => { complete = resolve; });
    const deepProcess = vi.fn(async (_task: AnalysisTaskRecord) => { await waiting; return { status: 'done' as const }; });
    const standardProcess = vi.fn().mockResolvedValue({ status: 'done' });
    const stopDeep = startAnalysisRetryWorker({
      queue, kind: 'deep', process: deepProcess, intervalMs: 60_000, info: vi.fn(), warn: vi.fn()
    });
    const stopStandard = startAnalysisRetryWorker({
      queue, kind: 'standard', process: standardProcess, intervalMs: 60_000, info: vi.fn(), warn: vi.fn()
    });
    try {
      await vi.waitFor(async () => {
        expect(deepProcess).toHaveBeenCalledOnce();
        expect(standardProcess).toHaveBeenCalledOnce();
        expect(await queue.listAll()).toHaveLength(1);
      });
      expect(standardProcess.mock.calls[0][0].kind).toBeUndefined();
      expect(deepProcess.mock.calls[0][0].kind).toBe('deep');
      complete();
      await vi.waitFor(async () => expect(await queue.listAll()).toEqual([]));
    } finally {
      complete();
      stopDeep();
      stopStandard();
    }
  });
});
