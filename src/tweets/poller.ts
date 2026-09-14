import type { StoragePool } from '../storage/client.js';
import {
  listCorePool,
  listTweetPollStates,
  markTweetPollFailure,
  markTweetPollSuccess,
  upsertTweet,
} from '../storage/tweet-repository.js';
import { tweetMentionsHandle, type FetchedTweet, type FetchMentionsResult, type TweetSourceAdapter } from './adapter.js';

/**
 * 喊单检索编排（Q110-Q118）。
 *
 * 职责：读核心池 → 按增量起点调用适配器 → 本地二次校验 → 入库 → 推进/保留游标。
 *
 * 关键纪律：
 * - **未配置数据源时明确失败**，绝不返回"0 条"冒充"没有提及"（Q113、Q129）；
 * - 检索失败**不推进游标**，下次仍从上次成功处重来，避免漏抓（成本换完整性）；
 * - 本地用 `tweetMentionsHandle` 二次校验（Q111）：关键词检索会带回并不真的提及该账号的推文；
 * - 每条推文只入库一次，重复抓取只刷新互动数（Q112）。
 */

/** 已声明供应商但本仓库尚未实现时的适配器：同样视为未配置，并如实说明原因。 */
class MissingTweetSource implements TweetSourceAdapter {
  readonly name: string;
  private readonly reason: string;

  constructor(name: string, reason: string) {
    this.name = name;
    this.reason = reason;
  }

  isConfigured(): boolean {
    return false;
  }

  async fetchMentions(): Promise<FetchMentionsResult> {
    throw new Error(this.reason);
  }
}

/**
 * 从环境变量解析推文数据源（Q108：选型由部署者完成，本仓库只固定契约）。
 *
 * 返回未配置适配器时，页面的正确表现是"未配置数据源"而不是"没有提及"。
 */
export function resolveTweetSource(env: NodeJS.ProcessEnv = process.env): TweetSourceAdapter {
  const vendor = env.TWEET_SOURCE?.trim();
  if (!vendor) {
    return new MissingTweetSource('unconfigured', '未配置 TWEET_SOURCE：请在部署环境选择推文数据源（Q108）');
  }
  return new MissingTweetSource(
    vendor,
    `推文数据源 "${vendor}" 尚未在本仓库实现适配器：请实现 src/tweets/adapters/ 下的适配器并注册`
  );
}

export interface TweetPollOptions {
  /** 单次检索向适配器请求的账号数量（成本控制）。 */
  handlesPerRequest?: number;
  /** 单次轮询最多覆盖多少核心池账号。 */
  maxHandles?: number;
  /** 每个账号单次最多取多少条。 */
  limitPerRequest?: number;
  /** 只轮询这些项目（"立即查一次"聚焦单个项目时使用）。 */
  projectIds?: readonly string[];
  now?: Date;
}

export interface TweetPollResult {
  source: string;
  /** 本次覆盖的核心池账号数。 */
  handles: number;
  /** 适配器返回的候选条数。 */
  fetched: number;
  /** 实际新入库条数（重复抓取不计）。 */
  created: number;
  /** 本地二次校验过滤掉的不相关推文数（Q111）。 */
  filteredOut: number;
  /** 本次新增的"推文—项目"关联（页面据此高亮新喊单）。 */
  newMentions: string[];
  failures: Array<{ handles: string[]; error: string }>;
  skipped: boolean;
  reason: string | null;
  polledAt: string;
}

/**
 * 执行一轮检索并入库。
 *
 * 分批调用适配器：按 `handlesPerRequest` 切块，块内共享一次调用与一个增量起点
 * （取块内**最早**的上次成功时间，保证落后最久的账号也不漏抓）。
 */
export async function pollTweetMentions(
  pool: StoragePool,
  adapter: TweetSourceAdapter,
  options: TweetPollOptions = {}
): Promise<TweetPollResult> {
  const now = options.now ?? new Date();
  const handlesPerRequest = Math.max(1, options.handlesPerRequest ?? 20);
  const maxHandles = Math.max(1, options.maxHandles ?? 500);
  const limitPerRequest = Math.max(1, options.limitPerRequest ?? 100);

  if (!adapter.isConfigured()) {
    return {
      source: adapter.name,
      handles: 0,
      fetched: 0,
      created: 0,
      filteredOut: 0,
      newMentions: [],
      failures: [],
      skipped: true,
      reason: '推文数据源未配置：不返回"没有提及"，请先配置数据源（Q113、Q129）',
      polledAt: now.toISOString(),
    };
  }

  let members = await listCorePool(pool, maxHandles);
  if (options.projectIds && options.projectIds.length > 0) {
    const wanted = new Set(options.projectIds);
    members = members.filter((member) => wanted.has(member.projectId));
  }

  const states = new Map((await listTweetPollStates(pool)).map((state) => [state.projectId, state]));
  const result: TweetPollResult = {
    source: adapter.name,
    handles: members.length,
    fetched: 0,
    created: 0,
    filteredOut: 0,
    newMentions: [],
    failures: [],
    skipped: false,
    reason: null,
    polledAt: now.toISOString(),
  };
  if (members.length === 0) return result;

  for (let offset = 0; offset < members.length; offset += handlesPerRequest) {
    const chunk = members.slice(offset, offset + handlesPerRequest);
    const handleSet = new Set(chunk.map((member) => member.projectKey.toLowerCase()));

    // 增量起点取块内最早的一次成功；有任一账号从未成功过则整块从 null（首次）开始。
    let since: Date | null = null;
    let anyNeverPolled = false;
    for (const member of chunk) {
      const state = states.get(member.projectId);
      if (!state?.lastSuccessAt) {
        anyNeverPolled = true;
        break;
      }
      const at = new Date(state.lastSuccessAt);
      if (since === null || at.getTime() < since.getTime()) since = at;
    }
    if (anyNeverPolled) since = null;

    try {
      const fetched = await adapter.fetchMentions({
        handles: chunk.map((member) => member.projectKey),
        since,
        limit: limitPerRequest,
      });
      result.fetched += fetched.tweets.length;

      for (const tweet of fetched.tweets) {
        // 本地二次校验：只保留真的提及了本块账号的推文（Q111）。
        const matched = chunk.filter((member) => tweetMentionsHandle(tweet, member.projectKey));
        if (matched.length === 0) {
          result.filteredOut += 1;
          continue;
        }
        const upserted = await upsertTweet(pool, {
          tweet,
          source: adapter.name,
          mentionedProjects: matched.map((member) => ({ projectId: member.projectId, projectKey: member.projectKey })),
        });
        if (upserted.created) result.created += 1;
        result.newMentions.push(...upserted.newMentions);
      }

      // 只有整块成功才推进游标（失败的账号下次从上次成功处重来）。
      for (const member of chunk) {
        await markTweetPollSuccess(pool, { projectId: member.projectId, at: fetched.fetchedAt });
      }
      void handleSet;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({ handles: chunk.map((member) => member.projectKey), error: message });
      for (const member of chunk) {
        await markTweetPollFailure(pool, { projectId: member.projectId, error: message, at: now });
      }
    }
  }

  return result;
}

/** 判断一条适配器返回的推文是否属于某个 handle（供测试与页面复用）。 */
export function tweetBelongsToHandle(tweet: FetchedTweet, handle: string): boolean {
  return tweetMentionsHandle(tweet, handle);
}
