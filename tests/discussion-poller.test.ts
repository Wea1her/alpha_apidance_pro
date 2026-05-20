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

  it('falls back to getChat pinned_message when getUpdates has no mapping', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const info = vi.fn();
    const fetchUpdates = vi.fn().mockResolvedValue([]);
    const fetchChat = vi.fn().mockResolvedValue({
      id: -1003769834276,
      type: 'supergroup',
      pinned_message: {
        message_id: 1039,
        is_automatic_forward: true,
        chat: { id: -1003769834276, type: 'supergroup', title: 'Discussion' },
        forward_origin: {
          type: 'channel',
          chat: { id: -1003903535780, type: 'channel', title: 'Alpha' },
          message_id: 580
        }
      }
    });

    const stop = startDiscussionPoller({
      botToken: 'token',
      discussionChatId: '-1003769834276',
      store,
      intervalMs: 1,
      pinnedFallbackIntervalMs: 60_000,
      info,
      warn: vi.fn(),
      fetchUpdates,
      fetchChat,
      timeoutSeconds: 30
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(fetchUpdates).toHaveBeenCalled();
    expect(fetchChat).toHaveBeenCalledWith(
      expect.objectContaining({
        botToken: 'token',
        chatId: '-1003769834276'
      })
    );
    expect(store.get(-1003903535780, 580)).toEqual({
      discussionChatId: -1003769834276,
      discussionMessageId: 1039,
      channelChatId: -1003903535780,
      channelMessageId: 580
    });
    expect(info).toHaveBeenCalledWith('讨论群映射新增 1 条');
  });

  it('passes updates to onUpdates and advances offset after successful handling', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const updates = [
      {
        update_id: 41,
        message: {
          message_id: 10,
          is_automatic_forward: true,
          forward_from_message_id: 88,
          forward_from_chat: { id: -1009 },
          chat: { id: -1001, type: 'supergroup', title: 'Discussion' }
        }
      },
      { update_id: 42, message: { message_id: 11, text: '/start' } }
    ];
    const fetchUpdates = vi.fn().mockResolvedValueOnce(updates).mockResolvedValueOnce([]);
    const onUpdates = vi.fn().mockResolvedValue(undefined);

    const stop = startDiscussionPoller({
      botToken: 'token',
      store,
      intervalMs: 1,
      info: vi.fn(),
      warn: vi.fn(),
      fetchUpdates,
      onUpdates,
      timeoutSeconds: 30
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(onUpdates).toHaveBeenNthCalledWith(1, updates);
    expect(fetchUpdates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botToken: 'token', offset: 43, timeoutSeconds: 30 })
    );
  });

  it('does not advance offset when onUpdates rejects and retries the same updates', async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const warn = vi.fn();
    const updates = [{ update_id: 7, message: { message_id: 11, text: '/start' } }];
    const fetchUpdates = vi.fn().mockResolvedValue(updates);
    const onUpdates = vi.fn().mockRejectedValueOnce(new Error('command handler failed')).mockResolvedValue(undefined);

    const stop = startDiscussionPoller({
      botToken: 'token',
      store,
      intervalMs: 1,
      info: vi.fn(),
      warn,
      fetchUpdates,
      onUpdates,
      timeoutSeconds: 30
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(onUpdates).toHaveBeenCalledTimes(2);
    expect(fetchUpdates).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ botToken: 'token', offset: undefined, timeoutSeconds: 30 })
    );
    expect(fetchUpdates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botToken: 'token', offset: undefined, timeoutSeconds: 30 })
    );
    expect(warn).toHaveBeenCalledWith('轮询讨论群更新失败：command handler failed');
  });
});
