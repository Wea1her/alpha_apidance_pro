import { describe, expect, it, vi } from 'vitest';
import { collectRugHistoryEvidence, extractUsernameFromXLink } from '../src/rug-history-provider.js';

describe('rug history provider', () => {
  it('extracts username from X links', () => {
    expect(extractUsernameFromXLink('https://x.com/project_b')).toBe('project_b');
    expect(extractUsernameFromXLink('https://twitter.com/project_b/status/1')).toBe('project_b');
    expect(extractUsernameFromXLink('')).toBeNull();
  });

  it('returns warning evidence when token is missing', async () => {
    await expect(
      collectRugHistoryEvidence({
        link: 'https://x.com/project_b',
        twitterToken: undefined,
        twitterApiBaseUrl: 'https://ai.6551.io'
      })
    ).resolves.toMatchObject({
      source: '6551',
      available: false,
      deletedTweetCount: null,
      negativeMentionCount: null,
      warnings: ['未配置 TWITTER_TOKEN，跳过 6551 Rug 历史查询']
    });
  });

  it('collects deleted tweets and negative mentions', async () => {
    const postOpen = vi.fn(async (endpoint: string) => {
      if (endpoint === 'twitter_deleted_tweets') {
        return { data: [{ text: 'old mint failed' }, { fullText: 'refund delayed' }] };
      }
      if (endpoint === 'twitter_user_tweets') {
        return { data: [{ text: 'building now' }] };
      }
      if (endpoint === 'twitter_search') {
        return { data: [{ text: '@project_b rug?' }, { text: '@project_b scam warning' }] };
      }
      return { data: { username: 'project_b' } };
    });

    const evidence = await collectRugHistoryEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.available).toBe(true);
    expect(evidence.deletedTweetCount).toBe(2);
    expect(evidence.negativeMentionCount).toBe(2);
    expect(evidence.deletedTweetSamples).toEqual(['old mint failed', 'refund delayed']);
    expect(evidence.negativeMentionSamples).toContain('@project_b rug?');
  });

  it('keeps partial evidence when one 6551 endpoint fails', async () => {
    const postOpen = vi.fn(async (endpoint: string) => {
      if (endpoint === 'twitter_deleted_tweets') throw new Error('deleted endpoint failed');
      if (endpoint === 'twitter_search') return { data: [{ text: '@project_b hacked?' }] };
      return { data: [] };
    });

    const evidence = await collectRugHistoryEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.available).toBe(true);
    expect(evidence.deletedTweetCount).toBeNull();
    expect(evidence.negativeMentionCount).toBe(1);
    expect(evidence.warnings.some((warning) => warning.includes('twitter_deleted_tweets'))).toBe(true);
  });

  it('collects negative quote and reply-like comment samples from recent tweets', async () => {
    const postOpen = vi.fn(async (endpoint: string, body: Record<string, unknown>) => {
      if (endpoint === 'twitter_user_tweets') {
        return {
          data: [
            { id: '1', text: 'launch update' },
            { idStr: '2', text: 'mint update' },
            { twId: '3', text: 'airdrop update' },
            { tweetId: '4', text: 'extra update' }
          ]
        };
      }
      if (endpoint === 'twitter_quote_tweets_by_id') {
        return { data: [{ text: `quote ${body.id} rug warning` }] };
      }
      if (endpoint === 'twitter_search') {
        if ('toUser' in body) return { data: [{ text: '@project_b 无法提现' }] };
        return { data: [] };
      }
      return { data: [] };
    });

    const evidence = await collectRugHistoryEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.checkedTweetCount).toBe(3);
    expect(evidence.commentNegativeCount).toBe(4);
    expect(evidence.commentNegativeSamples).toContain('quote 1 rug warning');
    expect(evidence.commentNegativeSamples).toContain('@project_b 无法提现');
    expect(postOpen.mock.calls.filter(([endpoint]) => endpoint === 'twitter_quote_tweets_by_id')).toHaveLength(3);
  });

  it('keeps comment evidence when one quote lookup fails', async () => {
    const postOpen = vi.fn(async (endpoint: string, body: Record<string, unknown>) => {
      if (endpoint === 'twitter_user_tweets') {
        return { data: [{ id: '1', text: 'one' }, { id: '2', text: 'two' }] };
      }
      if (endpoint === 'twitter_quote_tweets_by_id') {
        if (body.id === '1') throw new Error('quote failed');
        return { data: [{ text: 'second tweet scam warning' }] };
      }
      if (endpoint === 'twitter_search') return { data: [] };
      return { data: [] };
    });

    const evidence = await collectRugHistoryEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.checkedTweetCount).toBe(2);
    expect(evidence.commentNegativeSamples).toEqual(['second tweet scam warning']);
    expect(evidence.warnings.some((warning) => warning.includes('twitter_quote_tweets_by_id'))).toBe(true);
  });
});
