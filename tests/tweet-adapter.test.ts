import { describe, expect, it } from 'vitest';
import {
  UnconfiguredTweetSource,
  buildTweetUrl,
  filterIncremental,
  normalizeFetchedTweet,
  tweetDedupeKey,
  tweetMentionsHandle,
  type FetchedTweet
} from '../src/tweets/adapter.js';

/**
 * 推文适配器契约测试（Q108、Q111-Q113、Q129）。
 * 纯逻辑：不发网络请求，不依赖数据库。
 */

function tweet(overrides: Partial<FetchedTweet> = {}): FetchedTweet {
  return {
    tweetId: '1001',
    authorHandle: 'caller',
    authorName: 'Caller',
    authorVerified: false,
    authorFollowers: 1200,
    body: 'Big news about @newproject and $TOKEN',
    postedAt: '2026-09-14T00:00:00.000Z',
    likeCount: 5,
    retweetCount: 2,
    replyCount: 1,
    viewCount: 300,
    url: null,
    mentions: ['newproject'],
    rawPayload: null,
    ...overrides
  };
}

describe('未配置数据源（Q129）', () => {
  it('明确报告未配置，并且检索时抛错而不是返回空数组', async () => {
    const source = new UnconfiguredTweetSource();
    expect(source.isConfigured()).toBe(false);
    // 关键：不能把“未配置”伪装成“没有提及”（Q113）。
    await expect(source.fetchMentions()).rejects.toThrow(/未配置/);
  });
});

describe('链接拼接（供应商不返回链接时）', () => {
  it('由 handle 与推文 ID 拼接，容忍 @ 前缀', () => {
    expect(buildTweetUrl('Caller', '123')).toBe('https://x.com/Caller/status/123');
    expect(buildTweetUrl('@Caller', '123')).toBe('https://x.com/Caller/status/123');
  });

  it('缺少 handle 时不编造链接', () => {
    expect(buildTweetUrl(null, '123')).toBeNull();
    expect(buildTweetUrl('   ', '123')).toBeNull();
  });
});

describe('本地二次校验（Q111）', () => {
  it('mentions 列表命中即可', () => {
    expect(tweetMentionsHandle(tweet({ mentions: ['newproject'], body: 'no mention text' }), 'newproject')).toBe(true);
  });

  it('正文里的 @handle 命中，且大小写不敏感', () => {
    expect(tweetMentionsHandle(tweet({ mentions: [], body: 'check @NewProject now' }), 'newproject')).toBe(true);
  });

  it('不把前缀相同的其他账号当成命中', () => {
    // @newprojectxyz 不是 @newproject
    expect(tweetMentionsHandle(tweet({ mentions: [], body: 'check @newprojectxyz now' }), 'newproject')).toBe(false);
  });

  it('完全不提及时返回 false', () => {
    expect(tweetMentionsHandle(tweet({ mentions: [], body: 'nothing here' }), 'newproject')).toBe(false);
  });

  it('空 handle 视为不命中', () => {
    expect(tweetMentionsHandle(tweet(), '  ')).toBe(false);
  });
});

describe('字段归一化（供应商无关）', () => {
  it('识别 camelCase 与 snake_case 字段', () => {
    const normalized = normalizeFetchedTweet({
      tweet_id: '2002',
      full_text: 'hello',
      created_at: '2026-09-14T01:00:00.000Z',
      user: { screen_name: 'Author', name: 'Author Name', verified: true, followersCount: 99 },
      favorite_count: '7',
      retweet_count: 3,
      entities: { user_mentions: [{ username: 'Target' }] }
    });
    expect(normalized).toMatchObject({
      tweetId: '2002',
      body: 'hello',
      authorHandle: 'Author',
      authorName: 'Author Name',
      authorVerified: true,
      authorFollowers: 99,
      likeCount: 7,
      retweetCount: 3,
      mentions: ['target']
    });
    expect(normalized?.url).toBe('https://x.com/Author/status/2002');
  });

  it('接受 Unix 秒级时间戳', () => {
    const normalized = normalizeFetchedTweet({ id: '1', text: 'x', created_at: 1_789_000_000 });
    expect(normalized?.postedAt).toBe(new Date(1_789_000_000 * 1000).toISOString());
  });

  it('缺少推文 ID 或正文时返回 null（不猜值）', () => {
    expect(normalizeFetchedTweet({ text: 'no id' })).toBeNull();
    expect(normalizeFetchedTweet({ id: '1' })).toBeNull();
  });

  it('互动数缺失保持 null，不填 0 冒充（Q117）', () => {
    const normalized = normalizeFetchedTweet({ id: '1', text: 'x' });
    expect(normalized?.likeCount).toBeNull();
    expect(normalized?.viewCount).toBeNull();
    expect(normalized?.authorFollowers).toBeNull();
    expect(normalized?.postedAt).toBeNull();
  });
});

describe('本地去重与增量（Q112、成本控制）', () => {
  it('去重键就是推文 ID', () => {
    expect(tweetDedupeKey(tweet({ tweetId: 'abc' }))).toBe('abc');
  });

  it('增量过滤只保留游标之后的推文', () => {
    const tweets = [
      tweet({ tweetId: 'old', postedAt: '2026-09-14T00:00:00.000Z' }),
      tweet({ tweetId: 'new', postedAt: '2026-09-14T02:00:00.000Z' })
    ];
    const kept = filterIncremental(tweets, new Date('2026-09-14T01:00:00.000Z'));
    expect(kept.map((item) => item.tweetId)).toEqual(['new']);
  });

  it('首次检索（游标为空）保留全部', () => {
    const tweets = [tweet({ tweetId: 'a' }), tweet({ tweetId: 'b' })];
    expect(filterIncremental(tweets, null)).toHaveLength(2);
  });

  it('发布时间缺失时保守保留，避免漏掉内容（由推文 ID 去重兜底）', () => {
    const tweets = [tweet({ tweetId: 'unknown-time', postedAt: null })];
    expect(filterIncremental(tweets, new Date('2026-09-14T01:00:00.000Z'))).toHaveLength(1);
  });
});
