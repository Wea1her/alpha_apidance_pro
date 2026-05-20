import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StoredAnalysis } from './analysis-tracker.js';

export interface AnalysisArchiveMessageRef {
  chatId: number;
  messageId: number;
}

export interface AnalysisArchiveAnalysisRecord {
  version: 1;
  recordType: 'analysis';
  sourceTaskKey: string;
  projectKey: string;
  title: string;
  content: string;
  link: string;
  mainPushedAt: string;
  archivedAt: string;
  analysisCreatedAt: string;
  star: number;
  count: number;
  channelMessage: AnalysisArchiveMessageRef;
  discussionAnalysisMessage: { chatId: string | number; messageId: number };
  analysisText: string;
}

export interface AnalysisArchiveHitRecord {
  version: 1;
  recordType: 'hit';
  sourceTaskKey: string;
  projectKey: string;
  title: string;
  content: string;
  link: string;
  mainPushedAt: string;
  archivedAt: string;
  star: number;
  count: number;
  channelMessage: AnalysisArchiveMessageRef;
  discussionAnalysisMessage: { chatId: string | number; messageId: number };
  reminderMessage?: AnalysisArchiveMessageRef;
}

export type AnalysisArchiveRecord = AnalysisArchiveAnalysisRecord | AnalysisArchiveHitRecord;

export interface AnalysisArchiveStoreOptions {
  filePath: string;
  warn?: (message: string) => void;
}

type ArchiveLine = { type: 'record'; record: AnalysisArchiveRecord } | { type: 'raw'; line: string };
const writeQueuesByFilePath = new Map<string, Promise<void>>();

export class AnalysisArchiveStore {
  private readonly filePath: string;
  private readonly warn: (message: string) => void;

  constructor(options: AnalysisArchiveStoreOptions) {
    this.filePath = options.filePath;
    this.warn = options.warn ?? console.warn;
  }

  async listAll(): Promise<AnalysisArchiveRecord[]> {
    return (await this.readArchiveLines({ warnInvalid: true }))
      .filter((line): line is { type: 'record'; record: AnalysisArchiveRecord } => line.type === 'record')
      .map((line) => line.record);
  }

  async upsert(record: AnalysisArchiveRecord): Promise<void> {
    if (!isAnalysisArchiveRecord(record)) {
      throw new Error('Invalid analysis archive record');
    }

    const previousOperation = writeQueuesByFilePath.get(this.filePath) ?? Promise.resolve();
    const operation = previousOperation.then(() => this.upsertLocked(record));
    writeQueuesByFilePath.set(this.filePath, operation.catch(() => undefined));
    return operation;
  }

  async getFirstAnalysis(projectKey: string): Promise<AnalysisArchiveAnalysisRecord | null> {
    const records = await this.listAnalysisRecords();
    return records.find((record) => record.projectKey === projectKey) ?? null;
  }

  async hasAnalysis(projectKey: string): Promise<boolean> {
    return (await this.getFirstAnalysis(projectKey)) !== null;
  }

  async listAnalysisTrackerEntries(): Promise<Array<[string, StoredAnalysis]>> {
    const entries: Array<[string, StoredAnalysis]> = [];
    const seenProjectKeys = new Set<string>();

    for (const record of await this.listAnalysisRecords()) {
      if (seenProjectKeys.has(record.projectKey)) {
        continue;
      }
      seenProjectKeys.add(record.projectKey);
      entries.push([
        record.projectKey,
        {
          discussionChatId: String(record.discussionAnalysisMessage.chatId),
          analysisMessageId: record.discussionAnalysisMessage.messageId
        }
      ]);
    }

    return entries;
  }

