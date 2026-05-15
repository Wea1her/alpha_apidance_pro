import { describe, expect, it, vi } from 'vitest';
import { DiscussionMappingStore } from '../src/discussion-store.js';
import { triggerAnalysisComment } from '../src/analysis-service.js';

describe('triggerAnalysisComment', () => {
  it('replies to the first analysis message when project analysis already exists', async () => {
    const store = new DiscussionMappingStore();
    store.ingest([
      {
        channelChatId: -1003903535780,
        channelMessageId: 88,
        discussionChatId: -1003769834276,
        discussionMessageId: 99
      }
    ]);

    const existing = { discussionChatId: '-1003769834276', analysisMessageId: 555 };
    const reply = vi.fn().mockResolvedValue({ messageId: 556, chatId: -1003769834276 });
    const analyze = vi.fn();
    const getRugHistory = vi.fn();

    await triggerAnalysisComment({
      xaiApiKey: 'key',
      xaiBaseUrl: 'https://example.com',
      xaiModel: 'grok-4.20-fast',
      proxyUrl: 'http://127.0.0.1:7890',
      discussionChatId: '-1003769834276',
      discussionStore: store,
      botToken: 'bot',
      channelChatId: -1003903535780,
      channelMessageId: 88,
      title: 'A 关注了 B',
      content: '用户简介: builder',
      link: 'https://x.com/b',
      count: 12,
      star: 3,
      projectKey: 'b',
      existingAnalysis: existing,
      analyze,
      getRugHistory,
      reply
    });

    expect(analyze).not.toHaveBeenCalled();
    expect(getRugHistory).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      botToken: 'bot',
      chatId: '-1003769834276',
      replyToMessageId: 555,
      text: '重复命中提醒\n\nA 关注了 B\n监控池关注数：12\n当前重要程度：3 星',
      proxyUrl: 'http://127.0.0.1:7890'
    });
  });

  it('returns the created analysis comment message on first analysis', async () => {
    const store = new DiscussionMappingStore();
    store.ingest([
      {
        channelChatId: -1003903535780,
        channelMessageId: 88,
        discussionChatId: -1003769834276,
        discussionMessageId: 99
      }
    ]);

    const reply = vi.fn().mockResolvedValue({ messageId: 556, chatId: -1003769834276 });
    const analyze = vi.fn().mockResolvedValue('1. 项目核心信息：test');
    const loadSkill = vi.fn().mockResolvedValue('# 测试 Skill\n\n只输出测试分析。');
    const getRugHistory = vi.fn().mockResolvedValue({
      source: '6551',
      available: true,
      deletedTweetCount: 1,
      negativeMentionCount: 2,
      recentTweetCount: 3,
      deletedTweetSamples: ['deleted mint'],
      negativeMentionSamples: ['rug?'],
      recentRiskSignals: ['recent mint'],
      warnings: []
    });

    await expect(
      triggerAnalysisComment({
        xaiApiKey: 'key',
        xaiBaseUrl: 'https://example.com',
        xaiModel: 'grok-4.20-fast',
        proxyUrl: 'http://127.0.0.1:7890',
        discussionChatId: '-1003769834276',
        discussionStore: store,
        botToken: 'bot',
        channelChatId: -1003903535780,
        channelMessageId: 88,
        projectKey: 'b',
        title: 'A 关注了 B',
        content: '用户简介: builder',
        link: 'https://x.com/b',
        count: 12,
        star: 3,
        twitterToken: 'twitter-token',
        twitterApiBaseUrl: 'https://ai.6551.io',
        getRugHistory,
        loadSkill,
        analyze,
        reply
      })
    ).resolves.toEqual({ messageId: 556, chatId: -1003769834276 });

    expect(getRugHistory).toHaveBeenCalledWith({
      link: 'https://x.com/b',
      twitterToken: 'twitter-token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      proxyUrl: 'http://127.0.0.1:7890'
    });
    expect(loadSkill).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0][0]).toContain('Rug 数据可用');
    expect(analyze.mock.calls[0][0]).toContain('deleted mint');
    expect(analyze.mock.calls[0][0]).toContain('# 测试 Skill');
  });

  it('removes source blocks from the sent Grok analysis text', async () => {
    const store = new DiscussionMappingStore();
    store.ingest([
      {
        channelChatId: -1003903535780,
        channelMessageId: 88,
        discussionChatId: -1003769834276,
        discussionMessageId: 99
      }
    ]);

    const reply = vi.fn().mockResolvedValue({ messageId: 556, chatId: -1003769834276 });
    const analyze = vi.fn().mockResolvedValue([
      '1. 项目核心信息：test [[1]](https://example.com/report.pdf)',
      '2. 当前进展：early',
      '',
      '## Sources',
      '[grok2api-sources]: #',
      '- [Example](https://example.com)'
    ].join('\n'));
    const getRugHistory = vi.fn().mockResolvedValue({
      source: '6551',
      available: true,
      deletedTweetCount: 0,
      negativeMentionCount: 0,
      recentTweetCount: 0,
      commentNegativeCount: 0,
      checkedTweetCount: 0,
      deletedTweetSamples: [],
      negativeMentionSamples: [],
      commentNegativeSamples: [],
      recentRiskSignals: [],
      warnings: []
    });

    await triggerAnalysisComment({
      xaiApiKey: 'key',
      xaiBaseUrl: 'https://example.com',
      xaiModel: 'grok-4.20-fast',
      proxyUrl: 'http://127.0.0.1:7890',
      discussionChatId: '-1003769834276',
      discussionStore: store,
      botToken: 'bot',
      channelChatId: -1003903535780,
      channelMessageId: 88,
      projectKey: 'b',
      title: 'A 关注了 B',
      content: '用户简介: builder',
      link: 'https://x.com/b',
      count: 12,
      star: 3,
      twitterToken: 'twitter-token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      getRugHistory,
      analyze,
      reply
    });

    expect(reply.mock.calls[0][0].text).toBe('Grok 分析\n\n1. 项目核心信息：test\n2. 当前进展：early');
  });
});
