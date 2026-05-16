import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { FailedMessageQueue, startFailedMessageRetryWorker } from '../src/failed-message-queue.js';

async function createQueue(options: { maxAttempts?: number; baseDelayMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'failed-message-queue-'));
  const queue = new FailedMessageQueue({
    filePath: join(dir, 'failed-messages.jsonl'),
    deadLetterPath: join(dir, 'dead-letter.jsonl'),
    maxAttempts: options.maxAttempts,
    baseDelayMs: options.baseDelayMs ?? 1000,
    maxDelayMs: 10_000
  });
  return { dir, queue };
}

const failedRecord = {
  dedupeKey: 'follow|https://x.com/b|A 关注了 B|1778660297',
  raw: JSON.stringify({
    channel: 'follow',
    title: 'A 关注了 B',
    content: '你关注的8个用户也关注了ta',
    link: 'https://x.com/b',
    push_at: 1778660297
  }),
  text: 'TG message',
  receivedAt: '2026-05-16T00:00:00.000Z',
  count: 8,
  star: 2,
  lastError: 'fetch failed'
};

describe('FailedMessageQueue', () => {
  it('persists failed main push records and returns due records', async () => {
    const { queue } = await createQueue();
    await queue.enqueue(failedRecord, new Date('2026-05-16T00:00:00.000Z'));

    await expect(queue.listDue(new Date('2026-05-16T00:00:01.000Z'))).resolves.toMatchObject([
      {
        dedupeKey: failedRecord.dedupeKey,
        retryCount: 0,
        text: 'TG message',
        count: 8,
        star: 2
      }
    ]);
  });

  it('upserts records by dedupe key instead of duplicating them', async () => {
    const { queue } = await createQueue();
    await queue.enqueue(failedRecord, new Date('2026-05-16T00:00:00.000Z'));
    await queue.enqueue({ ...failedRecord, text: 'updated text' }, new Date('2026-05-16T00:00:01.000Z'));

    const records = await queue.listAll();
    expect(records).toHaveLength(1);
    expect(records[0].text).toBe('updated text');
  });

  it('moves records to dead letter after the max retry count', async () => {
    const { dir, queue } = await createQueue({ maxAttempts: 1 });
    await queue.enqueue(failedRecord, new Date('2026-05-16T00:00:00.000Z'));

    await expect(queue.markFailure(failedRecord.dedupeKey, new Error('fetch failed'))).resolves.toBe('dead-letter');
    await expect(queue.listAll()).resolves.toEqual([]);

    const deadLetter = await readFile(join(dir, 'dead-letter.jsonl'), 'utf8');
    expect(deadLetter).toContain(failedRecord.dedupeKey);
    expect(deadLetter).toContain('fetch failed');
  });
});

describe('startFailedMessageRetryWorker', () => {
  it('retries due records, removes them after success, and runs afterDelivered', async () => {
    const { queue } = await createQueue();
    await queue.enqueue(failedRecord, new Date('2026-05-16T00:00:00.000Z'));

    const delivered = new Set<string>();
    const inFlight = new Set<string>();
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 99 });
    const afterDelivered = vi.fn();

    const stop = startFailedMessageRetryWorker({
      queue,
      delivered,
      inFlight,
      send,
      afterDelivered,
      intervalMs: 60_000,
      info: vi.fn(),
      warn: vi.fn()
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    stop();

    expect(send).toHaveBeenCalledWith('TG message');
    expect(delivered.has(failedRecord.dedupeKey)).toBe(true);
    await expect(queue.listAll()).resolves.toEqual([]);
    expect(afterDelivered).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'A 关注了 B' }),
      8,
      2,
      { chatId: -1001, messageId: 99 }
    );
  });
});
