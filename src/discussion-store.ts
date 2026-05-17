import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DiscussionMapping } from './discussion-mapping.js';

const PERSIST_PATH = 'data/discussion-mappings.jsonl';

function mappingKey(channelChatId: number, channelMessageId: number): string {
  return `${channelChatId}:${channelMessageId}`;
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export class DiscussionMappingStore {
  private readonly mappings = new Map<string, DiscussionMapping>();
  private readonly waiters = new Map<string, Array<(mapping: DiscussionMapping) => void>>();
  private readonly persistPath: string;

  constructor(options: { persistPath?: string } = {}) {
    this.persistPath = options.persistPath ?? PERSIST_PATH;
    this.restoreFromDisk();
  }

  private restoreFromDisk(): void {
    let content: string;
    try {
      content = readFileSync(this.persistPath, 'utf8');
    } catch {
      return;
    }
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const mapping = JSON.parse(line) as DiscussionMapping;
        const key = mappingKey(mapping.channelChatId, mapping.channelMessageId);
        this.mappings.set(key, mapping);
      } catch {
        // 跳过损坏行
      }
    }
    if (this.mappings.size > 0) {
      console.info(`从磁盘恢复 ${this.mappings.size} 条讨论群映射`);
    }
  }

  private persistToDisk(mappings: DiscussionMapping[]): void {
    try {
      ensureDir(this.persistPath);
      const lines = mappings.map((m) => JSON.stringify(m)).join('\n') + '\n';
      appendFileSync(this.persistPath, lines, 'utf8');
    } catch (error) {
      console.warn(`持久化讨论群映射失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  ingest(mappings: DiscussionMapping[]): number {
    let inserted = 0;
    const newMappings: DiscussionMapping[] = [];
    for (const mapping of mappings) {
      const key = mappingKey(mapping.channelChatId, mapping.channelMessageId);
      if (!this.mappings.has(key)) {
        inserted += 1;
        newMappings.push(mapping);
      }
      this.mappings.set(key, mapping);
      const waiters = this.waiters.get(key);
      if (!waiters) continue;
      this.waiters.delete(key);
      for (const resolve of waiters) {
        resolve(mapping);
      }
    }
    if (newMappings.length > 0) {
      this.persistToDisk(newMappings);
    }
    return inserted;
  }

  get(channelChatId: number, channelMessageId: number): DiscussionMapping | null {
    return this.mappings.get(mappingKey(channelChatId, channelMessageId)) ?? null;
  }

  waitFor(channelChatId: number, channelMessageId: number, timeoutMs: number): Promise<DiscussionMapping | null> {
    const existing = this.get(channelChatId, channelMessageId);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const key = mappingKey(channelChatId, channelMessageId);
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(key);
        if (!waiters) {
          resolve(null);
          return;
        }
        this.waiters.set(
          key,
          waiters.filter((waiter) => waiter !== onResolve)
        );
        resolve(null);
      }, timeoutMs);

      const onResolve = (mapping: DiscussionMapping): void => {
        clearTimeout(timer);
        resolve(mapping);
      };

      const waiters = this.waiters.get(key) ?? [];
      waiters.push(onResolve);
      this.waiters.set(key, waiters);
    });
  }
}
