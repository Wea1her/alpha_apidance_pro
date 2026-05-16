import { extractDiscussionMappings } from './discussion-mapping.js';
import type { DiscussionMappingStore } from './discussion-store.js';
import { fetchTelegramUpdates } from './telegram-updates.js';

export interface StartDiscussionPollerOptions {
  botToken: string;
  proxyUrl?: string;
  store: DiscussionMappingStore;
  intervalMs?: number;
  timeoutSeconds?: number;
  retryAttempts?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  fetchUpdates?: typeof fetchTelegramUpdates;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export function startDiscussionPoller(options: StartDiscussionPollerOptions): () => void {
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  const intervalMs = options.intervalMs ?? 250;
  const timeoutSeconds = options.timeoutSeconds ?? 30;
  const fetchUpdates = options.fetchUpdates ?? fetchTelegramUpdates;
  let stopped = false;
  let offset: number | undefined;
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
