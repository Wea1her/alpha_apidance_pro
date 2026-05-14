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
});
