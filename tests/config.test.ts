import { describe, expect, it } from 'vitest';
import { parseServiceConfig } from '../src/config.js';

describe('parseServiceConfig', () => {
  const baseEnv = {
    ALPHA_WALLET_PRIVATE_KEY: '0xabc',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: '-100123'
  };

  it('parses required alpha and telegram config', () => {
    expect(
      parseServiceConfig({
        ...baseEnv,
        COMMON_FOLLOW_STAR_LEVELS: '5,8,12,15,20'
      })
    ).toMatchObject({
      alphaWalletPrivateKey: '0xabc',
      telegramBotToken: 'bot-token',
      telegramChatId: '-100123',
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      xaiRetryAttempts: 5,
      xaiRetryMinDelayMs: 1000,
      xaiRetryMaxDelayMs: 20000,
      xaiMaxTokens: 2048,
      xaiSearchTools: ['web_search', 'x_search'],
      telegramRetryAttempts: 5,
      heartbeatTimeoutMs: 90000,
      businessSilenceTimeoutMs: 60000,
      alphaReplayLookbackMs: 600000,
      telegramRetryMinDelayMs: 1000,
      telegramRetryMaxDelayMs: 30000,
      failedQueuePath: 'data/failed-messages.jsonl',
      failedQueueDeadLetterPath: 'data/dead-letter-messages.jsonl',
      failedQueueRetryIntervalMs: 30000,
      failedQueueMaxAttempts: 20,
      analysisQueuePath: 'data/analysis-tasks.jsonl',
      analysisQueueDeadLetterPath: 'data/analysis-dead-letter.jsonl',
      analysisQueueRetryIntervalMs: 30000,
      analysisQueueMaxAttempts: 30,
      analysisArchivePath: 'data/analysis-archive.jsonl',
      exportAdminUsernames: [],
      exportAllowedChatIds: [],
      projectStatePath: 'data/project-state.json'
    });
  });

  it('does not expose removed 6551 twitter config', () => {
    const config = parseServiceConfig({
      ...baseEnv,
      TWITTER_TOKEN: 'twitter-token',
      TWITTER_API_BASE_URL: 'https://example.6551'
    });

    expect(config).not.toHaveProperty('twitterToken');
    expect(config).not.toHaveProperty('twitterApiBaseUrl');
  });

  it('parses telegram retry config', () => {
    expect(
      parseServiceConfig({
        ...baseEnv,
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

  it('parses alpha websocket watchdog config', () => {
    expect(
      parseServiceConfig({
        ...baseEnv,
        ALPHA_HEARTBEAT_TIMEOUT_MS: '45000',
        ALPHA_BUSINESS_SILENCE_TIMEOUT_MS: '180000',
        ALPHA_RECONNECT_MIN_DELAY_MS: '500',
        ALPHA_RECONNECT_MAX_DELAY_MS: '15000'
      })
    ).toMatchObject({
      heartbeatTimeoutMs: 45000,
      businessSilenceTimeoutMs: 180000,
      reconnectMinDelayMs: 500,
      reconnectMaxDelayMs: 15000
    });
  });

  it('parses alpha replay lookback config', () => {
    expect(
      parseServiceConfig({
        ...baseEnv,
        ALPHA_REPLAY_LOOKBACK_MS: '300000'
      })
    ).toMatchObject({
      alphaReplayLookbackMs: 300000
    });
  });

  it('parses xAI retry and output budget config', () => {
    expect(
      parseServiceConfig({
        ...baseEnv,
        XAI_RETRY_ATTEMPTS: '7',
        XAI_RETRY_MIN_DELAY_MS: '250',
        XAI_RETRY_MAX_DELAY_MS: '12000',
        XAI_MAX_TOKENS: '4096'
      })
    ).toMatchObject({
      xaiRetryAttempts: 7,
      xaiRetryMinDelayMs: 250,
      xaiRetryMaxDelayMs: 12000,
      xaiMaxTokens: 4096
    });
  });

  it('parses xAI search tools config', () => {
    expect(parseServiceConfig(baseEnv).xaiSearchTools).toEqual(['web_search', 'x_search']);
    expect(parseServiceConfig({ ...baseEnv, XAI_SEARCH_TOOLS: '' }).xaiSearchTools).toEqual([
      'web_search',
      'x_search'
    ]);
    expect(parseServiceConfig({ ...baseEnv, XAI_SEARCH_TOOLS: '  ' }).xaiSearchTools).toEqual([
      'web_search',
      'x_search'
    ]);
    expect(parseServiceConfig({ ...baseEnv, XAI_SEARCH_TOOLS: 'none' }).xaiSearchTools).toEqual([]);
    expect(parseServiceConfig({ ...baseEnv, XAI_SEARCH_TOOLS: 'NONE' }).xaiSearchTools).toEqual([]);
    expect(parseServiceConfig({ ...baseEnv, XAI_SEARCH_TOOLS: ' X_SEARCH , x_search ' }).xaiSearchTools).toEqual([
      'x_search'
    ]);
    expect(parseServiceConfig({ ...baseEnv, XAI_SEARCH_TOOLS: 'x_search,web_search' }).xaiSearchTools).toEqual([
      'x_search',
      'web_search'
    ]);
    expect(() => parseServiceConfig({ ...baseEnv, XAI_SEARCH_TOOLS: 'web_search,google' })).toThrow(
      'XAI_SEARCH_TOOLS contains unsupported search tool: google'
    );
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
        ...baseEnv,
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
        ...baseEnv,
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

  it('parses analysis archive export config', () => {
    const config = parseServiceConfig({
      ...baseEnv,
      ANALYSIS_ARCHIVE_PATH: 'data/custom-analysis-archive.jsonl',
      EXPORT_ADMIN_USERNAMES: 'Alice,@Bob',
      EXPORT_ALLOWED_CHAT_IDS: '-1001,-1002'
    });

    expect(config.analysisArchivePath).toBe('data/custom-analysis-archive.jsonl');
    expect(config.exportAdminUsernames).toEqual(['alice', 'bob']);
    expect(config.exportAllowedChatIds).toEqual(['-1001', '-1002']);
  });

  it('parses project state path config', () => {
    expect(
      parseServiceConfig({
        ...baseEnv,
        PROJECT_STATE_PATH: 'data/custom-project-state.json'
      })
    ).toMatchObject({
      projectStatePath: 'data/custom-project-state.json'
    });
  });

  it('keeps deep research disabled until its own API key is configured', () => {
    expect(parseServiceConfig({ ...baseEnv, XAI_API_KEY: 'standard-key' }).deepAnalysis).toBeUndefined();
    expect(parseServiceConfig({ ...baseEnv, XAI_DEEP_API_KEY: '  ' }).deepAnalysis).toBeUndefined();
  });

  it('uses fengshao multi-agent defaults independently of standard grok-4.3', () => {
    const config = parseServiceConfig({
      ...baseEnv, XAI_API_KEY: 'standard-key', XAI_MODEL: 'grok-4.3',
      XAI_BASE_URL: 'https://standard.example', XAI_DEEP_API_KEY: ' deep-key '
    });
    expect(config.deepAnalysis).toEqual({
      xaiApiKey: 'deep-key', xaiBaseUrl: 'https://api.fengshao1227.com',
      xaiModel: 'grok-4.20-multi-agent-0309', xaiMaxTokens: 4096, xaiSearchTools: ['web_search']
    });
    expect(config).toMatchObject({
      xaiApiKey: 'standard-key', xaiBaseUrl: 'https://standard.example',
      xaiModel: 'grok-4.3', xaiMaxTokens: 2048, xaiSearchTools: ['web_search', 'x_search']
    });
  });

  it('parses deep overrides and explicit search opt-out', () => {
    const env = {
      ...baseEnv, XAI_DEEP_API_KEY: 'deep', XAI_DEEP_BASE_URL: ' https://custom.example ',
      XAI_DEEP_MODEL: ' custom-model ', XAI_DEEP_MAX_TOKENS: '8192', XAI_DEEP_SEARCH_TOOLS: 'WEB_SEARCH,web_search'
    };
    expect(parseServiceConfig(env).deepAnalysis).toEqual({
      xaiApiKey: 'deep', xaiBaseUrl: 'https://custom.example', xaiModel: 'custom-model',
      xaiMaxTokens: 8192, xaiSearchTools: ['web_search']
    });
    expect(parseServiceConfig({ ...env, XAI_DEEP_SEARCH_TOOLS: 'none' }).deepAnalysis?.xaiSearchTools).toEqual([]);
    expect(parseServiceConfig({ ...env, XAI_DEEP_SEARCH_TOOLS: '' }).deepAnalysis?.xaiSearchTools).toEqual(['web_search']);
  });

  it.each(['0', '-1', 'abc'])('rejects an invalid deep token budget: %s', (budget) => {
    expect(() => parseServiceConfig({ ...baseEnv, XAI_DEEP_API_KEY: 'deep', XAI_DEEP_MAX_TOKENS: budget }))
      .toThrow('XAI_DEEP_MAX_TOKENS must be a positive integer');
  });

  it('rejects unknown deep search tools', () => {
    expect(() => parseServiceConfig({ ...baseEnv, XAI_DEEP_API_KEY: 'deep', XAI_DEEP_SEARCH_TOOLS: 'google' }))
      .toThrow('XAI_DEEP_SEARCH_TOOLS contains unsupported search tool: google');
  });
});
