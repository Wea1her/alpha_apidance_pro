import { Wallet } from 'ethers';
import WebSocket from 'ws';
import {
  buildAlphaWsUrl,
  createAlphaLoginPayload,
  isAlphaHeartbeat,
  loginAlpha,
  parseAlphaMessage
} from './alpha-client.js';
import {
  calculateReceiveLatencyMs,
  extractCommonFollowCount,
  formatReceiveLatencyMessage
} from './alpha-event.js';
import { classifyAccount, shouldAllowClassifiedAccount } from './account-classifier.js';
import { buildCommonFollowDecision } from './common-follow-rules.js';
import type { ServiceConfig } from './config.js';
import { triggerAnalysisComment } from './analysis-service.js';
import { AnalysisTracker } from './analysis-tracker.js';
import { DiscussionMappingStore } from './discussion-store.js';
import { startDiscussionPoller } from './discussion-poller.js';
import { sendTelegramMessage, type TelegramSendResult } from './telegram.js';

export interface ClassificationDecision {
  allowPush: boolean;
  type: string;
  reason?: string;
}

export interface ProcessAlphaMessageOptions {
  raw: string;
  receivedAt: Date;
  commonFollowStarLevels: readonly number[];
  dedupe: Set<string>;
  send: (text: string) => Promise<TelegramSendResult>;
  classify?: (
    message: Record<string, unknown>,
    count: number,
    star: number
  ) => Promise<ClassificationDecision>;
  afterSend?: (
    message: Record<string, unknown>,
    count: number,
    star: number,
    sendResult: TelegramSendResult
  ) => Promise<void>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface StartAlphaServiceOptions {
  config: ServiceConfig;
  webSocketFactory?: (url: string) => WebSocket;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

function messageString(message: Record<string, unknown>, field: string): string {
  const value = message[field];
  return typeof value === 'string' ? value : '';
}

function buildDedupeKey(message: Record<string, unknown>): string {
  const channel = messageString(message, 'channel') || 'unknown';
  const link = messageString(message, 'link');
  const title = messageString(message, 'title');
  const pushAt = message.push_at === undefined ? '' : String(message.push_at);
  return [channel, link, title, pushAt].join('|');
}

function parseChannelHandle(link: string): string | null {
  const matched = link.match(/^https:\/\/x\.com\/([^/?#]+)/i);
  return matched?.[1] ?? null;
}

function buildForwardMessage(
  message: Record<string, unknown>,
  count: number,
  starText: string,
  latencyMs: number | null
): string {
  const title = messageString(message, 'title') || 'Alpha 推送';
  const content = messageString(message, 'content');
  const link = messageString(message, 'link');
  const latencyLine = latencyMs === null ? '' : `\n延迟：${(latencyMs / 1000).toFixed(3)} 秒`;
  return [
    `${starText} Alpha 共同关注推送`,
    '',
    title,
    `监控池关注数：${count}`,
    `重要程度：${starText}${latencyLine}`,
    link,
    '',
    content
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

export async function processAlphaMessage(options: ProcessAlphaMessageOptions): Promise<void> {
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  let message: Record<string, unknown>;
  try {
    message = parseAlphaMessage(options.raw);
  } catch (error) {
    warn(`无法解析 alpha 消息：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (isAlphaHeartbeat(message)) {
    info(`[heartbeat] ${options.receivedAt.toISOString()}`);
    return;
  }

  const count = extractCommonFollowCount(message);
  if (count === null) {
    warn(`未识别共同关注数量，跳过推送：${options.raw}`);
    return;
  }

  const decision = buildCommonFollowDecision(count, options.commonFollowStarLevels);
  if (!decision.shouldPush) {
    info(`未达到推送阈值：count=${count}`);
    return;
  }

  const dedupeKey = buildDedupeKey(message);
  if (options.dedupe.has(dedupeKey)) {
    info(`重复事件已跳过：${dedupeKey}`);
    return;
  }
  options.dedupe.add(dedupeKey);

  if (options.classify) {
    try {
      const classification = await options.classify(message, count, decision.star);
      const reason = classification.reason ? ` reason=${classification.reason}` : '';
      if (!classification.allowPush) {
        info(`账号分类拦截：type=${classification.type}${reason}`);
        return;
      }
      info(`账号分类允许：type=${classification.type}${reason}`);
    } catch (error) {
      warn(`账号分类失败，按保守策略推送：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const sendResult = await options.send(
    buildForwardMessage(
      message,
      count,
      decision.stars,
      calculateReceiveLatencyMs(message, options.receivedAt)
    )
  );

  if (options.afterSend) {
    await options.afterSend(message, count, decision.star, sendResult);
  }
}

function reconnectDelay(attempt: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, minMs * 2 ** Math.min(attempt, 8));
}

export async function startAlphaService(options: StartAlphaServiceOptions): Promise<() => void> {
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  const dedupe = new Set<string>();
  const analysisTracker = new AnalysisTracker();
  const wallet = new Wallet(options.config.alphaWalletPrivateKey);
  const factory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  const discussionStore = new DiscussionMappingStore();
  const stopDiscussionPoller = startDiscussionPoller({
    botToken: options.config.telegramBotToken,
    proxyUrl: options.config.proxyUrl,
    store: discussionStore,
    info,
    warn
  });

  let stopped = false;
  let socket: WebSocket | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let attempt = 0;

  const clearHeartbeatTimer = (): void => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const scheduleHeartbeatTimeout = (): void => {
    clearHeartbeatTimer();
    heartbeatTimer = setTimeout(() => {
      warn('alpha heartbeat 超时，主动重连');
      socket?.close();
    }, options.config.heartbeatTimeoutMs);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    try {
      info(`alpha wallet: ${wallet.address}`);
      const payload = await createAlphaLoginPayload(wallet.address, (message) => wallet.signMessage(message));
      const token = await loginAlpha({ baseUrl: options.config.alphaBaseUrl, payload });
      socket = factory(buildAlphaWsUrl(options.config.alphaWsBaseUrl, token));
      socket.on('open', () => {
        attempt = 0;
        info('alpha websocket 已连接');
        scheduleHeartbeatTimeout();
      });
      socket.on('message', (data) => {
        const receivedAt = new Date();
        const raw = data.toString();
        void processAlphaMessage({
          raw,
          receivedAt,
          commonFollowStarLevels: options.config.commonFollowStarLevels,
          dedupe,
          send: (text) =>
            sendTelegramMessage({
              botToken: options.config.telegramBotToken,
              chatId: options.config.telegramChatId,
              text,
              proxyUrl: options.config.proxyUrl
            }),
          classify: async (message: Record<string, unknown>, count: number, star: number) => {
            const link = messageString(message, 'link');
            const title = messageString(message, 'title');
            const content = messageString(message, 'content');
            const result = await classifyAccount({
              xaiApiKey: options.config.xaiApiKey,
              xaiBaseUrl: options.config.xaiBaseUrl,
              xaiModel: options.config.xaiModel,
              proxyUrl: options.config.proxyUrl,
              title,
              content,
              link,
              count,
              star
            });
            return {
              allowPush: shouldAllowClassifiedAccount(result),
              type: result.type,
              reason: result.reason
            };
          },
          afterSend: async (
            message: Record<string, unknown>,
            count: number,
            star: number,
            sendResult: TelegramSendResult
          ) => {
            const link = messageString(message, 'link');
            const title = messageString(message, 'title');
            const content = messageString(message, 'content');
            const handle = parseChannelHandle(link) ?? link;
            const existingAnalysis = analysisTracker.get(handle);

            const result = await triggerAnalysisComment({
              xaiApiKey: options.config.xaiApiKey,
              xaiBaseUrl: options.config.xaiBaseUrl,
              xaiModel: options.config.xaiModel,
              twitterToken: options.config.twitterToken,
              twitterApiBaseUrl: options.config.twitterApiBaseUrl,
              proxyUrl: options.config.proxyUrl,
              discussionChatId: options.config.discussionChatId,
              discussionStore,
              botToken: options.config.telegramBotToken,
              channelChatId: sendResult.chatId,
              channelMessageId: sendResult.messageId,
              projectKey: handle,
              existingAnalysis,
              title,
              content,
              link,
              count,
              star,
              info,
              warn
            });

            if (!existingAnalysis && result && typeof result.messageId === 'number') {
              analysisTracker.set(handle, {
                discussionChatId: options.config.discussionChatId!,
                analysisMessageId: result.messageId
              });
            }
          },
          info,
          warn
        }).catch((error) => {
          warn(`处理 alpha 消息失败：${error instanceof Error ? error.message : String(error)}`);
        });
        scheduleHeartbeatTimeout();
        try {
          const message = parseAlphaMessage(raw);
          if (!isAlphaHeartbeat(message)) {
            info(formatReceiveLatencyMessage(message, receivedAt));
          }
        } catch {
          // parse errors are handled in processAlphaMessage
        }
      });
      socket.on('error', (error) => {
        warn(`alpha websocket 错误：${error.message}`);
      });
      socket.on('close', () => {
        clearHeartbeatTimer();
        if (stopped) return;
        const delay = reconnectDelay(
          attempt,
          options.config.reconnectMinDelayMs,
          options.config.reconnectMaxDelayMs
        );
        attempt += 1;
        warn(`alpha websocket 已断开，${Math.round(delay)}ms 后重连`);
        reconnectTimer = setTimeout(() => {
          void connect();
        }, delay);
      });
    } catch (error) {
      const delay = reconnectDelay(
        attempt,
        options.config.reconnectMinDelayMs,
        options.config.reconnectMaxDelayMs
      );
      attempt += 1;
      warn(`alpha 登录/连接失败：${error instanceof Error ? error.message : String(error)}，${delay}ms 后重试`);
      reconnectTimer = setTimeout(() => {
        void connect();
      }, delay);
    }
  };

  await connect();

  return () => {
    stopped = true;
    stopDiscussionPoller();
    clearHeartbeatTimer();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
