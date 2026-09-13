import type { AnalysisArchiveStore } from './analysis-archive-store.js';
import {
  triggerDeepAnalysisComment,
  type TriggerDeepAnalysisResult
} from './analysis-service.js';
import type {
  AnalysisTaskInput,
  AnalysisTaskProcessResult,
  AnalysisTaskQueue,
  AnalysisTaskRecord
} from './analysis-task-queue.js';
import type { ServiceConfig } from './config.js';
import type { DiscussionMappingStore } from './discussion-store.js';

export async function enqueueDeepAnalysisTask(options: {
  task: AnalysisTaskInput;
  config: Pick<ServiceConfig, 'deepAnalysis' | 'discussionChatId'>;
  queue: Pick<AnalysisTaskQueue, 'enqueue'>;
  archiveStore: Pick<AnalysisArchiveStore, 'getFirstDeepAnalysis'>;
}): Promise<boolean> {
  if (!options.config.deepAnalysis || !options.config.discussionChatId || options.task.star < 5) return false;
  if (await options.archiveStore.getFirstDeepAnalysis(options.task.projectKey)) return false;
  return options.queue.enqueue({
    ...options.task,
    taskKey: `${options.task.channelChatId}:${options.task.channelMessageId}:deep`,
    kind: 'deep'
  });
}

export async function archiveDeepAnalysisTaskResult(options: {
  task: AnalysisTaskRecord;
  result: TriggerDeepAnalysisResult;
  archiveStore: Pick<AnalysisArchiveStore, 'upsert'>;
  now?: Date;
}): Promise<void> {
  const firstMessage = options.result.messages[0];
  if (!firstMessage) throw new Error('Deep analysis has no delivered messages');
  const archivedAt = (options.now ?? new Date()).toISOString();
  await options.archiveStore.upsert({
    version: 1,
    recordType: 'deep',
    sourceTaskKey: options.task.taskKey,
    projectKey: options.task.projectKey,
    title: options.task.title,
    content: options.task.content,
    link: options.task.link,
    mainPushedAt: options.task.mainPushedAt,
    archivedAt,
    analysisCreatedAt: options.result.analysisCreatedAt ?? archivedAt,
    star: options.task.star,
    count: options.task.count,
    channelMessage: {
      chatId: options.task.channelChatId,
      messageId: options.task.channelMessageId
    },
    discussionAnalysisMessage: { chatId: firstMessage.chatId, messageId: firstMessage.messageId },
    analysisText: options.result.analysisText
  });
}

export async function processDeepAnalysisTask(options: {
  task: AnalysisTaskRecord;
  config: ServiceConfig;
  queue: Pick<AnalysisTaskQueue, 'saveDeepProgress'>;
  archiveStore: Pick<AnalysisArchiveStore, 'getFirstDeepAnalysis' | 'getFirstAnalysis' | 'upsert'>;
  discussionStore: DiscussionMappingStore;
  trigger?: typeof triggerDeepAnalysisComment;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<AnalysisTaskProcessResult> {
  const { task, config, archiveStore, discussionStore } = options;
  if (await archiveStore.getFirstDeepAnalysis(task.projectKey)) return { status: 'done' };

  const deep = config.deepAnalysis;
  if (!deep || !config.discussionChatId) return { status: 'retry', reason: 'deep analysis configuration unavailable' };
  if (!task.deepProgress && !discussionStore.get(task.channelChatId, task.channelMessageId)) {
    return { status: 'retry', reason: 'discussion mapping pending' };
  }

  const previousAnalysis = task.deepProgress ? null : await archiveStore.getFirstAnalysis(task.projectKey);
  const result = await (options.trigger ?? triggerDeepAnalysisComment)({
    xaiApiKey: deep.xaiApiKey,
    xaiBaseUrl: deep.xaiBaseUrl,
    xaiModel: deep.xaiModel,
    xaiMaxTokens: deep.xaiMaxTokens,
    xaiSearchTools: deep.xaiSearchTools,
    proxyUrl: config.proxyUrl,
    xaiRetryAttempts: config.xaiRetryAttempts,
    xaiRetryMinDelayMs: config.xaiRetryMinDelayMs,
    xaiRetryMaxDelayMs: config.xaiRetryMaxDelayMs,
    discussionChatId: config.discussionChatId,
    botToken: config.telegramBotToken,
    channelChatId: task.channelChatId,
    channelMessageId: task.channelMessageId,
    previousAnalysisText: previousAnalysis?.analysisText,
    progress: task.deepProgress,
    onProgress: (progress) => options.queue.saveDeepProgress(task.taskKey, progress),
    title: task.title,
    content: task.content,
    link: task.link,
    count: task.count,
    star: task.star,
    telegramRetryAttempts: config.telegramRetryAttempts,
    telegramRetryMinDelayMs: config.telegramRetryMinDelayMs,
    telegramRetryMaxDelayMs: config.telegramRetryMaxDelayMs,
    discussionStore,
    info: options.info,
    warn: options.warn
  });
  if (!result) return { status: 'retry', reason: 'deep analysis result not ready' };

  await archiveDeepAnalysisTaskResult({ task, result, archiveStore });
  return { status: 'done' };
}
