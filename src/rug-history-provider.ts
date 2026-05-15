import { createTwitter6551Client, type Twitter6551Client } from './twitter-6551-client.js';

export interface RugHistoryEvidence {
  source: '6551';
  available: boolean;
  deletedTweetCount: number | null;
  negativeMentionCount: number | null;
  recentTweetCount: number | null;
  commentNegativeCount: number | null;
  checkedTweetCount: number | null;
  negativeNoiseCount: number | null;
  deletedTweetSamples: string[];
  negativeMentionSamples: string[];
  commentNegativeSamples: string[];
  negativeNoiseSamples: string[];
  recentRiskSignals: string[];
  warnings: string[];
}

export interface CollectRugHistoryEvidenceOptions {
  link: string;
  twitterToken?: string;
  twitterApiBaseUrl: string;
  proxyUrl?: string;
  client?: Twitter6551Client;
}

type MutableEvidence = RugHistoryEvidence;
const NEGATIVE_PATTERN = /rug|scam|drain|phishing|hacked|fraud|跑路|割|骗局|诈骗|钓鱼|黑客|归零|无法提现|退款/i;

export function extractUsernameFromXLink(link: string): string | null {
  const matched = link.match(/^https?:\/\/(?:x|twitter)\.com\/([^/?#]+)/i);
  return matched?.[1] ?? null;
}

function emptyEvidence(warnings: string[] = []): RugHistoryEvidence {
  return {
    source: '6551',
    available: false,
    deletedTweetCount: null,
    negativeMentionCount: null,
    recentTweetCount: null,
    commentNegativeCount: null,
    checkedTweetCount: null,
    negativeNoiseCount: null,
    deletedTweetSamples: [],
    negativeMentionSamples: [],
    commentNegativeSamples: [],
    negativeNoiseSamples: [],
    recentRiskSignals: [],
    warnings
  };
}

function responseItems(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  const record = response as Record<string, unknown>;
  for (const key of ['data', 'result', 'tweets']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items)) {
      return (value as Record<string, unknown>).items as unknown[];
    }
  }
  return [];
}

function itemText(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  for (const key of ['text', 'fullText', 'content']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function itemId(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  for (const key of ['id', 'idStr', 'twId', 'tweetId', 'rest_id']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function sampleTexts(items: unknown[], limit = 3): string[] {
  return items.map(itemText).filter((value): value is string => Boolean(value)).slice(0, limit);
}

function negativeTexts(items: unknown[], limit = 20): string[] {
  return sampleTexts(items, limit).filter((text) => NEGATIVE_PATTERN.test(text));
}

async function collectEndpoint(
  evidence: MutableEvidence,
  endpoint: string,
  task: () => Promise<void>
): Promise<void> {
  try {
    await task();
  } catch (error) {
    evidence.warnings.push(`${endpoint} 查询失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function collectRugHistoryEvidence(
  options: CollectRugHistoryEvidenceOptions
): Promise<RugHistoryEvidence> {
  if (!options.twitterToken) {
    return emptyEvidence(['未配置 TWITTER_TOKEN，跳过 6551 Rug 历史查询']);
  }

  const username = extractUsernameFromXLink(options.link);
  if (!username) {
    return emptyEvidence(['无法从 X 链接提取 username，跳过 6551 Rug 历史查询']);
  }

  const client = options.client ?? createTwitter6551Client({
    token: options.twitterToken,
    baseUrl: options.twitterApiBaseUrl,
    proxyUrl: options.proxyUrl
  });
  const evidence: RugHistoryEvidence = {
    source: '6551',
    available: true,
    deletedTweetCount: null,
    negativeMentionCount: null,
    recentTweetCount: null,
    commentNegativeCount: null,
    checkedTweetCount: null,
    negativeNoiseCount: null,
    deletedTweetSamples: [],
    negativeMentionSamples: [],
    commentNegativeSamples: [],
    negativeNoiseSamples: [],
    recentRiskSignals: [],
    warnings: []
  };
  let recentTweetItems: unknown[] = [];

  await collectEndpoint(evidence, 'twitter_user_info', async () => {
    await client.postOpen('twitter_user_info', { username });
  });

  await collectEndpoint(evidence, 'twitter_deleted_tweets', async () => {
    const items = responseItems(await client.postOpen('twitter_deleted_tweets', { username, maxResults: 20 }));
    evidence.deletedTweetCount = items.length;
    evidence.deletedTweetSamples = sampleTexts(items);
  });

  await collectEndpoint(evidence, 'twitter_user_tweets', async () => {
    const items = responseItems(await client.postOpen('twitter_user_tweets', {
      username,
      maxResults: 30,
      product: 'Latest',
      includeReplies: true,
      includeRetweets: false
    }));
    recentTweetItems = items;
    evidence.recentTweetCount = items.length;
    evidence.recentRiskSignals = sampleTexts(items).filter((text) =>
      /mint|airdrop|claim|refund|hack|rug|scam|跑路|割|骗局|退款|钓鱼/i.test(text)
    );
  });

  const tweetIds = [...new Set(recentTweetItems.map(itemId).filter((id): id is string => Boolean(id)))].slice(0, 3);
  evidence.checkedTweetCount = tweetIds.length;
  if (tweetIds.length === 0) {
    evidence.warnings.push('近期推文缺少可查询 tweet id，跳过 quote 评论区查询');
  }

  const quoteNegativeTexts = new Set<string>();
  const replyNegativeTexts = new Set<string>();
  for (const id of tweetIds) {
    await collectEndpoint(evidence, 'twitter_quote_tweets_by_id', async () => {
      const items = responseItems(await client.postOpen('twitter_quote_tweets_by_id', { id, maxResults: 20 }));
      for (const text of negativeTexts(items)) {
        quoteNegativeTexts.add(text);
      }
    });
  }

  const searchBodies = [
    {
      keywords: `@${username} rug OR scam OR drain OR phishing OR hacked OR fraud`,
      maxResults: 20,
      product: 'Latest'
    },
    {
      keywords: `@${username} 跑路 OR 割 OR 骗局 OR 诈骗 OR 钓鱼 OR 黑客 OR 归零`,
      maxResults: 20,
      product: 'Latest'
    },
    {
      mentionUser: username,
      maxResults: 20,
      product: 'Latest'
    }
  ];

  const negativeMentionTexts = new Set<string>();
  const negativeNoiseTexts = new Set<string>();
  for (const body of searchBodies) {
    await collectEndpoint(evidence, 'twitter_search', async () => {
      const items = responseItems(await client.postOpen('twitter_search', body));
      for (const text of sampleTexts(items, 20)) {
        if (!NEGATIVE_PATTERN.test(text)) {
          continue;
        }
        if (!text.toLowerCase().includes(`@${username.toLowerCase()}`)) {
          negativeNoiseTexts.add(text);
          continue;
        }
        negativeMentionTexts.add(text);
      }
    });
  }
  evidence.negativeMentionCount = negativeMentionTexts.size;
  evidence.negativeMentionSamples = [...negativeMentionTexts].slice(0, 3);
  evidence.negativeNoiseCount = negativeNoiseTexts.size;
  evidence.negativeNoiseSamples = [...negativeNoiseTexts].slice(0, 3);

  const replySearchBodies = [
    {
      toUser: username,
      keywords: 'rug OR scam OR drain OR phishing OR hacked OR fraud',
      maxResults: 20,
      product: 'Latest'
    },
    {
      toUser: username,
      keywords: '跑路 OR 割 OR 骗局 OR 诈骗 OR 钓鱼 OR 黑客 OR 归零 OR 无法提现',
      maxResults: 20,
      product: 'Latest'
    }
  ];

  for (const body of replySearchBodies) {
    await collectEndpoint(evidence, 'twitter_search_to_user', async () => {
      const items = responseItems(await client.postOpen('twitter_search', body));
      for (const text of negativeTexts(items)) {
        replyNegativeTexts.add(text);
      }
    });
  }
  const commentNegativeTexts = new Set([...quoteNegativeTexts, ...replyNegativeTexts]);
  evidence.commentNegativeCount = commentNegativeTexts.size;
  evidence.commentNegativeSamples = [
    ...[...quoteNegativeTexts].slice(0, 2),
    ...[...replyNegativeTexts].slice(0, 1)
  ];

  return evidence;
}
