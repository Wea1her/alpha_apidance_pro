import type { DiscussionMapping } from './discussion-mapping.js';

function mappingKey(channelChatId: number, channelMessageId: number): string {
  return `${channelChatId}:${channelMessageId}`;
}

export class DiscussionMappingStore {
  private readonly mappings = new Map<string, DiscussionMapping>();
  private readonly waiters = new Map<string, Array<(mapping: DiscussionMapping) => void>>();

  ingest(mappings: DiscussionMapping[]): void {
    for (const mapping of mappings) {
      const key = mappingKey(mapping.channelChatId, mapping.channelMessageId);
      this.mappings.set(key, mapping);
      const waiters = this.waiters.get(key);
      if (!waiters) continue;
      this.waiters.delete(key);
      for (const resolve of waiters) {
        resolve(mapping);
      }
    }
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
