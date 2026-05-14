import {
  DEFAULT_ALPHA_BASE_URL,
  DEFAULT_ALPHA_WS_BASE_URL
} from './alpha-client.js';
import { parseStarLevels } from './common-follow-rules.js';

export interface ServiceConfig {
  alphaWalletPrivateKey: string;
  alphaBaseUrl: string;
  alphaWsBaseUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  discussionChatId?: string;
  proxyUrl?: string;
  xaiApiKey?: string;
  xaiBaseUrl: string;
  xaiModel: string;
  commonFollowStarLevels: number[];
  heartbeatTimeoutMs: number;
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
}

type EnvLike = Record<string, string | undefined>;

function requireEnv(env: EnvLike, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function parsePositiveInteger(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${key} must be a positive integer`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

export function parseServiceConfig(env: EnvLike): ServiceConfig {
  return {
    alphaWalletPrivateKey: requireEnv(env, 'ALPHA_WALLET_PRIVATE_KEY'),
    alphaBaseUrl: env.ALPHA_BASE_URL?.trim() || DEFAULT_ALPHA_BASE_URL,
    alphaWsBaseUrl: env.ALPHA_WS_BASE_URL?.trim() || DEFAULT_ALPHA_WS_BASE_URL,
    telegramBotToken: requireEnv(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: requireEnv(env, 'TELEGRAM_CHAT_ID'),
    discussionChatId: env.DISCUSSION_CHAT_ID?.trim() || undefined,
    proxyUrl: env.PROXY_URL?.trim() || env.HTTPS_PROXY?.trim() || env.HTTP_PROXY?.trim() || undefined,
    xaiApiKey: env.XAI_API_KEY?.trim() || undefined,
    xaiBaseUrl: env.XAI_BASE_URL?.trim() || 'https://api.x.ai',
    xaiModel: env.XAI_MODEL?.trim() || 'grok-4.20-fast',
    commonFollowStarLevels: parseStarLevels(env.COMMON_FOLLOW_STAR_LEVELS),
    heartbeatTimeoutMs: parsePositiveInteger(env, 'ALPHA_HEARTBEAT_TIMEOUT_MS', 90_000),
    reconnectMinDelayMs: parsePositiveInteger(env, 'ALPHA_RECONNECT_MIN_DELAY_MS', 1_000),
    reconnectMaxDelayMs: parsePositiveInteger(env, 'ALPHA_RECONNECT_MAX_DELAY_MS', 30_000)
  };
}
