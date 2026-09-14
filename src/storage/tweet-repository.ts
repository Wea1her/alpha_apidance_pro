import type { StoragePool, Queryable } from './client.js';
import type { FetchedTweet } from '../tweets/adapter.js';

/**
 * 推文仓储：入库去重、与监控池账号关联、检索游标与摘要状态（Q111-Q121）。
 *
 * 依据：
 * - Q112：抓到的推文入库去重（推文 ID + 关联项目 + 首次/末次抓到时间），页面读库；
 * - Q113：没有提及就不显示；检索失败与配额耗尽必须能与“没有提及”区分；
 * - Q115：核心池 = 星级 ≥3 或从排除池恢复的项目；
 * - Q116：每个账号维度记录最后成功检索时间与最近错误；
 * - Q117：中文摘要失败时保留原文，页面显示“摘要不可用”，不丢内容；
 * - Q120：喊单与项目双向可达（本表提供关联，详情页据此反向查询）。
 */

export const CORE_POOL_MIN_STAR = 3;
export const TWEET_SUMMARY_MAX_ATTEMPTS = 3;

export interface CorePoolMember {
  projectId: string;
  projectKey: string;
  star: number;
  source: string;
}

/**
 * 核心池：星级 ≥3 或“恢复入池”的项目（Q115）。
 * 只取监控中的项目：已排除的不再检索，避免为不监控的账号付费。
 */
export async function listCorePool(pool: StoragePool, limit = 500): Promise<CorePoolMember[]> {
  const result = await pool.query(
    `SELECT project_id, project_key, star, source
       FROM projects
      WHERE pool_state = 'monitored' AND (star >= $1 OR source = 'restored')
      ORDER BY star DESC, entered_pool_at DESC
      LIMIT $2`,
    [CORE_POOL_MIN_STAR, limit]
  );
  return result.rows.map((row) => ({
    projectId: String(row.project_id),
    projectKey: String(row.project_key),
    star: Number(row.star ?? 0),
    source: String(row.source),
  }));
}

export interface UpsertTweetResult {
  tweetId: string;
  created: boolean;
  /** 本次新建立的账号关联（用于判断“是否有新的喊单需要提示”）。 */
  newMentions: string[];
}

/**
 * 入库一条推文并登记它与监控池账号的关联。
 *
 * 幂等：推文 ID 已存在时只更新互动数与 last_seen_at，不覆盖首次见到时间与正文（正文可能被编辑/删除，
 * 但本地已有的原文是排查依据）。
 */
export async function upsertTweet(
  pool: StoragePool,
  input: { tweet: FetchedTweet; source: string; mentionedProjects: Array<{ projectId: string; projectKey: string }> }
): Promise<UpsertTweetResult> {
  const { tweet } = input;
  return pool.transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO tweets (tweet_id, author_handle, author_name, author_verified, author_followers, body, posted_at,
                           like_count, retweet_count, reply_count, view_count, url, source, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (tweet_id) DO NOTHING`,
      [
        tweet.tweetId,
        tweet.authorHandle,
        tweet.authorName,
        tweet.authorVerified,
        tweet.authorFollowers,
        tweet.body,
        tweet.postedAt,
        tweet.likeCount,
        tweet.retweetCount,
        tweet.replyCount,
        tweet.viewCount,
        tweet.url,
        input.source,
        tweet.rawPayload ?? null,
      ]
    );

    const created = (inserted.rowCount ?? 0) > 0;
    if (!created) {
      // 重复抓取：只刷新互动数与最后见到时间，不重复展示（Q112）。
      await client.query(
        `UPDATE tweets
            SET last_seen_at = now(),
                like_count = COALESCE($2, like_count),
                retweet_count = COALESCE($3, retweet_count),
                reply_count = COALESCE($4, reply_count),
                view_count = COALESCE($5, view_count),
                url = COALESCE(url, $6)
          WHERE tweet_id = $1`,
        [
          tweet.tweetId,
          tweet.likeCount,
          tweet.retweetCount,
          tweet.replyCount,
          tweet.viewCount,
          tweet.url,
        ]
      );
    }

    const newMentions: string[] = [];
    for (const project of input.mentionedProjects) {
      const mention = await client.query(
        `INSERT INTO tweet_mentions (tweet_id, project_id, project_key)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [tweet.tweetId, project.projectId, project.projectKey]
      );
      if ((mention.rowCount ?? 0) > 0) newMentions.push(project.projectKey);
    }

    return { tweetId: tweet.tweetId, created, newMentions };
  });
}

