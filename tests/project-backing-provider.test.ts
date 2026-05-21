import { describe, expect, it, vi } from 'vitest';
import {
  PROJECT_BACKING_CANDIDATE_LIMIT,
  collectProjectBackingEvidence,
  extractUsernameFromXLink
} from '../src/project-backing-provider.js';

describe('project backing provider', () => {
  it('extracts username from X links', () => {
    expect(extractUsernameFromXLink('https://x.com/project_b')).toBe('project_b');
    expect(extractUsernameFromXLink('https://twitter.com/project_b/status/1')).toBe('project_b');
    expect(extractUsernameFromXLink('')).toBeNull();
  });

  it('returns warning evidence when token is missing', async () => {
    await expect(
      collectProjectBackingEvidence({
        link: 'https://x.com/project_b',
        twitterToken: undefined,
        twitterApiBaseUrl: 'https://ai.6551.io'
      })
    ).resolves.toMatchObject({
      source: '6551',
      available: false,
      candidateCount: null,
      candidates: [],
      warnings: ['未配置 TWITTER_TOKEN，跳过 6551 项目背书查询']
    });
  });

  it('returns warning evidence when username cannot be extracted', async () => {
    await expect(
      collectProjectBackingEvidence({
        link: 'not-a-twitter-link',
        twitterToken: 'token',
        twitterApiBaseUrl: 'https://ai.6551.io'
      })
    ).resolves.toMatchObject({
      source: '6551',
      available: false,
      candidateCount: null,
      candidates: [],
      warnings: ['无法从 X 链接提取 username，跳过 6551 项目背书查询']
    });
  });

  it('calls twitter_kol_followers and normalizes candidate accounts', async () => {
    const postOpen = vi.fn(async (endpoint: string) => {
      if (endpoint === 'twitter_kol_followers') {
        return {
          data: [
            {
              username: 'aave',
              name: 'Aave',
              description: 'Aave Protocol official account',
              followersCount: 730000,
              verified: true,
              category: 'project'
            },
            {
              screenName: '@paradigm',
              displayName: 'Paradigm',
              bio: 'A research-driven crypto investment firm',
              followers_count: 410000,
              isBlueVerified: true,
              type: 'vc'
            }
          ]
        };
      }
      return { data: [] };
    });

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(postOpen).toHaveBeenCalledWith('twitter_kol_followers', { username: 'project_b' });
    expect(evidence).toEqual({
      source: '6551',
      available: true,
      candidateCount: 2,
      candidates: [
        {
          username: 'aave',
          displayName: 'Aave',
          description: 'Aave Protocol official account',
          followersCount: 730000,
          verified: true,
          rawCategory: 'project'
        },
        {
          username: 'paradigm',
          displayName: 'Paradigm',
          description: 'A research-driven crypto investment firm',
          followersCount: 410000,
          verified: true,
          rawCategory: 'vc'
        }
      ],
      warnings: []
    });
  });

  it('supports nested result users arrays and skips rows without username', async () => {
    const postOpen = vi.fn(async () => ({
      result: {
        users: [
          { userName: 'base', displayName: 'Base', bio: 'Ethereum L2 incubated by Coinbase' },
          { displayName: 'Missing Handle', bio: 'cannot be used' }
        ]
      }
    }));

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.candidateCount).toBe(1);
    expect(evidence.candidates).toEqual([
      {
        username: 'base',
        displayName: 'Base',
        description: 'Ethereum L2 incubated by Coinbase'
      }
    ]);
  });

  it('normalizes additional 6551 username and follower fields', async () => {
    const postOpen = vi.fn(async () => ({
      data: [
        {
          twAccount: '@binance',
          name: 'Binance',
          bio: 'Exchange official',
          followerCount: '12000000',
          blueVerified: true
        },
        {
          screen_name: 'ethereum',
          description: 'Ethereum Foundation',
          followers_count_str: '3000000'
        }
      ]
    }));

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.candidateCount).toBe(2);
    expect(evidence.candidates).toEqual([
      {
        username: 'binance',
        displayName: 'Binance',
        description: 'Exchange official',
        followersCount: 12000000,
        verified: true
      },
      {
        username: 'ethereum',
        description: 'Ethereum Foundation',
        followersCount: 3000000
      }
    ]);
  });

  it('limits candidates to the configured prompt candidate limit', async () => {
    const postOpen = vi.fn(async () => ({
      data: Array.from({ length: PROJECT_BACKING_CANDIDATE_LIMIT + 5 }, (_, index) => ({
        username: `kol_${index + 1}`,
        name: `KOL ${index + 1}`
      }))
    }));

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.candidateCount).toBe(PROJECT_BACKING_CANDIDATE_LIMIT + 5);
    expect(evidence.candidates).toHaveLength(PROJECT_BACKING_CANDIDATE_LIMIT);
    expect(evidence.candidates[0]?.username).toBe('kol_1');
    expect(evidence.candidates.at(-1)?.username).toBe(`kol_${PROJECT_BACKING_CANDIDATE_LIMIT}`);
  });

  it('warns when raw candidates exist but usernames cannot be parsed', async () => {
    const postOpen = vi.fn(async () => ({
      data: [
        { displayName: 'Missing Handle', bio: 'cannot be used' },
        { username: 'invalid-handle', name: 'Invalid Handle' }
      ]
    }));

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence).toEqual({
      source: '6551',
      available: true,
      candidateCount: 0,
      candidates: [],
      warnings: ['6551 项目背书候选无法解析 username']
    });
  });

  it('returns warning evidence when 6551 lookup fails', async () => {
    const postOpen = vi.fn(async () => {
      throw new Error('rate limited');
    });

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.available).toBe(false);
    expect(evidence.candidateCount).toBeNull();
    expect(evidence.candidates).toEqual([]);
    expect(evidence.warnings).toEqual(['twitter_kol_followers 查询失败：rate limited']);
  });

  it('returns warning evidence when default client construction fails', async () => {
    const evidencePromise = collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      proxyUrl: 'http://%'
    });

    await expect(evidencePromise).resolves.toMatchObject({
      source: '6551',
      available: false,
      candidateCount: null,
      candidates: []
    });
    const evidence = await evidencePromise;
    expect(evidence.warnings).toEqual([expect.stringContaining('twitter_kol_followers 查询失败')]);
  });
});
