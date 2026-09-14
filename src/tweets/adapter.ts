/**
 * 推文数据源适配器契约（Q108 未选型、Q111-Q113、Q129）。
 *
 * 规划只固定契约，不绑定供应商：选型由部署者自行完成，切换供应商不改上层。
 * 本文件是纯接口与纯函数，不发起网络请求——具体供应商实现放在 adapters/ 下。
 *
 * 要求（主规划 6.2 节）：
 * - 输入：账号 handle 列表（核心池）与增量起点；
 * - 输出：结构化推文（ID、作者、正文、时间、互动数）；
 * - 支持按 handle 检索提及、支持增量、单次结果条数可枚举；
 * - 成本控制：翻页与重复返回会放大按条计费的成本，必须用增量时间戳 + 本地推文 ID 去重。
 */

/** 适配器检索到的单条推文（供应商无关）。 */
export interface FetchedTweet {
  /** 供应商返回的推文 ID；本地去重与稳定 ID 的基础。 */
  tweetId: string;
  authorHandle: string | null;
  authorName: string | null;
  authorVerified: boolean | null;
  authorFollowers: number | null;
  body: string;
  /** 发布时间（ISO）；供应商不提供时为 null，不得用抓取时间冒充。 */
  postedAt: string | null;
  likeCount: number | null;
  retweetCount: number | null;
  replyCount: number | null;
  viewCount: number | null;
  /** 推文链接；供应商不返回时由 handle + tweetId 拼接。 */
  url: string | null;
  /** 该推文提及的监控池账号（归一化后的 handle）。 */
  mentions: string[];
  /** 供应商原始响应，便于排查与字段回溯；不得包含凭证。 */
  rawPayload?: string | null;
}

export interface FetchMentionsInput {
  /** 需要检索提及的账号（核心池）。 */
  handles: readonly string[];
  /** 增量起点：上次成功检索时间；null 表示首次检索。 */
  since: Date | null;
  /** 单次最多返回多少条；适配器可以更少，但不应超过。 */
  limit: number;
}

export interface FetchMentionsResult {
  tweets: FetchedTweet[];
  /** 本次检索成功时间；调用方据此推进游标。 */
  fetchedAt: Date;
  /** 供应商报告的用量（成功条数）；用于事后核对账单（Q118 未做运行门控）。 */
  billableItems?: number | null;
}

export interface TweetSourceAdapter {
  /** 供应商标识，用于页面显示“数据来自谁”。 */
  readonly name: string;
  /** 是否已配置可用（密钥缺失时应为 false，而不是抛错）。 */
  isConfigured(): boolean;
  /** 按账号检索提及。未配置时应抛出明确错误，而不是返回空数组冒充“没有提及”。 */
  fetchMentions(input: FetchMentionsInput): Promise<FetchMentionsResult>;
}

/** 未配置数据源时的占位适配器：明确失败，不伪装成“没有提及”（Q113、Q129）。 */
export class UnconfiguredTweetSource implements TweetSourceAdapter {
  readonly name = 'unconfigured';

  isConfigured(): boolean {
    return false;
  }

  async fetchMentions(): Promise<FetchMentionsResult> {
    throw new Error('推文数据源未配置：请先配置第三方聚合服务（详见文档 6.2 节）');
  }
}

/** 由 handle 与推文 ID 拼接链接；供应商不返回链接时使用（与 6551 的缺口一致）。 */
export function buildTweetUrl(authorHandle: string | null, tweetId: string): string | null {
  const handle = authorHandle?.trim().replace(/^@/, '');
  if (!handle) return null;
  return `https://x.com/${handle}/status/${tweetId}`;
}

/**
 * 本地二次校验（Q111）：关键词检索可能带回并不真的提及该账号的推文。
 *
 * 判定依据：正文里出现 @handle、或 mentions 列表里包含该 handle。
 * 只做小写比较，避免大小写差异造成漏判。
 */
