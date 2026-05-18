import { extractDiscussionMappingFromMessage, extractDiscussionMappings } from './discussion-mapping.js';
import type { DiscussionMappingStore } from './discussion-store.js';
import { fetchTelegramChat, fetchTelegramUpdates } from './telegram-updates.js';

export interface StartDiscussionPollerOptions {
  botToken: string;
  discussionChatId?: string;
  proxyUrl?: string;
  store: DiscussionMappingStore;
  intervalMs?: number;
  timeoutSeconds?: number;
  pinnedFallbackIntervalMs?: number;
  retryAttempts?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  fetchUpdates?: typeof fetchTelegramUpdates;
  fetchChat?: typeof fetchTelegramChat;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export function startDiscussionPoller(options: StartDiscussionPollerOptions): () => void {
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  const intervalMs = options.intervalMs ?? 250;
  const timeoutSeconds = options.timeoutSeconds ?? 30;
  const pinnedFallbackIntervalMs = options.pinnedFallbackIntervalMs ?? 10_000;
  const fetchUpdates = options.fetchUpdates ?? fetchTelegramUpdates;
  const fetchChat = options.fetchChat ?? fetchTelegramChat;
  let stopped = false;
  let offset: number | undefined;
  let nextPinnedFallbackAt = 0;
  let timer: NodeJS.Timeout | undefined;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const updates = await fetchUpdates({
        botToken: options.botToken,
        proxyUrl: options.proxyUrl,
        offset,
        timeoutSeconds,
        retryAttempts: options.retryAttempts,
        retryMinDelayMs: options.retryMinDelayMs,
        retryMaxDelayMs: options.retryMaxDelayMs,
        onRetry: (error, attempt, delayMs) => {
          warn(
            `轮询讨论群更新失败，${delayMs}ms 后重试：attempt=${attempt} error=${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      });
      const maxUpdateId = updates.reduce<number | undefined>((max, update) => {
        if (!update || typeof update !== 'object') return max;
        const current = (update as Record<string, unknown>).update_id;
        if (typeof current !== 'number') return max;
        return typeof max === 'number' ? Math.max(max, current) : current;
      }, offset);
      if (typeof maxUpdateId === 'number') {
        offset = maxUpdateId + 1;
      }

      const mappings = extractDiscussionMappings(updates);
      if (mappings.length > 0) {
        const inserted = options.store.ingest(mappings);
        if (inserted > 0) {
          info(`讨论群映射新增 ${inserted} 条`);
        }
      }

      const now = Date.now();
      if (options.discussionChatId && now >= nextPinnedFallbackAt) {
        nextPinnedFallbackAt = now + pinnedFallbackIntervalMs;
        try {
          const chat = await fetchChat({
            botToken: options.botToken,
            chatId: options.discussionChatId,
            proxyUrl: options.proxyUrl,
            retryAttempts: options.retryAttempts,
            retryMinDelayMs: options.retryMinDelayMs,
            retryMaxDelayMs: options.retryMaxDelayMs,
            onRetry: (error, attempt, delayMs) => {
              warn(
                `查询讨论群置顶消息失败，${delayMs}ms 后重试：attempt=${attempt} error=${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          });
          const mapping = extractDiscussionMappingFromMessage(chat.pinned_message);
          if (mapping) {
            const inserted = options.store.ingest([mapping]);
            if (inserted > 0) {
              info(`讨论群映射新增 ${inserted} 条`);
            }
          }
        } catch (error) {
          warn(`查询讨论群置顶消息失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      warn(`轮询讨论群更新失败：${error instanceof Error ? error.message : String(error)}`);
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
