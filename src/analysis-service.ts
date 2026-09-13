import type { DiscussionMappingStore } from './discussion-store.js';
import { buildDeepAnalysisPrompt, buildGrokPrompt } from './grok.js';
import { loadAnalysisSkill, loadDeepAnalysisSkill } from './analysis-skill.js';
import { replyInTelegramThread, type TelegramSendResult } from './telegram.js';
import { isXaiSearchUnsupportedError, requestGrokAnalysis, type XaiSearchTool } from './xai-client.js';
import type { StoredAnalysis } from './analysis-tracker.js';
import type { DeepAnalysisProgress } from './analysis-task-queue.js';

export interface TriggerAnalysisOptions {
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  xaiModel: string;
  proxyUrl?: string;
  xaiRetryAttempts?: number;
  xaiRetryMinDelayMs?: number;
  xaiRetryMaxDelayMs?: number;
  xaiMaxTokens?: number;
  /** 启用的 xAI 服务端检索工具；为空则不联网检索。 */
  xaiSearchTools?: readonly XaiSearchTool[];
  discussionChatId?: string;
  telegramRetryAttempts?: number;
  telegramRetryMinDelayMs?: number;
  telegramRetryMaxDelayMs?: number;
  discussionStore: DiscussionMappingStore;
  botToken: string;
  channelChatId: number;
  channelMessageId: number;
  projectKey: string;
  existingAnalysis?: StoredAnalysis | null;
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
  analyze?: (prompt: string) => Promise<string>;
  loadSkill?: () => Promise<string>;
  reply?: (options: {
    botToken: string;
    chatId: string;
    replyToMessageId: number;
    text: string;
    proxyUrl?: string;
  }) => Promise<TelegramSendResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export type TriggerAnalysisResult =
  | {
      type: 'analysis';
      message: TelegramSendResult;
      analysisText: string;
    }
  | {
      type: 'reminder';
      message: TelegramSendResult;
      existingAnalysis: StoredAnalysis;
    };

const CITATION_MARKER_PATTERN = /\s*[\[【]\d+(?:\s*[,，、]\s*\d+)*[\]】]/g;

function removeAnalysisSourceBlock(text: string): string {
  const lines = text.trim().split('\n');
  const sourceStart = lines.findIndex((line) =>
    /^(?:#{1,6}\s*)?(?:source|sources|来源|参考来源|数据来源|引用列表)\s*[:：]?/i.test(line.trim())
  );
  return (sourceStart >= 0 ? lines.slice(0, sourceStart) : lines)
    .map((line) =>
      line
        .replace(/\s*\[\[\d+\]\]\([^)]+\)/g, '')
        .replace(CITATION_MARKER_PATTERN, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/\*/g, '')
    )
    .join('\n')
    .trim();
}

interface AnalysisRequestContext {
  apiKey: string;
  searchTools: readonly XaiSearchTool[];
  analysisSkill: string;
  warn: (message: string) => void;
}

async function requestAnalysisText(options: TriggerAnalysisOptions, context: AnalysisRequestContext): Promise<string> {
  const request = (searchTools: readonly XaiSearchTool[]): Promise<string> => {
    const prompt = buildGrokPrompt({
      title: options.title,
      content: options.content,
      link: options.link,
      count: options.count,
      star: options.star,
      searchTools,
      analysisSkill: context.analysisSkill
    });
    if (options.analyze) {
      return options.analyze(prompt);
    }
    return requestGrokAnalysis({
      apiKey: context.apiKey,
      baseUrl: options.xaiBaseUrl,
      model: options.xaiModel,
      proxyUrl: options.proxyUrl,
      retryAttempts: options.xaiRetryAttempts,
      retryMinDelayMs: options.xaiRetryMinDelayMs,
      retryMaxDelayMs: options.xaiRetryMaxDelayMs,
      maxTokens: options.xaiMaxTokens,
      searchTools,
      warn: context.warn,
      onRetry: (error, attempt, delayMs) => {
        context.warn(
          `Grok 分析请求失败，${delayMs}ms 后重试：attempt=${attempt} error=${
            error instanceof Error ? error.message : String(error)
          }`
        );
      },
      prompt
    });
  };

  try {
    return await request(context.searchTools);
  } catch (error) {
    if (context.searchTools.length === 0 || !isXaiSearchUnsupportedError(error)) {
      throw error;
    }
    context.warn(`xAI 服务端检索工具不可用，退回普通 Grok 请求：${error.message}`);
    return request([]);
  }
}

export async function triggerAnalysisComment(options: TriggerAnalysisOptions): Promise<TriggerAnalysisResult | void> {
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  const reply = options.reply ?? replyInTelegramThread;

  if (!options.xaiApiKey) {
    warn('未配置 XAI_API_KEY，跳过 Grok 分析');
    return;
  }
  if (!options.discussionChatId) {
    warn('未配置 DISCUSSION_CHAT_ID，跳过讨论群评论');
    return;
  }

  if (options.existingAnalysis) {
    const reminderResult = await reply({
      botToken: options.botToken,
      chatId: options.existingAnalysis.discussionChatId,
      replyToMessageId: options.existingAnalysis.analysisMessageId,
      text: `重复命中提醒\n\n${options.title}\n监控池关注数：${options.count}\n当前重要程度：${options.star} 星`,
      proxyUrl: options.proxyUrl,
      retryAttempts: options.telegramRetryAttempts,
      retryMinDelayMs: options.telegramRetryMinDelayMs,
      retryMaxDelayMs: options.telegramRetryMaxDelayMs,
      onRetry: (error, attempt, delayMs) => {
        warn(
          `Telegram 重复提醒回复失败，${delayMs}ms 后重试：attempt=${attempt} error=${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
    info(`已回复既有分析评论：${options.projectKey}`);
    return {
      type: 'reminder',
      message: reminderResult,
      existingAnalysis: options.existingAnalysis
    };
  }

  const mapping = await options.discussionStore.waitFor(options.channelChatId, options.channelMessageId, 30_000);
  if (!mapping) {
    warn(`未找到讨论群映射：${options.channelChatId}/${options.channelMessageId}`);
    return;
  }

  const analysisSkill = await (options.loadSkill ?? loadAnalysisSkill)();
  const analysis = await requestAnalysisText(options, {
    apiKey: options.xaiApiKey,
    searchTools: [...new Set(options.xaiSearchTools ?? [])],
    analysisSkill,
    warn
  });
  const cleanedAnalysis = removeAnalysisSourceBlock(analysis);

  const replyResult = await reply({
    botToken: options.botToken,
    chatId: options.discussionChatId,
    replyToMessageId: mapping.discussionMessageId,
    text: `Grok 分析\n\n${cleanedAnalysis}`,
    proxyUrl: options.proxyUrl,
    retryAttempts: options.telegramRetryAttempts,
    retryMinDelayMs: options.telegramRetryMinDelayMs,
    retryMaxDelayMs: options.telegramRetryMaxDelayMs,
    onRetry: (error, attempt, delayMs) => {
      warn(
        `Telegram Grok 分析回复失败，${delayMs}ms 后重试：attempt=${attempt} error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });

  info(`已写入讨论群评论：${mapping.discussionChatId}/${mapping.discussionMessageId}`);
  return {
    type: 'analysis',
    message: replyResult,
    analysisText: cleanedAnalysis
  };
}

export interface TriggerDeepAnalysisOptions {
  xaiApiKey: string;
  xaiBaseUrl: string;
  xaiModel: string;
  xaiMaxTokens?: number;
  /** 深度渠道可用的服务端检索工具；multi-agent 渠道通常只有 web_search。 */
  xaiSearchTools?: readonly XaiSearchTool[];
  proxyUrl?: string;
  xaiRetryAttempts?: number;
  xaiRetryMinDelayMs?: number;
  xaiRetryMaxDelayMs?: number;
  discussionChatId: string;
  botToken: string;
  channelChatId: number;
  channelMessageId: number;
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
  /** 该项目此前标准分析正文，作为深投研上下文。 */
  previousAnalysisText?: string;
  progress?: DeepAnalysisProgress;
  /** 生成完成及每个分片发送成功后持久化，重试只补发尚未送达的分片。 */
  onProgress?: (progress: DeepAnalysisProgress) => Promise<void>;
  telegramRetryAttempts?: number;
  telegramRetryMinDelayMs?: number;
  telegramRetryMaxDelayMs?: number;
  discussionStore: DiscussionMappingStore;
  analyze?: (prompt: string) => Promise<string>;
  loadSkill?: () => Promise<string>;
  reply?: (options: {
    botToken: string;
    chatId: string;
    replyToMessageId: number;
    text: string;
    proxyUrl?: string;
  }) => Promise<TelegramSendResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export type TriggerDeepAnalysisResult = {
  type: 'analysis';
  messages: TelegramSendResult[];
  analysisText: string;
  analysisCreatedAt?: string;
};

const DEEP_MESSAGE_CHAR_LIMIT = 3_800;

/**
 * 深投研正文的轻量清理：保留裸链接证据，只去掉加粗星号和 wiki 式引用标记。
 */
export function cleanDeepAnalysisText(text: string): string {
  return text
    .replace(/\[\[(\d+)\]\]\(([^)\s]+)\)/g, '$2')
    .replace(CITATION_MARKER_PATTERN, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .trim();
}

/** 按行边界把长文切成 Telegram 单条消息上限内的分片。 */
export function splitTelegramMessageText(text: string, limit = DEEP_MESSAGE_CHAR_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('Telegram message limit must be an integer of at least 2');
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    let boundary = slice.lastIndexOf('\n');
    if (boundary < limit * 0.5) boundary = limit;
    const before = remaining.charCodeAt(boundary - 1);
    const after = remaining.charCodeAt(boundary);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) boundary -= 1;
    chunks.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

export async function triggerDeepAnalysisComment(
  options: TriggerDeepAnalysisOptions
): Promise<TriggerDeepAnalysisResult | null> {
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  const reply = options.reply ?? replyInTelegramThread;

  let progress = options.progress;
  if (!progress) {
    const mapping = await options.discussionStore.waitFor(options.channelChatId, options.channelMessageId, 30_000);
    if (!mapping) {
      warn(`深度分析未找到讨论群映射：${options.channelChatId}/${options.channelMessageId}`);
      return null;
    }
    const analysisSkill = await (options.loadSkill ?? loadDeepAnalysisSkill)();
    const searchTools = [...new Set(options.xaiSearchTools ?? [])];
    const request = async (tools: readonly XaiSearchTool[]): Promise<string> => {
      const prompt = buildDeepAnalysisPrompt({
        title: options.title,
        content: options.content,
        link: options.link,
        count: options.count,
        star: options.star,
        searchTools: tools,
        analysisSkill,
        previousAnalysisText: options.previousAnalysisText
      });
      if (options.analyze) {
        return options.analyze(prompt);
      }
      return requestGrokAnalysis({
        apiKey: options.xaiApiKey,
        baseUrl: options.xaiBaseUrl,
        model: options.xaiModel,
        proxyUrl: options.proxyUrl,
        retryAttempts: options.xaiRetryAttempts,
        retryMinDelayMs: options.xaiRetryMinDelayMs,
        retryMaxDelayMs: options.xaiRetryMaxDelayMs,
        maxTokens: options.xaiMaxTokens,
        searchTools: tools,
        warn,
        onRetry: (error, attempt, delayMs) => {
          warn(
            `深度投研请求失败，${delayMs}ms 后重试：attempt=${attempt} error=${
              error instanceof Error ? error.message : String(error)
            }`
          );
        },
        prompt
      });
    };

    let analysis: string;
    try {
      analysis = await request(searchTools);
    } catch (error) {
      if (searchTools.length === 0 || !isXaiSearchUnsupportedError(error)) {
        throw error;
      }
      warn(`深度渠道检索工具不可用，退回普通请求：${error.message}`);
      analysis = await request([]);
    }

    const analysisText = cleanDeepAnalysisText(analysis);
    if (!analysisText) throw new Error('Deep analysis returned empty report text');
    const chunks = splitTelegramMessageText(analysisText);
    progress = {
      analysisText,
      analysisCreatedAt: new Date().toISOString(),
      messageTexts: chunks.map((chunk, index) => {
        const label = chunks.length > 1 ? `Grok 深度分析（${index + 1}/${chunks.length}）` : 'Grok 深度分析';
        return `${label}\n\n${chunk}`;
      }),
      discussionChatId: String(mapping.discussionChatId),
      replyToMessageId: mapping.discussionMessageId,
      sentMessages: []
    };
    await options.onProgress?.(progress);
  }

  while (progress.sentMessages.length < progress.messageTexts.length) {
    const message = await reply({
      botToken: options.botToken,
      chatId: progress.discussionChatId,
      replyToMessageId: progress.replyToMessageId,
      text: progress.messageTexts[progress.sentMessages.length],
      proxyUrl: options.proxyUrl,
      retryAttempts: options.telegramRetryAttempts,
      retryMinDelayMs: options.telegramRetryMinDelayMs,
      retryMaxDelayMs: options.telegramRetryMaxDelayMs,
      onRetry: (error, attempt, delayMs) => {
        warn(
          `Telegram 深度分析回复失败，${delayMs}ms 后重试：attempt=${attempt} error=${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
    progress = { ...progress, sentMessages: [...progress.sentMessages, message] };
    await options.onProgress?.(progress);
  }

  info(`已写入深度分析评论：${progress.discussionChatId}/${progress.replyToMessageId} 共 ${progress.sentMessages.length} 条`);
  return {
    type: 'analysis',
    messages: progress.sentMessages,
    analysisText: progress.analysisText,
    analysisCreatedAt: progress.analysisCreatedAt
  };
}
