import { createTwitter6551Client, type Twitter6551Client } from './twitter-6551-client.js';

export interface RugHistoryEvidence {
  source: '6551';
  available: boolean;
  deletedTweetCount: number | null;
  negativeMentionCount: number | null;
  recentTweetCount: number | null;
  deletedTweetSamples: string[];
  negativeMentionSamples: string[];
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
    deletedTweetSamples: [],
    negativeMentionSamples: [],
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

function sampleTexts(items: unknown[], limit = 3): string[] {
  return items.map(itemText).filter((value): value is string => Boolean(value)).slice(0, limit);
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
    deletedTweetSamples: [],
    negativeMentionSamples: [],
    recentRiskSignals: [],
    warnings: []
  };

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
    evidence.recentTweetCount = items.length;
    evidence.recentRiskSignals = sampleTexts(items).filter((text) =>
      /mint|airdrop|claim|refund|hack|rug|scam|跑路|割|骗局|退款|钓鱼/i.test(text)
    );
  });

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
  for (const body of searchBodies) {
    await collectEndpoint(evidence, 'twitter_search', async () => {
      const items = responseItems(await client.postOpen('twitter_search', body));
      for (const text of sampleTexts(items, 20)) {
        negativeMentionTexts.add(text);
      }
    });
  }
  evidence.negativeMentionCount = negativeMentionTexts.size;
  evidence.negativeMentionSamples = [...negativeMentionTexts].slice(0, 3);

  return evidence;
}
