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
      twitterApiBaseUrl: 'https://example.6551',
      telegramRetryAttempts: 5,
      telegramRetryMinDelayMs: 1000,
      telegramRetryMaxDelayMs: 30000,
      failedQueuePath: 'data/failed-messages.jsonl',
      failedQueueDeadLetterPath: 'data/dead-letter-messages.jsonl',
      failedQueueRetryIntervalMs: 30000,
      failedQueueMaxAttempts: 20,
      analysisQueuePath: 'data/analysis-tasks.jsonl',
      analysisQueueDeadLetterPath: 'data/analysis-dead-letter.jsonl',
      analysisQueueRetryIntervalMs: 30000,
      analysisQueueMaxAttempts: 30
    });
  });

  it('parses telegram retry config', () => {
    expect(
      parseServiceConfig({
        ALPHA_WALLET_PRIVATE_KEY: '0xabc',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-100123',
        TELEGRAM_RETRY_ATTEMPTS: '8',
        TELEGRAM_RETRY_MIN_DELAY_MS: '500',
        TELEGRAM_RETRY_MAX_DELAY_MS: '10000'
      })
    ).toMatchObject({
      telegramRetryAttempts: 8,
      telegramRetryMinDelayMs: 500,
      telegramRetryMaxDelayMs: 10000
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

  it('parses failed queue config', () => {
    expect(
      parseServiceConfig({
        ALPHA_WALLET_PRIVATE_KEY: '0xabc',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-100123',
        FAILED_QUEUE_PATH: 'data/custom-failed.jsonl',
        FAILED_QUEUE_DEAD_LETTER_PATH: 'data/custom-dead.jsonl',
        FAILED_QUEUE_RETRY_INTERVAL_MS: '15000',
        FAILED_QUEUE_MAX_ATTEMPTS: '7'
      })
    ).toMatchObject({
      failedQueuePath: 'data/custom-failed.jsonl',
      failedQueueDeadLetterPath: 'data/custom-dead.jsonl',
      failedQueueRetryIntervalMs: 15000,
      failedQueueMaxAttempts: 7
    });
  });

  it('parses analysis queue config', () => {
    expect(
      parseServiceConfig({
        ALPHA_WALLET_PRIVATE_KEY: '0xabc',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-100123',
        ANALYSIS_QUEUE_PATH: 'data/custom-analysis.jsonl',
        ANALYSIS_QUEUE_DEAD_LETTER_PATH: 'data/custom-analysis-dead.jsonl',
        ANALYSIS_QUEUE_RETRY_INTERVAL_MS: '45000',
        ANALYSIS_QUEUE_MAX_ATTEMPTS: '11'
      })
    ).toMatchObject({
      analysisQueuePath: 'data/custom-analysis.jsonl',
      analysisQueueDeadLetterPath: 'data/custom-analysis-dead.jsonl',
      analysisQueueRetryIntervalMs: 45000,
      analysisQueueMaxAttempts: 11
    });
  });
});
