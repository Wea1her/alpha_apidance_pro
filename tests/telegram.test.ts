import { describe, expect, it, vi } from 'vitest';
import { replyInTelegramThread, sendTelegramMessage } from '../src/telegram.js';

describe('sendTelegramMessage', () => {
  it('returns the created telegram message id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        ok: true,
        result: {
          message_id: 321,
          chat: {
            id: -100123
          }
        }
      })
    });

    await expect(
      sendTelegramMessage({
        botToken: 'token',
        chatId: '@channel',
        text: 'hello',
        fetch: fetchMock as unknown as typeof fetch
      })
    ).resolves.toEqual({ messageId: 321, chatId: -100123 });
  });
});

describe('replyInTelegramThread', () => {
  it('sends a reply to the discussion message id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        ok: true,
        result: {
          message_id: 999,
          chat: {
            id: -100456
          }
        }
      })
    });

    await replyInTelegramThread({
      botToken: 'token',
      chatId: '-100discussion',
      replyToMessageId: 123,
      text: 'analysis',
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottoken/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: '-100discussion',
          text: 'analysis',
          disable_web_page_preview: false,
          reply_to_message_id: 123
        })
      })
    );
  });
});
