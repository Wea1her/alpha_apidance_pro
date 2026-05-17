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
import {
  AnalysisTaskQueue,
  startAnalysisRetryWorker
} from './analysis-task-queue.js';
import { DiscussionMappingStore } from './discussion-store.js';
import { startDiscussionPoller } from './discussion-poller.js';
import {
  FailedMessageQueue,
  startFailedMessageRetryWorker,
  type FailedMainPushInput
} from './failed-message-queue.js';
import {
  ProjectStateStore,
  hydrateProjectStateMaps,
  serializeProjectStateMaps
} from './project-state-store.js';
import { sendTelegramMessage, type TelegramSendResult } from './telegram.js';

export interface ClassificationDecision {
  allowPush: boolean;
  type: string;
  reason?: string;
}

export interface ChannelMessageReference {
  chatId: number;
  messageId: number;
}

export interface ProcessAlphaMessageOptions {
  raw: string;
  receivedAt: Date;
  commonFollowStarLevels: readonly number[];
  dedupe: Set<string>;
  inFlight?: Set<string>;
  projectStars?: Map<string, number>;
  projectPushCounts?: Map<string, number>;
  projectFirstChannelMessages?: Map<string, ChannelMessageReference>;
  projectLocks?: Map<string, Promise<void>>;
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
  enqueueFailedMainPush?: (record: FailedMainPushInput) => Promise<void>;
  persistProjectState?: () => Promise<void>;
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
  const matched = link.match(/^https:\/\/(?:x|twitter)\.com\/([^/?#]+)/i);
  return matched?.[1] ?? null;
}

function buildProjectKey(message: Record<string, unknown>): string {
  const link = messageString(message, 'link').trim();
  const handle = parseChannelHandle(link);
  if (handle) return handle.toLowerCase();
  if (link) return link.toLowerCase();
  return (messageString(message, 'title') || 'unknown').trim().toLowerCase();
}

function buildAnalysisTaskKey(channelChatId: number, channelMessageId: number): string {
  return `${channelChatId}:${channelMessageId}`;
}

async function runWithProjectLock<T>(
  locks: Map<string, Promise<void>> | undefined,
  projectKey: string,
  task: () => Promise<T>
): Promise<T> {
  if (!locks) return task();
  const previous = locks.get(projectKey) ?? Promise.resolve();
  let release: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  locks.set(projectKey, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release!();
    if (locks.get(projectKey) === tail) {
      locks.delete(projectKey);
    }
  }
}

function calculateProjectPushCount(previousPushCount: number, star: number, maxStar: number): number {
  if (star >= maxStar) {
    return Math.max(previousPushCount + 1, maxStar);
  }
  return star;
}

function buildTelegramChannelMessageUrl(message: ChannelMessageReference): string | null {
  const chatId = String(message.chatId);
  if (!chatId.startsWith('-100')) return null;
  const internalChannelId = chatId.slice(4);
  if (!/^\d+$/.test(internalChannelId)) return null;
  return `https://t.me/c/${internalChannelId}/${message.messageId}`;
}

function buildForwardMessage(
  message: Record<string, unknown>,
  count: number,
  starText: string,
  pushCount: number,
  firstPushUrl: string | null,
  latencyMs: number | null,
  starChange?: { from: number; to: number }
): string {
  const title = messageString(message, 'title') || 'Alpha 推送';
  const content = messageString(message, 'content');
  const link = messageString(message, 'link');
  const latencyLine = latencyMs === null ? '' : `\n延迟：${(latencyMs / 1000).toFixed(3)} 秒`;
  return [
    `第${pushCount}次推送`,
    firstPushUrl ? `首次推送：${firstPushUrl}` : '',
    starChange ? `检测到项目星级变化：${starChange.from}星 → ${starChange.to}星` : '',
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
  if (options.inFlight?.has(dedupeKey)) {
    info(`事件正在处理中，跳过重复并发：${dedupeKey}`);
    return;
  }
  options.inFlight?.add(dedupeKey);

  try {
    const projectKey = buildProjectKey(message);
    await runWithProjectLock(options.projectLocks, projectKey, async () => {
      const previousStar = options.projectStars?.get(projectKey) ?? 0;
      const maxStar = options.commonFollowStarLevels.length;
      const isMaxStar = decision.star >= maxStar;
      if (!isMaxStar && previousStar >= decision.star) {
        info(`项目星级未升高，跳过重复推送：project=${projectKey} previous=${previousStar} current=${decision.star}`);
        options.dedupe.add(dedupeKey);
        return;
      }
      const starChange =
        previousStar > 0 && previousStar < decision.star ? { from: previousStar, to: decision.star } : undefined;
      const previousPushCount = options.projectPushCounts?.get(projectKey) ?? previousStar;
      const pushCount = calculateProjectPushCount(previousPushCount, decision.star, maxStar);
      const firstChannelMessage = options.projectFirstChannelMessages?.get(projectKey) ?? null;
      const firstPushUrl =
        pushCount > 1 && firstChannelMessage ? buildTelegramChannelMessageUrl(firstChannelMessage) : null;
      const hadPreviousPushCount = options.projectPushCounts?.has(projectKey) ?? false;
      const rollbackReservedPushCount = (): void => {
        if (!options.projectPushCounts || options.projectPushCounts.get(projectKey) !== pushCount) return;
        if (hadPreviousPushCount) {
          options.projectPushCounts.set(projectKey, previousPushCount);
        } else {
          options.projectPushCounts.delete(projectKey);
        }
      };
      options.projectPushCounts?.set(projectKey, pushCount);
      if (options.projectStars && !isMaxStar) {
        options.projectStars.set(projectKey, decision.star);
      }

      if (options.classify) {
        try {
          const classification = await options.classify(message, count, decision.star);
          const reason = classification.reason ? ` reason=${classification.reason}` : '';
          if (!classification.allowPush) {
            if (options.projectStars && !isMaxStar) {
              if (previousStar > 0) {
                options.projectStars.set(projectKey, previousStar);
              } else {
                options.projectStars.delete(projectKey);
              }
            }
            rollbackReservedPushCount();
            options.dedupe.add(dedupeKey);
            info(`账号分类拦截：type=${classification.type}${reason}`);
            return;
          }
          info(`账号分类允许：type=${classification.type}${reason}`);
        } catch (error) {
          warn(`账号分类失败，按保守策略推送：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const text = buildForwardMessage(
        message,
        count,
        decision.stars,
        pushCount,
        firstPushUrl,
        calculateReceiveLatencyMs(message, options.receivedAt),
        starChange
      );

      let sendResult: TelegramSendResult;
      try {
        sendResult = await options.send(text);
        options.projectStars?.set(projectKey, decision.star);
        options.projectPushCounts?.set(projectKey, pushCount);
        if (!options.projectFirstChannelMessages?.has(projectKey)) {
          options.projectFirstChannelMessages?.set(projectKey, sendResult);
        }
        await options.persistProjectState?.();
        options.dedupe.add(dedupeKey);
      } catch (error) {
        let queuedFailedPush = false;
        if (options.projectStars && !isMaxStar) {
          if (previousStar > 0) {
            options.projectStars.set(projectKey, previousStar);
          } else {
            options.projectStars.delete(projectKey);
          }
        }
        if (options.enqueueFailedMainPush) {
          await options.enqueueFailedMainPush({
            dedupeKey,
            raw: options.raw,
            text,
            receivedAt: options.receivedAt.toISOString(),
            count,
            star: decision.star,
            lastError: error instanceof Error ? error.message : String(error)
          });
          queuedFailedPush = true;
        }
        if (!queuedFailedPush) {
          rollbackReservedPushCount();
        }
        throw error;
      }

      if (options.afterSend) {
        await options.afterSend(message, count, decision.star, sendResult);
      }
    });
  } finally {
    options.inFlight?.delete(dedupeKey);
  }
}

function reconnectDelay(attempt: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, minMs * 2 ** Math.min(attempt, 8));
}

export async function startAlphaService(options: StartAlphaServiceOptions): Promise<() => void> {
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  const dedupe = new Set<string>();
  const inFlight = new Set<string>();
  const projectStars = new Map<string, number>();
  const projectPushCounts = new Map<string, number>();
  const projectFirstChannelMessages = new Map<string, ChannelMessageReference>();
  const projectLocks = new Map<string, Promise<void>>();
  const analysisTracker = new AnalysisTracker();
  const projectStateStore = new ProjectStateStore({
    filePath: options.config.projectStatePath,
    warn
  });
  hydrateProjectStateMaps(
    await projectStateStore.load(),
    projectStars,
    projectPushCounts,
    projectFirstChannelMessages
  );
  const persistProjectState = async (): Promise<void> => {
    try {
      await projectStateStore.save(
        serializeProjectStateMaps(projectStars, projectPushCounts, projectFirstChannelMessages)
      );
    } catch (error) {
      warn(`写入项目状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const wallet = new Wallet(options.config.alphaWalletPrivateKey);
  const factory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  const discussionStore = new DiscussionMappingStore();
  const stopDiscussionPoller = startDiscussionPoller({
    botToken: options.config.telegramBotToken,
    proxyUrl: options.config.proxyUrl,
    store: discussionStore,
    retryAttempts: options.config.telegramRetryAttempts,
    retryMinDelayMs: options.config.telegramRetryMinDelayMs,
    retryMaxDelayMs: options.config.telegramRetryMaxDelayMs,
    info,
    warn
  });
  const failedQueue = new FailedMessageQueue({
    filePath: options.config.failedQueuePath,
    deadLetterPath: options.config.failedQueueDeadLetterPath,
    maxAttempts: options.config.failedQueueMaxAttempts
  });
  const analysisQueue = new AnalysisTaskQueue({
    filePath: options.config.analysisQueuePath,
    deadLetterPath: options.config.analysisQueueDeadLetterPath,
    maxAttempts: options.config.analysisQueueMaxAttempts
  });

  const sendMainTelegramMessage = (text: string): Promise<TelegramSendResult> =>
    sendTelegramMessage({
      botToken: options.config.telegramBotToken,
      chatId: options.config.telegramChatId,
      text,
      proxyUrl: options.config.proxyUrl,
      retryAttempts: options.config.telegramRetryAttempts,
      retryMinDelayMs: options.config.telegramRetryMinDelayMs,
      retryMaxDelayMs: options.config.telegramRetryMaxDelayMs,
      onRetry: (error, attempt, delayMs) => {
        warn(
          `Telegram 主推送失败，${delayMs}ms 后重试：attempt=${attempt} error=${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });

  const handleAfterMainSend = async (
    message: Record<string, unknown>,
    count: number,
    star: number,
    sendResult: TelegramSendResult
  ): Promise<void> => {
    const projectKey = buildProjectKey(message);
    if (!projectFirstChannelMessages.has(projectKey)) {
      projectFirstChannelMessages.set(projectKey, sendResult);
    }

    if (!options.config.xaiApiKey || !options.config.discussionChatId) {
      return;
    }
    const link = messageString(message, 'link');
    const task = {
      taskKey: buildAnalysisTaskKey(sendResult.chatId, sendResult.messageId),
      projectKey,
      channelChatId: sendResult.chatId,
      channelMessageId: sendResult.messageId,
      title: messageString(message, 'title'),
      content: messageString(message, 'content'),
      link,
      count,
      star
    };
    await analysisQueue.enqueue(task);
    info(`主推送成功，已写入分析补偿队列：taskKey=${task.taskKey}`);
  };

  const processAnalysisTask = async (
    task: {
      taskKey: string;
      projectKey: string;
      channelChatId: number;
      channelMessageId: number;
      title: string;
      content: string;
      link: string;
      count: number;
      star: number;
    }
  ): Promise<{ status: 'done' | 'retry'; reason?: string }> => {
    if (!options.config.xaiApiKey) {
      return { status: 'done' };
    }
    if (!options.config.discussionChatId) {
      return { status: 'done' };
    }

    const existingAnalysis = analysisTracker.get(task.projectKey);
    if (!existingAnalysis && !discussionStore.get(task.channelChatId, task.channelMessageId)) {
      return { status: 'retry', reason: 'discussion mapping pending' };
    }

    const result = await triggerAnalysisComment({
      xaiApiKey: options.config.xaiApiKey,
      xaiBaseUrl: options.config.xaiBaseUrl,
      xaiModel: options.config.xaiModel,
      twitterToken: options.config.twitterToken,
      twitterApiBaseUrl: options.config.twitterApiBaseUrl,
      proxyUrl: options.config.proxyUrl,
      discussionChatId: options.config.discussionChatId,
      telegramRetryAttempts: options.config.telegramRetryAttempts,
      telegramRetryMinDelayMs: options.config.telegramRetryMinDelayMs,
      telegramRetryMaxDelayMs: options.config.telegramRetryMaxDelayMs,
      discussionStore,
      botToken: options.config.telegramBotToken,
      channelChatId: task.channelChatId,
      channelMessageId: task.channelMessageId,
      projectKey: task.projectKey,
      existingAnalysis,
      title: task.title,
      content: task.content,
      link: task.link,
      count: task.count,
      star: task.star,
      info,
      warn
    });

    if (!existingAnalysis && result && typeof result.messageId === 'number') {
      analysisTracker.set(task.projectKey, {
        discussionChatId: options.config.discussionChatId!,
        analysisMessageId: result.messageId
      });
      return { status: 'done' };
    }

    if (!existingAnalysis && !result) {
      return { status: 'retry', reason: 'analysis result not ready' };
    }

    return { status: 'done' };
  };

  const stopFailedRetryWorker = startFailedMessageRetryWorker({
    queue: failedQueue,
    intervalMs: options.config.failedQueueRetryIntervalMs,
    delivered: dedupe,
    inFlight,
    send: sendMainTelegramMessage,
    afterDelivered: async (message, count, star, sendResult) => {
      const projectKey = buildProjectKey(message);
      const maxStar = options.config.commonFollowStarLevels.length;
      projectStars.set(projectKey, Math.max(projectStars.get(projectKey) ?? 0, star));
      if (!projectPushCounts.has(projectKey)) {
        projectPushCounts.set(projectKey, star >= maxStar ? maxStar : star);
      }
      await handleAfterMainSend(message, count, star, sendResult);
      await persistProjectState();
    },
    info,
    warn
  });
  const stopAnalysisRetryWorker = startAnalysisRetryWorker({
    queue: analysisQueue,
    intervalMs: options.config.analysisQueueRetryIntervalMs,
    process: processAnalysisTask,
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
          inFlight,
          projectStars,
          projectPushCounts,
          projectFirstChannelMessages,
          projectLocks,
          send: sendMainTelegramMessage,
          classify: async (message: Record<string, unknown>, count: number, star: number) => {
            const title = messageString(message, 'title');
            const content = messageString(message, 'content');
            const link = messageString(message, 'link');
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
          afterSend: handleAfterMainSend,
          enqueueFailedMainPush: async (record) => {
            await failedQueue.enqueue(record);
            warn(`主推送失败已写入补偿队列：dedupeKey=${record.dedupeKey} error=${record.lastError ?? ''}`);
          },
          persistProjectState,
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
    stopFailedRetryWorker();
    stopAnalysisRetryWorker();
    clearHeartbeatTimer();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
