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

export class AnalysisArchiveStore {
  private readonly filePath: string;
  private readonly warn: (message: string) => void;

  constructor(options: AnalysisArchiveStoreOptions) {
    this.filePath = options.filePath;
    this.warn = options.warn ?? console.warn;
  }

  async listAll(): Promise<AnalysisArchiveRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const records: AnalysisArchiveRecord[] = [];
    for (const [index, line] of raw.split('\n').entries()) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line) as AnalysisArchiveRecord);
      } catch (error) {
        this.warn(`跳过无效分析归档行 ${index + 1}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return records;
  }

  async upsert(record: AnalysisArchiveRecord): Promise<void> {
    const records = await this.listAll();
    const nextRecords = records.filter((item) => item.sourceTaskKey !== record.sourceTaskKey);
    nextRecords.push(record);
    await this.writeAll(nextRecords);
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

  private async listAnalysisRecords(): Promise<AnalysisArchiveAnalysisRecord[]> {
    return (await this.listAll())
      .filter((record): record is AnalysisArchiveAnalysisRecord => record.recordType === 'analysis')
      .sort((a, b) => compareAnalysisRecords(a, b));
  }

  private async writeAll(records: AnalysisArchiveRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const contents = records.map((record) => JSON.stringify(record)).join('\n');
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
