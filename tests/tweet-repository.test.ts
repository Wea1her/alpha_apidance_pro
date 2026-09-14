import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import {
  TWEET_SUMMARY_MAX_ATTEMPTS,
  listCorePool,
  listTweetFeed,
  listTweetPollStates,
  listTweetsNeedingSummary,
  markTweetPollFailure,
  markTweetPollSuccess,
  markTweetSummaryDone,
  markTweetSummaryFailed,
  readTweetFeedFreshness,
  upsertTweet
} from '../src/storage/tweet-repository.js';
import { buildTweetUrl, type FetchedTweet } from '../src/tweets/adapter.js';

/**
 * 推文仓储（Q111-Q121）集成测试：需要真实 PostgreSQL；不可用时跳过。
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

async function seedProject(projectId: string, star: number, options: { poolState?: string; source?: string } = {}): Promise<void> {
  // 已排除状态必须带排除时间与原因（projects_exclusion_consistent 约束）。
  const excluded = (options.poolState ?? 'monitored') === 'excluded';
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, source, pool_state, star, excluded_at, exclusion_reason)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'excluded' THEN now() ELSE NULL END,
             CASE WHEN $4 = 'excluded' THEN 'manual' ELSE NULL END)`,
    [projectId, projectId, options.source ?? 'natural', options.poolState ?? 'monitored', star]
  );
  void excluded;
}

function makeTweet(overrides: Partial<FetchedTweet> = {}): FetchedTweet {
  return {
    tweetId: '1001',
    authorHandle: 'caller',
    authorName: 'Caller',
    authorVerified: false,
    authorFollowers: 1200,
    body: '喊单 @coreproject',
    postedAt: '2026-09-14T00:00:00.000Z',
    likeCount: 5,
    retweetCount: 2,
    replyCount: 1,
    viewCount: 300,
    url: buildTweetUrl('caller', '1001'),
    mentions: ['coreproject'],
    rawPayload: '{"id":"1001"}',
    ...overrides
  };
}

describe('核心池定义（Q115）', () => {
  itDb('星级 ≥3 或恢复入池的项目进核心池，已排除与低星不进', async () => {
    await seedProject('p-star3', 3);
    await seedProject('p-star5', 5);
    await seedProject('p-star2', 2);
    await seedProject('p-restored', 0, { source: 'restored' });
    await seedProject('p-excluded', 5, { poolState: 'excluded' });

    const members = await listCorePool(pool!);
    const ids = members.map((member) => member.projectId).sort();
    expect(ids).toEqual(['p-restored', 'p-star3', 'p-star5']);
    // 已排除的高星项目不再检索，避免为不监控的账号付费
    expect(ids).not.toContain('p-excluded');
  });
});

describe('推文入库去重（Q112）', () => {
  itDb('首次入库建立推文与账号关联', async () => {
    await seedProject('core-project', 3);
    const result = await upsertTweet(pool!, {
      tweet: makeTweet(),
      source: 'test-source',
      mentionedProjects: [{ projectId: 'core-project', projectKey: 'coreproject' }]
    });
    expect(result).toMatchObject({ tweetId: '1001', created: true, newMentions: ['coreproject'] });

    const feed = await listTweetFeed(pool!);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ tweetId: '1001', authorHandle: 'caller', summaryStatus: 'pending' });
    expect(feed[0]?.mentionedProjects).toEqual([{ projectId: 'core-project', projectKey: 'coreproject' }]);
  });

  itDb('重复抓取不产生第二条，只刷新互动数与最后见到时间', async () => {
    await seedProject('core-project', 3);
    await upsertTweet(pool!, {
      tweet: makeTweet(),
      source: 'test-source',
      mentionedProjects: [{ projectId: 'core-project', projectKey: 'coreproject' }]
    });
    const again = await upsertTweet(pool!, {
      tweet: makeTweet({ likeCount: 50, viewCount: 9000 }),
      source: 'test-source',
      mentionedProjects: [{ projectId: 'core-project', projectKey: 'coreproject' }]
    });

    expect(again.created).toBe(false);
    // 关联不重复建立 → 没有“新的喊单”，页面不会重复提示
    expect(again.newMentions).toEqual([]);

    const feed = await listTweetFeed(pool!);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ likeCount: 50, viewCount: 9000 });
  });

  itDb('一条推文提及多个账号时建立多条关联（Q120 双向可达）', async () => {
    await seedProject('p-a', 3);
    await seedProject('p-b', 4);
    await upsertTweet(pool!, {
      tweet: makeTweet({ mentions: ['pa', 'pb'] }),
      source: 'test-source',
      mentionedProjects: [
        { projectId: 'p-a', projectKey: 'pa' },
        { projectId: 'p-b', projectKey: 'pb' }
      ]
    });

    const all = await listTweetFeed(pool!);
    expect(all[0]?.mentionedProjects).toHaveLength(2);

    const onlyB = await listTweetFeed(pool!, { projectId: 'p-b' });
    expect(onlyB.map((row) => row.tweetId)).toEqual(['1001']);
    const onlyA = await listTweetFeed(pool!, { projectId: 'p-a' });
    expect(onlyA).toHaveLength(1);
  });

  itDb('按发布时间倒序，发布时间缺失时退到首次见到时间', async () => {
    await seedProject('p-a', 3);
    const mention = [{ projectId: 'p-a', projectKey: 'pa' }];
    await upsertTweet(pool!, {
      tweet: makeTweet({ tweetId: 'older', postedAt: '2026-09-13T00:00:00.000Z' }),
      source: 's',
      mentionedProjects: mention
    });
    await upsertTweet(pool!, {
      tweet: makeTweet({ tweetId: 'newer', postedAt: '2026-09-15T00:00:00.000Z' }),
      source: 's',
      mentionedProjects: mention
    });
    await upsertTweet(pool!, {
      tweet: makeTweet({ tweetId: 'unknown-time', postedAt: null }),
      source: 's',
      mentionedProjects: mention
    });

    const feed = await listTweetFeed(pool!);
    expect(feed.map((row) => row.tweetId)).toEqual(['newer', 'unknown-time', 'older']);
  });

  itDb('没有喊单时返回空列表，而不是报错', async () => {
    expect(await listTweetFeed(pool!)).toEqual([]);
  });
});

describe('检索游标与新鲜度（Q116、Q121）', () => {
  itDb('成功后推进游标并清零连续失败', async () => {
    await seedProject('p-a', 3);
    await markTweetPollFailure(pool!, { projectId: 'p-a', error: '供应商 503', at: new Date('2026-09-14T00:00:00.000Z') });
    await markTweetPollFailure(pool!, { projectId: 'p-a', error: '供应商 503', at: new Date('2026-09-14T00:05:00.000Z') });

    let states = await listTweetPollStates(pool!);
    expect(states[0]).toMatchObject({ projectId: 'p-a', consecutiveFailures: 2, lastError: '供应商 503' });

    await markTweetPollSuccess(pool!, { projectId: 'p-a', at: new Date('2026-09-14T01:00:00.000Z') });
    states = await listTweetPollStates(pool!);
    expect(states[0]).toMatchObject({ projectId: 'p-a', consecutiveFailures: 0, lastError: null });
    expect(states[0]?.lastSuccessAt).toContain('2026-09-14');
  });

  itDb('失败不推进游标：下次仍从上次成功处继续', async () => {
    await seedProject('p-a', 3);
    await markTweetPollSuccess(pool!, { projectId: 'p-a', at: new Date('2026-09-14T00:00:00.000Z') });
    await markTweetPollFailure(pool!, { projectId: 'p-a', error: '配额耗尽', at: new Date('2026-09-14T02:00:00.000Z') });

    const states = await listTweetPollStates(pool!);
    expect(states[0]?.lastSuccessAt).toContain('2026-09-14T00:00:00');
    expect(states[0]?.lastError).toBe('配额耗尽');
  });

  itDb('新鲜度汇总：最久成功时间、失败账号数、待摘要数', async () => {
    await seedProject('p-a', 3);
    await seedProject('p-b', 4);
    await markTweetPollSuccess(pool!, { projectId: 'p-a', at: new Date('2026-09-14T00:00:00.000Z') });
    await markTweetPollSuccess(pool!, { projectId: 'p-b', at: new Date('2026-09-14T03:00:00.000Z') });
    await markTweetPollFailure(pool!, { projectId: 'p-b', error: '临时失败', at: new Date('2026-09-14T04:00:00.000Z') });
    await upsertTweet(pool!, { tweet: makeTweet(), source: 's', mentionedProjects: [{ projectId: 'p-a', projectKey: 'pa' }] });

    const freshness = await readTweetFeedFreshness(pool!);
    // 最久成功时间是较早的那个账号
    expect(freshness.lastSuccessAt).toContain('2026-09-14T00:00:00');
    expect(freshness.failingProjects).toBe(1);
    expect(freshness.pendingSummaries).toBe(1);
  });
});

describe('中文摘要状态机（Q117）', () => {
  itDb('摘要成功后记录文本与模型，并不再出现在待处理列表', async () => {
    await upsertTweet(pool!, { tweet: makeTweet(), source: 's', mentionedProjects: [] });
    const pending = await listTweetsNeedingSummary(pool!);
    expect(pending.map((row) => row.tweetId)).toEqual(['1001']);

    await markTweetSummaryDone(pool!, { tweetId: '1001', summary: '某人在喊单该项目。', model: 'grok-4.3' });
    const feed = await listTweetFeed(pool!);
    expect(feed[0]).toMatchObject({ summaryStatus: 'done', summaryText: '某人在喊单该项目。' });
    expect(await listTweetsNeedingSummary(pool!)).toEqual([]);
  });

  itDb('摘要失败累计次数，达到上限后置为 failed，原文仍保留', async () => {
    await upsertTweet(pool!, { tweet: makeTweet(), source: 's', mentionedProjects: [] });

    for (let attempt = 1; attempt <= TWEET_SUMMARY_MAX_ATTEMPTS; attempt += 1) {
      const result = await markTweetSummaryFailed(pool!, { tweetId: '1001', error: '模型超时' });
      if (attempt < TWEET_SUMMARY_MAX_ATTEMPTS) {
        expect(result.status).toBe('pending');
      } else {
        expect(result.status).toBe('failed');
      }
    }

    const feed = await listTweetFeed(pool!);
    // 关键：摘要失败不影响内容展示，页面显示“摘要不可用”即可（Q117）。
    expect(feed[0]?.summaryStatus).toBe('failed');
    expect(feed[0]?.body).toContain('喊单');
    expect(feed[0]?.summaryText).toBeNull();
  });
});
