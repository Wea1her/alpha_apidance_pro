import type { DiscussionMappingStore } from './discussion-store.js';
import { buildGrokPrompt } from './grok.js';
import { loadAnalysisSkill } from './analysis-skill.js';
import { collectRugHistoryEvidence, type RugHistoryEvidence } from './rug-history-provider.js';
import { replyInTelegramThread, type TelegramSendResult } from './telegram.js';
import { requestGrokAnalysis } from './xai-client.js';
import type { StoredAnalysis } from './analysis-tracker.js';

export interface TriggerAnalysisOptions {
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  xaiModel: string;
  proxyUrl?: string;
  discussionChatId?: string;
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
  twitterToken?: string;
  twitterApiBaseUrl?: string;
  getRugHistory?: (options: {
    link: string;
    twitterToken?: string;
    twitterApiBaseUrl: string;
    proxyUrl?: string;
  }) => Promise<RugHistoryEvidence>;
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

function removeAnalysisSourceBlock(text: string): string {
  const lines = text.trim().split('\n');
  const sourceStart = lines.findIndex((line) =>
    /^(?:#{1,6}\s*)?(?:source|sources|来源|参考来源|数据来源|引用列表)\s*[:：]?/i.test(line.trim())
  );
  return (sourceStart >= 0 ? lines.slice(0, sourceStart) : lines)
    .map((line) => line.replace(/\s*\[\[\d+\]\]\([^)]+\)/g, ''))
    .join('\n')
    .trim();
}

export async function triggerAnalysisComment(options: TriggerAnalysisOptions): Promise<TelegramSendResult | void> {
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
    await reply({
      botToken: options.botToken,
      chatId: options.existingAnalysis.discussionChatId,
      replyToMessageId: options.existingAnalysis.analysisMessageId,
      text: `重复命中提醒\n\n${options.title}\n监控池关注数：${options.count}\n当前重要程度：${options.star} 星`,
      proxyUrl: options.proxyUrl
    });
    info(`已回复既有分析评论：${options.projectKey}`);
    return;
  }

  const mapping = await options.discussionStore.waitFor(options.channelChatId, options.channelMessageId, 30_000);
  if (!mapping) {
    warn(`未找到讨论群映射：${options.channelChatId}/${options.channelMessageId}`);
    return;
  }

  const rugHistory = await (options.getRugHistory ?? collectRugHistoryEvidence)({
    link: options.link,
    twitterToken: options.twitterToken,
    twitterApiBaseUrl: options.twitterApiBaseUrl ?? 'https://ai.6551.io',
    proxyUrl: options.proxyUrl
  });
  const analysisSkill = await (options.loadSkill ?? loadAnalysisSkill)();

  const prompt = buildGrokPrompt({
    title: options.title,
    content: options.content,
    link: options.link,
    count: options.count,
    star: options.star,
    rugHistory,
    analysisSkill
  });
  const analysis = options.analyze
    ? await options.analyze(prompt)
    : await requestGrokAnalysis({
        apiKey: options.xaiApiKey,
        baseUrl: options.xaiBaseUrl,
        model: options.xaiModel,
        proxyUrl: options.proxyUrl,
        prompt
      });
  const cleanedAnalysis = removeAnalysisSourceBlock(analysis);

  const replyResult = await reply({
    botToken: options.botToken,
    chatId: options.discussionChatId,
    replyToMessageId: mapping.discussionMessageId,
    text: `Grok 分析\n\n${cleanedAnalysis}`,
    proxyUrl: options.proxyUrl
  });

  info(`已写入讨论群评论：${mapping.discussionChatId}/${mapping.discussionMessageId}`);
  return replyResult;
}
