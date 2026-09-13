import {
  DEFAULT_ALPHA_BASE_URL,
  DEFAULT_ALPHA_WS_BASE_URL
} from './alpha-client.js';
import { parseStarLevels } from './common-follow-rules.js';
import { XAI_SEARCH_TOOL_TYPES, type XaiSearchTool } from './xai-client.js';

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
  xaiRetryAttempts: number;
  xaiRetryMinDelayMs: number;
  xaiRetryMaxDelayMs: number;
  xaiMaxTokens: number;
  xaiSearchTools: XaiSearchTool[];
  deepAnalysis?: DeepAnalysisConfig;
  commonFollowStarLevels: number[];
  heartbeatTimeoutMs: number;
  businessSilenceTimeoutMs: number;
  alphaReplayLookbackMs: number;
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
  telegramRetryAttempts: number;
  telegramRetryMinDelayMs: number;
  telegramRetryMaxDelayMs: number;
  failedQueuePath: string;
  failedQueueDeadLetterPath: string;
  failedQueueRetryIntervalMs: number;
  failedQueueMaxAttempts: number;
  analysisQueuePath: string;
  analysisQueueDeadLetterPath: string;
  analysisQueueRetryIntervalMs: number;
  analysisQueueMaxAttempts: number;
  analysisArchivePath: string;
  exportAdminUsernames: string[];
  exportAllowedChatIds: string[];
  projectStatePath: string;
}

type EnvLike = Record<string, string | undefined>;

/**
 * 5 星深度投研配置：走独立渠道（中转站 + multi-agent 模型）。
 * XAI_DEEP_API_KEY 未配置时深度分析整体关闭。
 */
export interface DeepAnalysisConfig {
  xaiApiKey: string;
  xaiBaseUrl: string;
  xaiModel: string;
  xaiMaxTokens: number;
  xaiSearchTools: XaiSearchTool[];
}

const DEFAULT_DEEP_BASE_URL = 'https://api.fengshao1227.com';
const DEFAULT_DEEP_MODEL = 'grok-4.20-multi-agent-0309';
const DEFAULT_DEEP_SEARCH_TOOLS: readonly XaiSearchTool[] = ['web_search'];

const DEFAULT_XAI_SEARCH_TOOLS: readonly XaiSearchTool[] = ['web_search', 'x_search'];

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

function parseCsvList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseUsernameList(raw: string | undefined): string[] {
  return parseCsvList(raw)
    .map((value) => value.replace(/^@/, '').toLowerCase())
    .filter((value) => value.length > 0);
}

/**
 * 未定义或空串 → 默认开启 web_search + x_search（.env.example 的空值经 dotenv 加载后是空串，不能当成关闭）；
 * `none` → 关闭联网检索；其他值必须是受支持的工具名。
 */
function parseXaiSearchTools(env: EnvLike, key: string, fallback: readonly XaiSearchTool[] = DEFAULT_XAI_SEARCH_TOOLS): XaiSearchTool[] {
  const raw = env[key]?.trim();
  if (!raw) return [...fallback];
  if (raw.toLowerCase() === 'none') return [];

  const tools: XaiSearchTool[] = [];
  for (const value of parseCsvList(raw)) {
    const normalized = value.toLowerCase();
    if (!(XAI_SEARCH_TOOL_TYPES as readonly string[]).includes(normalized)) {
      throw new Error(`${key} contains unsupported search tool: ${value}`);
    }
    const tool = normalized as XaiSearchTool;
    if (!tools.includes(tool)) {
      tools.push(tool);
    }
  }
  return tools;
}