export interface TweetFeedRow {
  tweetId: string;
  authorHandle: string | null;
  authorName: string | null;
  authorVerified: boolean | null;
  authorFollowers: number | null;
  body: string;
  postedAt: string | null;
  likeCount: number | null;
  retweetCount: number | null;
  replyCount: number | null;
  viewCount: number | null;
  url: string | null;
  source: string;
  firstSeenAt: string;
  summaryStatus: 'pending' | 'done' | 'failed';
  summaryText: string | null;
  /** 关联到的监控池账号（Q120 双向可达）。 */
  mentionedProjects: Array<{ projectId: string; projectKey: string }>;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 喊单列表：按发布时间倒序（缺失时退到首次见到时间），支持按项目过滤。 */
export async function listTweetFeed(
  pool: StoragePool,
  input: { projectId?: string | null; limit?: number } = {}
): Promise<TweetFeedRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const result = await pool.query(
    `SELECT t.*,
            COALESCE(
              json_agg(json_build_object('projectId', m.project_id, 'projectKey', m.project_key))
                FILTER (WHERE m.project_id IS NOT NULL),
              '[]'::json
            ) AS mentions
       FROM tweets t
       LEFT JOIN tweet_mentions m ON m.tweet_id = t.tweet_id
      WHERE ($1::text IS NULL OR EXISTS (
              SELECT 1 FROM tweet_mentions x WHERE x.tweet_id = t.tweet_id AND x.project_id = $1
            ))
      GROUP BY t.tweet_id
      ORDER BY COALESCE(t.posted_at, t.first_seen_at) DESC, t.tweet_id DESC
      LIMIT $2`,
    [input.projectId ?? null, limit]
  );

  return result.rows.map((row) => ({
    tweetId: String(row.tweet_id),
    authorHandle: row.author_handle === null || row.author_handle === undefined ? null : String(row.author_handle),
    authorName: row.author_name === null || row.author_name === undefined ? null : String(row.author_name),
    authorVerified: typeof row.author_verified === 'boolean' ? row.author_verified : null,
    authorFollowers: toNumber(row.author_followers),
    body: String(row.body ?? ''),
    postedAt: toIso(row.posted_at),
    likeCount: toNumber(row.like_count),
    retweetCount: toNumber(row.retweet_count),
    replyCount: toNumber(row.reply_count),
    viewCount: toNumber(row.view_count),
    url: row.url === null || row.url === undefined ? null : String(row.url),
    source: String(row.source ?? ''),
    firstSeenAt: toIso(row.first_seen_at) ?? new Date(0).toISOString(),
    summaryStatus: String(row.summary_status) as TweetFeedRow['summaryStatus'],
    summaryText: row.summary_text === null || row.summary_text === undefined ? null : String(row.summary_text),
    mentionedProjects: Array.isArray(row.mentions)
      ? (row.mentions as Array<{ projectId: string; projectKey: string }>)
      : [],
  }));
}

export interface TweetPollStateRow {
  projectId: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
}

