import { describe, expect, it } from 'vitest';
import { parseServiceConfig } from '../src/config.js';

describe('parseServiceConfig', () => {
  it('parses required alpha and telegram config', () => {
    expect(
      parseServiceConfig({
        ALPHA_WALLET_PRIVATE_KEY: '0xabc',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-100123',
        COMMON_FOLLOW_STAR_LEVELS: '5,8,12,15,20'
      })
    ).toMatchObject({
      alphaWalletPrivateKey: '0xabc',
      telegramBotToken: 'bot-token',
      telegramChatId: '-100123',
      commonFollowStarLevels: [5, 8, 12, 15, 20]
    });
  });

  it('requires telegram config for service mode', () => {
    expect(() =>
      parseServiceConfig({
        ALPHA_WALLET_PRIVATE_KEY: '0xabc',
        TELEGRAM_BOT_TOKEN: 'bot-token'
      })
    ).toThrow('TELEGRAM_CHAT_ID is required');
  });
});