export function parseServiceConfig(env: EnvLike): ServiceConfig {
  const deepApiKey = env.XAI_DEEP_API_KEY?.trim();
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
    xaiRetryAttempts: parsePositiveInteger(env, 'XAI_RETRY_ATTEMPTS', 5),
    xaiRetryMinDelayMs: parsePositiveInteger(env, 'XAI_RETRY_MIN_DELAY_MS', 1_000),
    xaiRetryMaxDelayMs: parsePositiveInteger(env, 'XAI_RETRY_MAX_DELAY_MS', 20_000),
    xaiMaxTokens: parsePositiveInteger(env, 'XAI_MAX_TOKENS', 2_048),
    xaiSearchTools: parseXaiSearchTools(env, 'XAI_SEARCH_TOOLS'),
    deepAnalysis: deepApiKey
      ? {
          xaiApiKey: deepApiKey,
          xaiBaseUrl: env.XAI_DEEP_BASE_URL?.trim() || DEFAULT_DEEP_BASE_URL,
          xaiModel: env.XAI_DEEP_MODEL?.trim() || DEFAULT_DEEP_MODEL,
          xaiMaxTokens: parsePositiveInteger(env, 'XAI_DEEP_MAX_TOKENS', 4_096),
          xaiSearchTools: parseXaiSearchTools(env, 'XAI_DEEP_SEARCH_TOOLS', DEFAULT_DEEP_SEARCH_TOOLS)
        }
      : undefined,
    commonFollowStarLevels: parseStarLevels(env.COMMON_FOLLOW_STAR_LEVELS),
    heartbeatTimeoutMs: parsePositiveInteger(env, 'ALPHA_HEARTBEAT_TIMEOUT_MS', 90_000),
    businessSilenceTimeoutMs: parsePositiveInteger(env, 'ALPHA_BUSINESS_SILENCE_TIMEOUT_MS', 60_000),
    alphaReplayLookbackMs: parsePositiveInteger(env, 'ALPHA_REPLAY_LOOKBACK_MS', 600_000),
    reconnectMinDelayMs: parsePositiveInteger(env, 'ALPHA_RECONNECT_MIN_DELAY_MS', 1_000),
    reconnectMaxDelayMs: parsePositiveInteger(env, 'ALPHA_RECONNECT_MAX_DELAY_MS', 30_000),
    telegramRetryAttempts: parsePositiveInteger(env, 'TELEGRAM_RETRY_ATTEMPTS', 5),
    telegramRetryMinDelayMs: parsePositiveInteger(env, 'TELEGRAM_RETRY_MIN_DELAY_MS', 1_000),
    telegramRetryMaxDelayMs: parsePositiveInteger(env, 'TELEGRAM_RETRY_MAX_DELAY_MS', 30_000),
    failedQueuePath: env.FAILED_QUEUE_PATH?.trim() || 'data/failed-messages.jsonl',
    failedQueueDeadLetterPath: env.FAILED_QUEUE_DEAD_LETTER_PATH?.trim() || 'data/dead-letter-messages.jsonl',
    failedQueueRetryIntervalMs: parsePositiveInteger(env, 'FAILED_QUEUE_RETRY_INTERVAL_MS', 30_000),
    failedQueueMaxAttempts: parsePositiveInteger(env, 'FAILED_QUEUE_MAX_ATTEMPTS', 20),
    analysisQueuePath: env.ANALYSIS_QUEUE_PATH?.trim() || 'data/analysis-tasks.jsonl',
    analysisQueueDeadLetterPath: env.ANALYSIS_QUEUE_DEAD_LETTER_PATH?.trim() || 'data/analysis-dead-letter.jsonl',
    analysisQueueRetryIntervalMs: parsePositiveInteger(env, 'ANALYSIS_QUEUE_RETRY_INTERVAL_MS', 30_000),
    analysisQueueMaxAttempts: parsePositiveInteger(env, 'ANALYSIS_QUEUE_MAX_ATTEMPTS', 30),
    analysisArchivePath: env.ANALYSIS_ARCHIVE_PATH?.trim() || 'data/analysis-archive.jsonl',
    exportAdminUsernames: parseUsernameList(env.EXPORT_ADMIN_USERNAMES),
    exportAllowedChatIds: parseCsvList(env.EXPORT_ALLOWED_CHAT_IDS),
    projectStatePath: env.PROJECT_STATE_PATH?.trim() || 'data/project-state.json'
  };
}
