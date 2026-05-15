import { describe, expect, it, vi } from 'vitest';
import { extractChatsFromUpdates, fetchTelegramUpdates } from '../src/telegram-updates.js';

describe('extractChatsFromUpdates', () => {
  it('collects unique chats from regular and channel updates', () => {
    const chats = extractChatsFromUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: -1001, type: 'supergroup', title: 'Discussion' }
        }
      },
      {
        update_id: 2,
        channel_post: {
          message_id: 20,
          chat: { id: -1002, type: 'channel', title: 'Channel' }
        }
      },
      {
        update_id: 3,
        edited_channel_post: {
          message_id: 21,
          chat: { id: -1002, type: 'channel', title: 'Channel' }
        }
      }
    ]);

    expect(chats).toEqual([
      { id: -1001, type: 'supergroup', title: 'Discussion' },
      { id: -1002, type: 'channel', title: 'Channel' }
    ]);
  });

  it('returns automatic forward metadata when available', () => {
    const chats = extractChatsFromUpdates([
      {
        update_id: 1,
        message: {
          message_id: 10,
          is_automatic_forward: true,
          forward_from_chat: { id: -1009, type: 'channel', title: 'Source Channel' },
          chat: { id: -1001, type: 'supergroup', title: 'Discussion' }
        }
      }
    ]);

    expect(chats).toEqual([
      {
        id: -1001,
        type: 'supergroup',
        title: 'Discussion',
        isAutomaticForward: true,
        forwardedFromChatId: -1009
      }
    ]);
  });
});

describe('fetchTelegramUpdates', () => {
  it('retries transient fetch failures before giving up on getUpdates', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          ok: true,
          result: [{ update_id: 1 }]
        })
      });

    await expect(
      fetchTelegramUpdates({
        botToken: 'token',
        fetch: fetchMock as unknown as typeof fetch,
        retryAttempts: 2,
        retryMinDelayMs: 0
      })
    ).resolves.toEqual([{ update_id: 1 }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