  private async readArchiveLines(options: { warnInvalid: boolean }): Promise<ArchiveLine[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const lines: ArchiveLine[] = [];
    for (const [index, line] of raw.split('\n').entries()) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isAnalysisArchiveRecord(parsed)) {
          throw new Error('invalid analysis archive record format');
        }
        lines.push({ type: 'record', record: parsed });
      } catch (error) {
        if (options.warnInvalid) {
          this.warn(`跳过无效分析归档行 ${index + 1}：${error instanceof Error ? error.message : String(error)}`);
        }
        lines.push({ type: 'raw', line });
      }
    }
    return lines;
  }

  private async listAnalysisRecords(): Promise<AnalysisArchiveAnalysisRecord[]> {
    return (await this.listAll())
      .filter((record): record is AnalysisArchiveAnalysisRecord => record.recordType === 'analysis')
      .sort((a, b) => compareAnalysisRecords(a, b));
  }

  private async upsertLocked(record: AnalysisArchiveRecord): Promise<void> {
    const lines = await this.readArchiveLines({ warnInvalid: false });
    const nextLines = lines.filter((line) => {
      // sourceTaskKey is the idempotency key across both record types; a later
      // analysis or hit replaces any earlier record with the same key.
      return line.type !== 'record' || line.record.sourceTaskKey !== record.sourceTaskKey;
    });
    nextLines.push({ type: 'record', record });
    await this.writeAll(nextLines);
  }

  private async writeAll(lines: ArchiveLine[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const contents = lines
      .map((line) => (line.type === 'record' ? JSON.stringify(line.record) : line.line))
      .join('\n');
    await writeFile(tempPath, contents ? `${contents}\n` : '', 'utf8');
    await rename(tempPath, this.filePath);
  }
}

function compareAnalysisRecords(a: AnalysisArchiveAnalysisRecord, b: AnalysisArchiveAnalysisRecord): number {
  const byMainPushedAt = a.mainPushedAt.localeCompare(b.mainPushedAt);
  if (byMainPushedAt !== 0) {
    return byMainPushedAt;
  }
  return a.sourceTaskKey.localeCompare(b.sourceTaskKey);
}

function isAnalysisArchiveRecord(value: unknown): value is AnalysisArchiveRecord {
  if (!isRecordObject(value) || value.version !== 1) {
    return false;
  }

  if (value.recordType === 'analysis') {
    return isAnalysisArchiveAnalysisRecord(value);
  }

  if (value.recordType === 'hit') {
    return isAnalysisArchiveHitRecord(value);
  }

  return false;
}

function isAnalysisArchiveAnalysisRecord(value: unknown): value is AnalysisArchiveAnalysisRecord {
  if (!isRecordObject(value)) {
    return false;
  }

  return (
    hasCommonFields(value) &&
    value.recordType === 'analysis' &&
    typeof value.analysisCreatedAt === 'string' &&
    typeof value.analysisText === 'string'
  );
}

function isAnalysisArchiveHitRecord(value: unknown): value is AnalysisArchiveHitRecord {
  if (!isRecordObject(value)) {
    return false;
  }

  return (
    hasCommonFields(value) &&
    value.recordType === 'hit' &&
    (value.reminderMessage === undefined || isMessageRef(value.reminderMessage))
  );
}

function hasCommonFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.sourceTaskKey === 'string' &&
    typeof value.projectKey === 'string' &&
    typeof value.title === 'string' &&
    typeof value.content === 'string' &&
    typeof value.link === 'string' &&
    typeof value.mainPushedAt === 'string' &&
    typeof value.archivedAt === 'string' &&
    typeof value.star === 'number' &&
    typeof value.count === 'number' &&
    isMessageRef(value.channelMessage) &&
    isDiscussionAnalysisMessage(value.discussionAnalysisMessage)
  );
}

function isMessageRef(value: unknown): value is AnalysisArchiveMessageRef {
  return (
    isRecordObject(value) &&
    typeof value.chatId === 'number' &&
    typeof value.messageId === 'number'
  );
}

function isDiscussionAnalysisMessage(value: unknown): value is { chatId: string | number; messageId: number } {
  return (
    isRecordObject(value) &&
    (typeof value.chatId === 'string' || typeof value.chatId === 'number') &&
    typeof value.messageId === 'number'
  );
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
