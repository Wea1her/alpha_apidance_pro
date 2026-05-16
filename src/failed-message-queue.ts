import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseAlphaMessage } from './alpha-client.js';
import type { TelegramSendResult } from './telegram.js';

export interface FailedMainPushRecord {
  version: 1;
  dedupeKey: string;
  raw: string;
  text: string;
  receivedAt: string;
  count: number;
  star: number;
  retryCount: number;
  nextRetryAt: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface FailedMainPushInput {
  dedupeKey: string;
  raw: string;
  text: string;
  receivedAt: string;
  count: number;
  star: number;
  lastError?: string;
}

export interface FailedMessageQueueOptions {
  filePath: string;
  deadLetterPath: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface StartFailedMessageRetryWorkerOptions {
  queue: FailedMessageQueue;
  intervalMs?: number;
  delivered: Set<string>;
  inFlight: Set<string>;
  send: (text: string) => Promise<TelegramSendResult>;
  afterDelivered?: (
    message: Record<string, unknown>,
    count: number,
    star: number,
    sendResult: TelegramSendResult
  ) => Promise<void>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelayMs(retryCount: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, retryCount - 1));
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

async function writeJsonl<T>(filePath: string, records: readonly T[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const content = records.map((record) => JSON.stringify(record)).join('\n');
  await writeFile(tempPath, content.length > 0 ? `${content}\n` : '', 'utf8');
  await rename(tempPath, filePath);
}

export class FailedMessageQueue {
  private readonly filePath: string;
  private readonly deadLetterPath: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: FailedMessageQueueOptions) {
    this.filePath = options.filePath;
    this.deadLetterPath = options.deadLetterPath;
    this.maxAttempts = options.maxAttempts ?? 20;
    this.baseDelayMs = options.baseDelayMs ?? 60_000;
    this.maxDelayMs = options.maxDelayMs ?? 3_600_000;
  }

  async enqueue(input: FailedMainPushInput, now = new Date()): Promise<void> {
    const records = await this.listAll();
    const existingIndex = records.findIndex((record) => record.dedupeKey === input.dedupeKey);
    const timestamp = now.toISOString();
    const record: FailedMainPushRecord = {
      version: 1,
      dedupeKey: input.dedupeKey,
      raw: input.raw,
      text: input.text,
      receivedAt: input.receivedAt,
      count: input.count,
      star: input.star,
      retryCount: existingIndex >= 0 ? records[existingIndex].retryCount : 0,
      nextRetryAt: existingIndex >= 0 ? records[existingIndex].nextRetryAt : timestamp,
      createdAt: existingIndex >= 0 ? records[existingIndex].createdAt : timestamp,
      updatedAt: timestamp,
      lastError: input.lastError
    };

    if (existingIndex >= 0) {
      records[existingIndex] = record;
    } else {
      records.push(record);
    }
    await writeJsonl(this.filePath, records);
  }

  async listAll(): Promise<FailedMainPushRecord[]> {
    return readJsonl<FailedMainPushRecord>(this.filePath);
  }

  async listDue(now = new Date()): Promise<FailedMainPushRecord[]> {
    const nowMs = now.getTime();
    return (await this.listAll()).filter((record) => new Date(record.nextRetryAt).getTime() <= nowMs);
  }

  async remove(dedupeKey: string): Promise<void> {
    const records = await this.listAll();
    await writeJsonl(
      this.filePath,
      records.filter((record) => record.dedupeKey !== dedupeKey)
    );
  }

  async markFailure(dedupeKey: string, error: unknown, now = new Date()): Promise<'pending' | 'dead-letter'> {
    const records = await this.listAll();
    const index = records.findIndex((record) => record.dedupeKey === dedupeKey);
    if (index < 0) return 'pending';

    const record = records[index];
    const retryCount = record.retryCount + 1;
    const updated: FailedMainPushRecord = {
      ...record,
      retryCount,
      updatedAt: now.toISOString(),
      lastError: errorMessage(error),
      nextRetryAt: new Date(now.getTime() + retryDelayMs(retryCount, this.baseDelayMs, this.maxDelayMs)).toISOString()
    };

    if (retryCount >= this.maxAttempts) {
      await mkdir(dirname(this.deadLetterPath), { recursive: true });
      await appendFile(this.deadLetterPath, `${JSON.stringify(updated)}\n`, 'utf8');
      records.splice(index, 1);
      await writeJsonl(this.filePath, records);
      return 'dead-letter';
    }

    records[index] = updated;
    await writeJsonl(this.filePath, records);
    return 'pending';
  }
}

export function startFailedMessageRetryWorker(options: StartFailedMessageRetryWorkerOptions): () => void {
  const intervalMs = options.intervalMs ?? 30_000;
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const dueRecords = await options.queue.listDue();
      for (const record of dueRecords) {
        if (options.delivered.has(record.dedupeKey)) {
          await options.queue.remove(record.dedupeKey);
          continue;
        }
        if (options.inFlight.has(record.dedupeKey)) {
          continue;
        }

        options.inFlight.add(record.dedupeKey);
        try {
          const sendResult = await options.send(record.text);
          options.delivered.add(record.dedupeKey);
          await options.queue.remove(record.dedupeKey);
          info(`主推送补发成功：dedupeKey=${record.dedupeKey}`);

          if (options.afterDelivered) {
            try {
              const message = parseAlphaMessage(record.raw);
              await options.afterDelivered(message, record.count, record.star, sendResult);
            } catch (error) {
              warn(`主推送补发后的分析处理失败：${errorMessage(error)}`);
            }
          }
        } catch (error) {
          const status = await options.queue.markFailure(record.dedupeKey, error);
          if (status === 'dead-letter') {
            warn(`主推送补发超过最大次数，进入死信队列：dedupeKey=${record.dedupeKey} error=${errorMessage(error)}`);
          } else {
            warn(`主推送补发失败：dedupeKey=${record.dedupeKey} error=${errorMessage(error)}`);
          }
        } finally {
          options.inFlight.delete(record.dedupeKey);
        }
      }
    } catch (error) {
      warn(`扫描主推送失败队列失败：${errorMessage(error)}`);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          void poll();
        }, intervalMs);
      }
    }
  };

  void poll();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
