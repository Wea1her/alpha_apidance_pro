import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscussionMappingStore } from '../src/discussion-store.js';
import { startDiscussionPoller } from '../src/discussion-poller.js';

async function createStore(): Promise<DiscussionMappingStore> {
  const dir = await mkdtemp(join(tmpdir(), 'discussion-poller-'));
  return new DiscussionMappingStore({ persistPath: join(dir, 'discussion-mappings.jsonl') });
}

describe('startDiscussionPoller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs only truly new discussion mappings', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const info = vi.fn();
    const fetchUpdates = vi
      .fn()
      .mockResolvedValueOnce([
        {
          update_id: 1,
          message: {
            message_id: 10,
            is_automatic_forward: true,
            forward_from_message_id: 88,
            forward_from_chat: { id: -1009 },
            chat: { id: -1001, type: 'supergroup', title: 'Discussion' }
          }
        }
      ])
      .mockResolvedValueOnce([
        {
          update_id: 2,
          message: {
            message_id: 10,
            is_automatic_forward: true,
            forward_from_message_id: 88,
            forward_from_chat: { id: -1009 },
            chat: { id: -1001, type: 'supergroup', title: 'Discussion' }
          }
        }
      ]);

    const stop = startDiscussionPoller({
      botToken: 'token',
      store,
      intervalMs: 1,
      info,
      warn: vi.fn(),
      fetchUpdates,
      timeoutSeconds: 30
    });

    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('讨论群映射新增 1 条');
    expect(fetchUpdates).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ botToken: 'token', offset: undefined, timeoutSeconds: 30 })
    );
    expect(fetchUpdates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botToken: 'token', offset: 2, timeoutSeconds: 30 })
    );
  });
});
