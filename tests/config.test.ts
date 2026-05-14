import { describe, expect, it } from 'vitest';
import { parseServiceConfig } from '../src/config.js';

describe('parseServiceConfig', () => {
  it('parses required alpha and telegram config', () => {
    expect(
      parseServiceConfig({
        ALPHA_WALLET_PRIVATE_KEY: '0xabc',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-100123',
        COMMON_FOLLOW_STAR_LEVELS: '5,8,12,15,20',
        TWITTER_TOKEN: 'twitter-token',
        TWITTER_API_BASE_URL: 'https://example.6551'
      })
    ).toMatchObject({
      alphaWalletPrivateKey: '0xabc',
      telegramBotToken: 'bot-token',
      telegramChatId: '-100123',
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      twitterToken: 'twitter-token',
      twitterApiBaseUrl: 'https://example.6551'
    });
  });

  it('defaults twitter api base url for 6551', () => {
    expect(
      parseServiceConfig({
        ALPHA_WALLET_PRIVATE_KEY: '0xabc',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-100123'
      })
    ).toMatchObject({
      twitterToken: undefined,
      twitterApiBaseUrl: 'https://ai.6551.io'
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
