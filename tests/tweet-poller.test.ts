import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import { pollTweetMentions, resolveTweetSource } from '../src/tweets/poller.js';
import type { FetchedTweet, FetchMentionsInput, FetchMentionsResult, TweetSourceAdapter } from '../src/tweets/adapter.js';

/**
 * 喊单检索编排（Q110-Q118）集成测试：需要真实 PostgreSQL；不可用时跳过。
 *
 * 重点：
 * - 未配置数据源必须明确失败，绝不返回“0 条”冒充“没有提及”（Q113、Q129）；
 * - 本地二次校验要能过滤关键词检索的误召回（Q111）；
 * - 检索失败**不推进游标**，下次从上次成功处重来；
 * - 同一条推文重复抓取不重复入库（Q112）。
 */

let pool: StoragePool | null = null;
let available = false;

function itDb(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available) return;
    await fn();
  });
}

beforeAll(async () => {
  pool = await openTestDatabase();
  available = pool !== null;
  if (available) await resetSchemaAndMigrate(pool!);
});

beforeEach(async () => {
  if (!available) return;
  await pool!.query('TRUNCATE tweets, tweet_mentions, tweet_poll_state, projects RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  if (pool) await pool.close();
});

async function seedProject(projectId: string, projectKey: string, star = 5, poolState = 'monitored'): Promise<void> {
  // 已排除状态必须同时写排除时间与理由：表上有 exclusion_consistent 约束（排除态必须成对存在）。
  const excluded = poolState === 'excluded';
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, source, pool_state, star, excluded_at, exclusion_reason, excluded_star)
     VALUES ($1, $2, 'natural', $3, $4, CASE WHEN $5 THEN now() ELSE NULL END,
             CASE WHEN $5 THEN 'classification' ELSE NULL END, CASE WHEN $5 THEN 1 ELSE NULL END)`,
    [projectId, projectKey, poolState, star, excluded]
  );
}

function tweet(overrides: Partial<FetchedTweet> = {}): FetchedTweet {
  return {
    tweetId: '1001',
    authorHandle: 'someone',
    authorName: 'Someone',
    authorVerified: false,
    authorFollowers: 100,
    body: '看这个 @targetone 不错',
    postedAt: '2026-09-14T09:00:00.000Z',
    likeCount: 5,
    retweetCount: 1,
    replyCount: 0,
    viewCount: 50,
    url: null,
    mentions: ['targetone'],
    ...overrides
  };
}

class FakeTweetSource implements TweetSourceAdapter {
  readonly name = 'fake';
  readonly calls: FetchMentionsInput[] = [];

  constructor(
    private readonly behavior: { configured?: boolean; tweets?: FetchedTweet[]; error?: Error } = {}
  ) {}

  isConfigured(): boolean {
    return this.behavior.configured ?? true;
  }

  async fetchMentions(input: FetchMentionsInput): Promise<FetchMentionsResult> {
    this.calls.push(input);
    if (this.behavior.error) throw this.behavior.error;
    return {
      tweets: this.behavior.tweets ?? [],
      fetchedAt: new Date('2026-09-14T10:00:00.000Z'),
      billableItems: this.behavior.tweets?.length ?? 0
    };
  }
}

describe('数据源解析（Q108）', () => {
  it('未设置 TWEET_SOURCE 时返回未配置适配器，而不是空结果', () => {
    const adapter = resolveTweetSource({});
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.name).toBe('unconfigured');
  });

  it('声明了尚未实现的供应商时同样视为未配置，并说明原因', () => {
    const adapter = resolveTweetSource({ TWEET_SOURCE: 'somevendor' });
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.name).toBe('somevendor');
  });
});

describe('轮询编排', () => {
  itDb('未配置数据源时跳过并给出原因，不写库也不推进游标', async () => {
    await seedProject('p1', 'targetone');
    const adapter = new FakeTweetSource({ configured: false });
    const result = await pollTweetMentions(pool!, adapter);

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('未配置');
    expect(result.created).toBe(0);
    const tweets = await pool!.query('SELECT count(*)::int AS c FROM tweets');
    expect(tweets.rows[0]?.c).toBe(0);
    const state = await pool!.query('SELECT count(*)::int AS c FROM tweet_poll_state');
    expect(state.rows[0]?.c).toBe(0);
  });

  itDb('检索到提及核心池账号的推文时入库并建立关联、推进游标', async () => {
    await seedProject('p1', 'targetone');
    const adapter = new FakeTweetSource({ tweets: [tweet()] });
    const result = await pollTweetMentions(pool!, adapter);

    expect(result).toMatchObject({ handles: 1, fetched: 1, created: 1, skipped: false });
    expect(result.newMentions).toEqual(['targetone']);

    const stored = await pool!.query(
      `SELECT t.tweet_id, t.body, tm.project_key FROM tweets t JOIN tweet_mentions tm ON tm.tweet_id = t.tweet_id`
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ tweet_id: '1001', project_key: 'targetone' });

    const state = await pool!.query(`SELECT last_success_at, last_error FROM tweet_poll_state WHERE project_id = 'p1'`);
    expect(state.rows[0]?.last_success_at).not.toBeNull();
    expect(state.rows[0]?.last_error).toBeNull();
  });

  itDb('本地二次校验过滤关键词误召回（Q111）', async () => {
    await seedProject('p1', 'targetone');
    // 正文与 mentions 都没有提到 targetone：属于关键词检索的误召回
    const adapter = new FakeTweetSource({
      tweets: [tweet({ tweetId: '2001', body: '完全无关的内容', mentions: ['someoneelse'] })]
    });
    const result = await pollTweetMentions(pool!, adapter);

    expect(result.fetched).toBe(1);
    expect(result.created).toBe(0);
    expect(result.filteredOut).toBe(1);
    const tweets = await pool!.query('SELECT count(*)::int AS c FROM tweets');
    expect(tweets.rows[0]?.c).toBe(0);
  });

  itDb('检索失败记录错误与连续失败次数，且不推进游标', async () => {
    await seedProject('p1', 'targetone');
    const adapter = new FakeTweetSource({ error: new Error('vendor 503') });
    const result = await pollTweetMentions(pool!, adapter);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain('503');
    const state = await pool!.query(
      `SELECT last_success_at, last_error, consecutive_failures FROM tweet_poll_state WHERE project_id = 'p1'`
    );
    expect(state.rows[0]?.last_success_at).toBeNull();
    expect(state.rows[0]?.last_error).toContain('503');
    expect(Number(state.rows[0]?.consecutive_failures)).toBe(1);
  });

  itDb('同一条推文重复抓取不重复入库，只刷新互动数（Q112）', async () => {
    await seedProject('p1', 'targetone');
    const first = await pollTweetMentions(pool!, new FakeTweetSource({ tweets: [tweet()] }));
    const second = await pollTweetMentions(
      pool!,
      new FakeTweetSource({ tweets: [tweet({ likeCount: 99, body: '正文被改了' })] })
    );

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.newMentions).toEqual([]);
    const stored = await pool!.query(`SELECT body, like_count FROM tweets WHERE tweet_id = '1001'`);
    expect(stored.rows).toHaveLength(1);
    // 正文保留首次见到的原文（后续可能被编辑/删除，本地原文是排查依据），互动数刷新
    expect(stored.rows[0]?.body).toBe('看这个 @targetone 不错');
    expect(Number(stored.rows[0]?.like_count)).toBe(99);
  });

  itDb('第二次检索的增量起点是上次成功时间', async () => {
    await seedProject('p1', 'targetone');
    await pollTweetMentions(pool!, new FakeTweetSource({ tweets: [tweet()] }));
    const adapter = new FakeTweetSource({ tweets: [] });
    await pollTweetMentions(pool!, adapter);

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.since?.toISOString()).toBe('2026-09-14T10:00:00.000Z');
    expect(adapter.calls[0]?.handles).toEqual(['targetone']);
  });

  itDb('已排除项目不进入检索范围（不为不监控的账号付费）', async () => {
    await seedProject('p1', 'targetone', 5, 'monitored');
    await seedProject('p2', 'excludedone', 5, 'excluded');
    const adapter = new FakeTweetSource({ tweets: [] });
    const result = await pollTweetMentions(pool!, adapter);

    expect(result.handles).toBe(1);
    expect(adapter.calls[0]?.handles).toEqual(['targetone']);
  });

  itDb('星级低于核心池门槛的项目不检索（恢复入池除外）', async () => {
    await seedProject('p1', 'lowstar', 2, 'monitored');
    await seedProject('p2', 'targetone', 3, 'monitored');
    const adapter = new FakeTweetSource({ tweets: [] });
    const result = await pollTweetMentions(pool!, adapter);
    expect(result.handles).toBe(1);
    expect(adapter.calls[0]?.handles).toEqual(['targetone']);
  });
});
