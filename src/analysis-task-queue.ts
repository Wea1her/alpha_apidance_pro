import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AnalysisTaskRecord {
  version: 1;
  taskKey: string;
  projectKey: string;
  channelChatId: number;
  channelMessageId: number;
  title: string;
  content: string;
  link: string;
  mainPushedAt: string;
  count: number;
  star: number;
  retryCount: number;
  nextRetryAt: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface AnalysisTaskInput {
  taskKey: string;
  projectKey: string;
  channelChatId: number;
  channelMessageId: number;
  title: string;
  content: string;
  link: string;
  mainPushedAt: string;
  count: number;
  star: number;
  lastError?: string;
}

export interface AnalysisTaskQueueOptions {
  filePath: string;
  deadLetterPath: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  lockDir?: string;
  processingLockStaleMs?: number;
}

export interface AnalysisTaskProcessResult {
  status: 'done' | 'retry';
  reason?: string;
}

export interface StartAnalysisRetryWorkerOptions {
  queue: AnalysisTaskQueue;
  intervalMs?: number;
  process: (task: AnalysisTaskRecord) => Promise<AnalysisTaskProcessResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelayMs(retryCount: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, retryCount - 1));
}

function dedupeByTaskKey(records: AnalysisTaskRecord[]): AnalysisTaskRecord[] {
  const seen = new Set<string>();
  const deduped: AnalysisTaskRecord[] = [];
  for (const record of records) {
    if (seen.has(record.taskKey)) continue;
    seen.add(record.taskKey);
    deduped.push(record);
  }
  return deduped;
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

export class AnalysisTaskQueue {
  private readonly filePath: string;
  private readonly deadLetterPath: string;
  private readonly lockDir: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly processingLockStaleMs: number;

  constructor(options: AnalysisTaskQueueOptions) {
    this.filePath = options.filePath;
    this.deadLetterPath = options.deadLetterPath;
    this.lockDir = options.lockDir ?? `${options.filePath}.locks`;
    this.maxAttempts = options.maxAttempts ?? 30;
    this.baseDelayMs = options.baseDelayMs ?? 30_000;
    this.maxDelayMs = options.maxDelayMs ?? 3_600_000;
    this.processingLockStaleMs = options.processingLockStaleMs ?? 15 * 60_000;
  }

  private lockPath(taskKey: string): string {
    return join(this.lockDir, `${Buffer.from(taskKey).toString('base64url')}.lock`);
  }

  private async isStaleLock(lockPath: string, now: Date): Promise<boolean> {
    try {
      const stats = await stat(lockPath);
      return now.getTime() - stats.mtimeMs > this.processingLockStaleMs;
    } catch {
      return true;
    }
  }

  async tryAcquireProcessingLock(taskKey: string, now = new Date()): Promise<(() => Promise<void>) | null> {
    await mkdir(this.lockDir, { recursive: true });
    const lockPath = this.lockPath(taskKey);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(
        JSON.stringify({
          taskKey,
          pid: process.pid,
          createdAt: now.toISOString()
        }),
        'utf8'
      );
      return async () => {
        try {
          await unlink(lockPath);
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
          }
        }
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        if (await this.isStaleLock(lockPath, now)) {
          try {
            await unlink(lockPath);
          } catch {
            return null;
          }
          return this.tryAcquireProcessingLock(taskKey, now);
        }
        return null;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async enqueue(input: AnalysisTaskInput, now = new Date()): Promise<void> {
    const records = await this.listAll();
    const existing = records.find((record) => record.taskKey === input.taskKey);
    const timestamp = now.toISOString();
    const record: AnalysisTaskRecord = {
      version: 1,
      taskKey: input.taskKey,
      projectKey: input.projectKey,
      channelChatId: input.channelChatId,
      channelMessageId: input.channelMessageId,
      title: input.title,
      content: input.content,
      link: input.link,
      mainPushedAt: input.mainPushedAt,
      count: input.count,
      star: input.star,
      retryCount: existing ? existing.retryCount : 0,
      nextRetryAt: existing ? existing.nextRetryAt : timestamp,
      createdAt: existing ? existing.createdAt : timestamp,
      updatedAt: timestamp,
      lastError: input.lastError
    };

    await writeJsonl(this.filePath, [
      ...records.filter((existingRecord) => existingRecord.taskKey !== input.taskKey),
      record
    ]);
  }

  async listAll(): Promise<AnalysisTaskRecord[]> {
    return readJsonl<AnalysisTaskRecord>(this.filePath);
  }

  async listDue(now = new Date()): Promise<AnalysisTaskRecord[]> {
    const nowMs = now.getTime();
    return dedupeByTaskKey(
      (await this.listAll()).filter((record) => new Date(record.nextRetryAt).getTime() <= nowMs)
    );
  }

  async remove(taskKey: string): Promise<void> {
    const records = await this.listAll();
    await writeJsonl(
      this.filePath,
      records.filter((record) => record.taskKey !== taskKey)
    );
  }

  async markFailure(taskKey: string, error: unknown, now = new Date()): Promise<'pending' | 'dead-letter'> {
    const records = await this.listAll();
    const record = records.find((candidate) => candidate.taskKey === taskKey);
    if (!record) return 'pending';

    const retryCount = record.retryCount + 1;
    const updated: AnalysisTaskRecord = {
      ...record,
      retryCount,
      updatedAt: now.toISOString(),
      lastError: errorMessage(error),
      nextRetryAt: new Date(now.getTime() + retryDelayMs(retryCount, this.baseDelayMs, this.maxDelayMs)).toISOString()
    };

    if (retryCount >= this.maxAttempts) {
      await mkdir(dirname(this.deadLetterPath), { recursive: true });
      await appendFile(this.deadLetterPath, `${JSON.stringify(updated)}\n`, 'utf8');
      await writeJsonl(
        this.filePath,
        records.filter((candidate) => candidate.taskKey !== taskKey)
      );
      return 'dead-letter';
    }

    await writeJsonl(this.filePath, [
      ...records.filter((candidate) => candidate.taskKey !== taskKey),
      updated
    ]);
    return 'pending';
  }
}

export function startAnalysisRetryWorker(options: StartAnalysisRetryWorkerOptions): () => void {
  const intervalMs = options.intervalMs ?? 30_000;
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const dueTasks = await options.queue.listDue();
      for (const task of dueTasks) {
        let releaseLock: (() => Promise<void>) | null = null;
        try {
          releaseLock = await options.queue.tryAcquireProcessingLock(task.taskKey);
          if (!releaseLock) {
            continue;
          }
          const result = await options.process(task);
          if (result.status === 'done') {
            await options.queue.remove(task.taskKey);
            info(`分析补偿成功：taskKey=${task.taskKey}`);
            continue;
          }

          const status = await options.queue.markFailure(task.taskKey, new Error(result.reason ?? 'retry requested'));
          if (status === 'dead-letter') {
            warn(`分析补偿超过最大次数，进入死信队列：taskKey=${task.taskKey} reason=${result.reason ?? ''}`);
          } else {
            warn(`分析补偿待重试：taskKey=${task.taskKey} reason=${result.reason ?? ''}`);
          }
        } catch (error) {
          const status = await options.queue.markFailure(task.taskKey, error);
          if (status === 'dead-letter') {
            warn(`分析补偿超过最大次数，进入死信队列：taskKey=${task.taskKey} error=${errorMessage(error)}`);
          } else {
            warn(`分析补偿失败：taskKey=${task.taskKey} error=${errorMessage(error)}`);
          }
        } finally {
          if (releaseLock) {
            try {
              await releaseLock();
            } catch (error) {
              warn(`释放分析任务锁失败：taskKey=${task.taskKey} error=${errorMessage(error)}`);
            }
          }
        }
      }
    } catch (error) {
      warn(`扫描分析补偿队列失败：${errorMessage(error)}`);
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