export function tweetMentionsHandle(tweet: FetchedTweet, handle: string): boolean {
  const target = handle.trim().replace(/^@/, '').toLowerCase();
  if (target.length === 0) return false;
  if (tweet.mentions.some((mention) => mention.trim().replace(/^@/, '').toLowerCase() === target)) return true;
  // 退一步用正文匹配：允许 @handle 后跟非字母数字边界。
  const pattern = new RegExp(`@${escapeRegExp(target)}(?![0-9A-Za-z_])`, 'i');
  return pattern.test(tweet.body);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 抽取供应商返回的字段；字段名不同（camelCase/snake_case）时都能识别。
 * 缺失字段保持 null，不猜值。
 */
export function normalizeFetchedTweet(raw: Record<string, unknown>): FetchedTweet | null {
  const tweetId =
    text(raw.tweetId) ?? text(raw.tweet_id) ?? text(raw.id) ?? text(raw.id_str) ?? text(raw.rest_id) ?? null;
  const body = text(raw.body) ?? text(raw.text) ?? text(raw.full_text) ?? text(raw.content) ?? null;
  if (!tweetId || body === null) return null;

  const author = (raw.author ?? raw.user ?? {}) as Record<string, unknown>;
  const authorHandle =
    text(raw.authorHandle) ?? text(raw.author_handle) ?? text(author.handle) ?? text(author.screenName) ?? text(author.screen_name) ?? null;

  const postedAtRaw =
    text(raw.postedAt) ?? text(raw.posted_at) ?? text(raw.createdAt) ?? text(raw.created_at) ?? null;
  const postedAt = postedAtRaw ? normalizeIso(postedAtRaw) : null;

  const mentionsRaw = raw.mentions ?? raw.entities ?? null;
  const mentions = extractMentions(mentionsRaw);

  return {
    tweetId,
    authorHandle,
    authorName: text(raw.authorName) ?? text(raw.author_name) ?? text(author.name) ?? null,
    authorVerified:
      typeof raw.authorVerified === 'boolean'
        ? raw.authorVerified
        : typeof author.verified === 'boolean'
          ? (author.verified as boolean)
          : null,
    authorFollowers:
      number(raw.authorFollowers) ?? number(raw.author_followers) ?? number(author.followers) ?? number(author.followersCount) ?? null,
    body,
    postedAt,
    likeCount: number(raw.likeCount) ?? number(raw.like_count) ?? number(raw.favoriteCount) ?? number(raw.favorite_count) ?? null,
    retweetCount: number(raw.retweetCount) ?? number(raw.retweet_count) ?? null,
    replyCount: number(raw.replyCount) ?? number(raw.reply_count) ?? null,
    viewCount: number(raw.viewCount) ?? number(raw.view_count) ?? null,
    url: text(raw.url) ?? text(raw.tweetUrl) ?? text(raw.tweet_url) ?? buildTweetUrl(authorHandle, tweetId),
    mentions,
    rawPayload: text(raw.rawPayload) ?? null,
  };
}

function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function normalizeIso(value: string): string | null {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  // Unix 秒/毫秒
  if (/^\d+$/.test(value)) {
    const numeric = Number.parseInt(value, 10);
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const fromEpoch = new Date(ms);
    if (!Number.isNaN(fromEpoch.getTime())) return fromEpoch.toISOString();
  }
  return null;
}

/** mentions 可能是 ["a","b"] 或 [{username:"a"}] 或 {user_mentions:[...]}。 */
function extractMentions(value: unknown): string[] {
  if (!value) return [];
  const list = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { user_mentions?: unknown }).user_mentions)
      ? ((value as { user_mentions: unknown[] }).user_mentions)
      : [];
  const handles: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const handle = item.trim().replace(/^@/, '').toLowerCase();
      if (handle) handles.push(handle);
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const handle = text(record.username) ?? text(record.screen_name) ?? text(record.handle) ?? text(record.screenName);
      if (handle) handles.push(handle.replace(/^@/, '').toLowerCase());
    }
  }
  return [...new Set(handles)];
}

/** 去重键：推文 ID 是唯一稳定标识（Q112）。 */
export function tweetDedupeKey(tweet: FetchedTweet): string {
  return tweet.tweetId;
}

/**
 * 增量过滤：只保留发布时间晚于游标的推文；发布时间缺失时保守保留（宁可重复入库，由 ID 去重）。
 */
export function filterIncremental(tweets: readonly FetchedTweet[], since: Date | null): FetchedTweet[] {
  if (!since) return [...tweets];
  const threshold = since.getTime();
  return tweets.filter((tweet) => {
    if (!tweet.postedAt) return true;
    const posted = new Date(tweet.postedAt).getTime();
    if (Number.isNaN(posted)) return true;
    return posted > threshold;
  });
}