/** 读取检索游标（Q116、Q121）：每个核心池账号的最后成功时间与最近错误。 */
export async function listTweetPollStates(pool: StoragePool): Promise<TweetPollStateRow[]> {
  const result = await pool.query(
    `SELECT s.*, p.project_key FROM tweet_poll_state s
       JOIN projects p ON p.project_id = s.project_id
      ORDER BY s.last_success_at ASC NULLS FIRST`
  );
  return result.rows.map((row) => ({
    projectId: String(row.project_id),
    lastSuccessAt: toIso(row.last_success_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    lastErrorAt: toIso(row.last_error_at),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
  }));
}

/** 检索成功后推进游标。 */
export async function markTweetPollSuccess(
  client: Queryable,
  input: { projectId: string; at: Date }
): Promise<void> {
  await client.query(
    `INSERT INTO tweet_poll_state (project_id, last_success_at, last_error, last_error_at, consecutive_failures)
     VALUES ($1, $2::timestamptz, NULL, NULL, 0)
     ON CONFLICT (project_id) DO UPDATE
       SET last_success_at = $2::timestamptz, last_error = NULL, last_error_at = NULL, consecutive_failures = 0`,
    [input.projectId, input.at.toISOString()]
  );
}

/** 检索失败：记录错误与连续失败次数；不推进游标（下次仍从上次成功处继续）。 */
export async function markTweetPollFailure(
  client: Queryable,
  input: { projectId: string; error: string; at: Date }
): Promise<void> {
  await client.query(
    `INSERT INTO tweet_poll_state (project_id, last_error, last_error_at, consecutive_failures)
     VALUES ($1, $2, $3::timestamptz, 1)
     ON CONFLICT (project_id) DO UPDATE
       SET last_error = $2, last_error_at = $3::timestamptz,
           consecutive_failures = tweet_poll_state.consecutive_failures + 1`,
    [input.projectId, input.error, input.at.toISOString()]
  );
}

/** 最早的成功检索时间：页面据此显示“最后检索时间”与数据新鲜度（Q116）。 */
export async function readTweetFeedFreshness(
  pool: StoragePool
): Promise<{ lastSuccessAt: string | null; failingProjects: number; pendingSummaries: number }> {
  const result = await pool.query(
    `SELECT
       (SELECT min(last_success_at) FROM tweet_poll_state) AS oldest_success,
       (SELECT count(*)::int FROM tweet_poll_state WHERE consecutive_failures > 0) AS failing,
       (SELECT count(*)::int FROM tweets WHERE summary_status = 'pending') AS pending_summaries`
  );
  const row = result.rows[0] ?? {};
  return {
    lastSuccessAt: toIso(row.oldest_success),
    failingProjects: Number(row.failing ?? 0),
    pendingSummaries: Number(row.pending_summaries ?? 0),
  };
}

/** 取待摘要的推文：摘要调用必须幂等且可重试（Q117）。 */
export async function listTweetsNeedingSummary(
  pool: StoragePool,
  limit = 10
): Promise<Array<{ tweetId: string; body: string; attempts: number }>> {
  const result = await pool.query(
    `SELECT tweet_id, body, summary_attempts FROM tweets
      WHERE summary_status = 'pending' AND summary_attempts < $1
      ORDER BY first_seen_at ASC LIMIT $2`,
    [TWEET_SUMMARY_MAX_ATTEMPTS, limit]
  );
  return result.rows.map((row) => ({
    tweetId: String(row.tweet_id),
    body: String(row.body ?? ''),
    attempts: Number(row.summary_attempts ?? 0),
  }));
}

/** 摘要完成。 */
export async function markTweetSummaryDone(
  pool: StoragePool,
  input: { tweetId: string; summary: string; model: string | null }
): Promise<void> {
  await pool.query(
    `UPDATE tweets
        SET summary_status = 'done', summary_text = $2, summary_model = $3,
            summary_updated_at = now(), summary_attempts = summary_attempts + 1
      WHERE tweet_id = $1`,
    [input.tweetId, input.summary, input.model]
  );
}

/**
 * 摘要失败：累计次数；达到上限后置为 failed（页面显示“摘要不可用”），期间仍展示原文。
 */
export async function markTweetSummaryFailed(
  pool: StoragePool,
  input: { tweetId: string; error: string; maxAttempts?: number }
): Promise<{ status: 'pending' | 'failed'; attempts: number }> {
  const maxAttempts = input.maxAttempts ?? TWEET_SUMMARY_MAX_ATTEMPTS;
  const result = await pool.query(
    `UPDATE tweets
        SET summary_attempts = summary_attempts + 1,
            summary_status = CASE WHEN summary_attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END
      WHERE tweet_id = $1
      RETURNING summary_status, summary_attempts`,
    [input.tweetId, maxAttempts]
  );
  const row = result.rows[0];
  return {
    status: (row?.summary_status as 'pending' | 'failed') ?? 'failed',
    attempts: Number(row?.summary_attempts ?? 0),
  };
}
