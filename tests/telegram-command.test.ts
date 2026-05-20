import { describe, expect, it } from 'vitest';
import { extractTelegramCommands } from '../src/telegram-command.js';

describe('extractTelegramCommands', () => {
  it('parses Chinese export commands from channel posts', () => {
    expect(
      extractTelegramCommands([
        {
          update_id: 1,
          channel_post: {
            message_id: 10,
            text: '导出分析 2026-05-20T09 2026-05-20T18',
            chat: { id: -1001234567890, type: 'channel', title: 'Alerts' }
          }
        }
      ])
    ).toEqual([
      {
        type: 'export-analysis',
        chatId: '-1001234567890',
        messageId: 10,
        from: '2026-05-20T09',
        to: '2026-05-20T18'
      }
    ]);
  });

  it('parses Chinese chat-id commands from regular messages with username', () => {
    expect(
      extractTelegramCommands([
        {
          update_id: 1,
          message: {
            message_id: 20,
            text: '查看聊天ID',
            from: { id: 123, username: 'alice' },
            chat: { id: -1001, type: 'supergroup', title: 'Discussion' }
          }
        }
      ])
    ).toEqual([
      {
        type: 'chat-id',
        chatId: '-1001',
        messageId: 20,
        username: 'alice'
      }
    ]);
  });

  it('parses English aliases with optional bot suffix', () => {
    expect(
      extractTelegramCommands([
        {
          update_id: 1,
          message: {
            message_id: 30,
            text: '/chatid@MyBot',
            from: { id: 123, username: 'bob' },
            chat: { id: -1002, type: 'supergroup' }
          }
        },
        {
          update_id: 2,
          message: {
            message_id: 31,
            text: '/export_analysis@MyBot 2026-05-20T09 2026-05-20T18',
            from: { id: 124, username: 'carol' },
            chat: { id: -1003, type: 'supergroup' }
          }
        }
      ])
    ).toEqual([
      {
        type: 'chat-id',
        chatId: '-1002',
        messageId: 30,
        username: 'bob'
      },
      {
        type: 'export-analysis',
        chatId: '-1003',
        messageId: 31,
        username: 'carol',
        from: '2026-05-20T09',
        to: '2026-05-20T18'
      }
    ]);
  });

  it('returns invalid export commands when export args are malformed', () => {
    expect(
      extractTelegramCommands([
        {
          update_id: 1,
          message: {
            message_id: 40,
            text: '导出分析 2026-05-20T09',
            chat: { id: -1004, type: 'supergroup' }
          }
        },
        {
          update_id: 2,
          message: {
            message_id: 41,
            text: '/export_analysis 2026-05-20T09 2026-05-20T18 extra',
            from: { id: 125, username: 'dave' },
            chat: { id: -1005, type: 'supergroup' }
          }
        },
        {
          update_id: 3,
          message: {
            message_id: 42,
            text: '导出分析2026-05-20T09 2026-05-20T18',
            chat: { id: -1006, type: 'supergroup' }
          }
        }
      ])
    ).toEqual([
      {
        type: 'invalid-export-analysis',
        chatId: '-1004',
        messageId: 40
      },
      {
        type: 'invalid-export-analysis',
        chatId: '-1005',
        messageId: 41,
        username: 'dave'
      },
      {
        type: 'invalid-export-analysis',
        chatId: '-1006',
        messageId: 42
      }
    ]);
  });

  it('defensively handles full getUpdates response objects and non-array inputs', () => {
    expect(
      extractTelegramCommands({
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 50,
              text: '查看聊天ID',
              chat: { id: -1007, type: 'supergroup' }
            }
          }
        ]
      })
    ).toEqual([
      {
        type: 'chat-id',
        chatId: '-1007',
        messageId: 50
      }
    ]);
    expect(extractTelegramCommands({ ok: false })).toEqual([]);
    expect(extractTelegramCommands(null)).toEqual([]);
  });

  it('ignores unrelated updates and non-text messages', () => {
    expect(
      extractTelegramCommands([
        { update_id: 1, edited_message: { message_id: 1, text: '查看聊天ID', chat: { id: -1 } } },
        { update_id: 2, message: { message_id: 2, photo: [], chat: { id: -2 } } },
        { update_id: 3, message: { text: '查看聊天ID', chat: { id: -3 } } },
        { update_id: 4, message: { message_id: 4, text: 'hello', chat: { id: -4 } } },
        null
      ])
    ).toEqual([]);
  });
});
