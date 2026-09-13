import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscussionMappingStore } from '../src/discussion-store.js';
import { triggerAnalysisComment } from '../src/analysis-service.js';
import { XaiSearchUnsupportedError, requestGrokAnalysis } from '../src/xai-client.js';

vi.mock('../src/xai-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/xai-client.js')>();
  return { ...actual, requestGrokAnalysis: vi.fn() };
});

const requestGrokAnalysisMock = vi.mocked(requestGrokAnalysis);

function createStore(): DiscussionMappingStore {
  const directory = mkdtempSync(join(tmpdir(), 'standard-analysis-'));
  const store = new DiscussionMappingStore({ persistPath: join(directory, 'mappings.jsonl') });
  store.ingest([
    {
      channelChatId: -1003903535780,
      channelMessageId: 88,
      discussionChatId: -1003769834276,
      discussionMessageId: 99
    }
  ]);
  return store;
}

function baseOptions(store: DiscussionMappingStore) {
  return {
    xaiApiKey: 'key',
    xaiBaseUrl: 'https://example.com',
    xaiModel: 'grok-4.3',
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
    star: 3
  };
}

beforeEach(() => {
  requestGrokAnalysisMock.mockReset();
});

describe('triggerAnalysisComment', () => {
  it('replies to the first analysis message when project analysis already exists', async () => {
    const store = createStore();
    const existing = { discussionChatId: '-1003769834276', analysisMessageId: 555 };
    const reply = vi.fn().mockResolvedValue({ messageId: 556, chatId: -1003769834276 });
    const analyze = vi.fn();

    const result = await triggerAnalysisComment({
      ...baseOptions(store),
      existingAnalysis: existing,
      analyze,
      reply
    });

    expect(analyze).not.toHaveBeenCalled();
    expect(requestGrokAnalysisMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'reminder',
      message: { messageId: 556, chatId: -1003769834276 },
      existingAnalysis: existing
    });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      botToken: 'bot',
      chatId: '-1003769834276',
      replyToMessageId: 555,
      text: '重复命中提醒\n\nA 关注了 B\n监控池关注数：12\n当前重要程度：3 星',
      proxyUrl: 'http://127.0.0.1:7890'
    }));
  });

  it('returns the created analysis comment message on first analysis', async () => {
    const store = createStore();
    const reply = vi.fn().mockResolvedValue({ messageId: 556, chatId: -1003769834276 });
    const analyze = vi.fn().mockResolvedValue('1. 项目核心信息：test');
    const loadSkill = vi.fn().mockResolvedValue('# 测试 Skill\n\n只输出测试分析。');

    await expect(
      triggerAnalysisComment({
        ...baseOptions(store),
        xaiSearchTools: ['web_search', 'x_search'],
        loadSkill,
        analyze,
        reply
      })
    ).resolves.toEqual({
      type: 'analysis',
      message: { messageId: 556, chatId: -1003769834276 },
      analysisText: '1. 项目核心信息：test'
    });

    expect(loadSkill).toHaveBeenCalledOnce();
    expect(requestGrokAnalysisMock).not.toHaveBeenCalled();
    const prompt = analyze.mock.calls[0][0] as string;
    expect(prompt).toContain('检索要求：');
    expect(prompt).toContain('x_search');
    expect(prompt).toContain('# 测试 Skill');
    expect(prompt).not.toContain('项目背景/背书账号证据');
    expect(prompt).not.toContain('Rug');
  });

  it('removes source blocks and citation markers from the sent Grok analysis text', async () => {
    const store = createStore();
    const reply = vi.fn().mockResolvedValue({ messageId: 556, chatId: -1003769834276 });
    const analyze = vi.fn().mockResolvedValue([
      '**1. 项目核心信息**：test [[1]](https://example.com/report.pdf)',
      '**2. 项目背景/背书账号**：被 @aave 关注[1]，官网已上线【2】',
      '',
      '## Sources',
      '[grok2api-sources]: #',
      '- [Example](https://example.com)'
    ].join('\n'));

    const result = await triggerAnalysisComment({
      ...baseOptions(store),
      analyze,
      reply
    });

    expect(reply.mock.calls[0][0].text).toBe(
      'Grok 分析\n\n1. 项目核心信息：test\n2. 项目背景/背书账号：被 @aave 关注，官网已上线'
    );
    expect(reply.mock.calls[0][0].text).not.toContain('*');
    expect(result).toMatchObject({
      type: 'analysis',
      analysisText: '1. 项目核心信息：test\n2. 项目背景/背书账号：被 @aave 关注，官网已上线'
    });
  });

  it('passes configured search tools to the xAI client', async () => {
    const store = createStore();
    const reply = vi.fn().mockResolvedValue({ messageId: 556, chatId: -1003769834276 });
    requestGrokAnalysisMock.mockResolvedValue('1. 项目核心信息\ntest');

    await triggerAnalysisComment({
      ...baseOptions(store),
      xaiSearchTools: ['web_search', 'x_search'],
      xaiMaxTokens: 4096,
      loadSkill: async () => '# 测试 Skill',
      reply
    });

    expect(requestGrokAnalysisMock).toHaveBeenCalledTimes(1);
    expect(requestGrokAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'key',
      baseUrl: 'https://example.com',
      model: 'grok-4.3',
      proxyUrl: 'http://127.0.0.1:7890',
      maxTokens: 4096,
      searchTools: ['web_search', 'x_search'],
      warn: expect.any(Function)
    }));
    expect(requestGrokAnalysisMock.mock.calls[0][0].prompt).toContain('检索要求：');
    expect(reply.mock.calls[0][0].text).toBe('Grok 分析\n\n1. 项目核心信息\ntest');
  });

  it('falls back to a plain request when the search endpoint is unsupported', async () => {
    const store = createStore();
    const reply = vi.fn().mockResolvedValue({ messageId: 556, chatId: -1003769834276 });
    const warn = vi.fn();
    requestGrokAnalysisMock
      .mockRejectedValueOnce(new XaiSearchUnsupportedError('xAI responses API unsupported: 500 not implemented', 500))
      .mockResolvedValueOnce('1. 项目核心信息\nfallback');

    const result = await triggerAnalysisComment({
      ...baseOptions(store),
      xaiSearchTools: ['web_search', 'x_search'],
      loadSkill: async () => '# 测试 Skill',
      reply,
      warn
    });

    expect(requestGrokAnalysisMock).toHaveBeenCalledTimes(2);
    expect(requestGrokAnalysisMock.mock.calls[0][0].searchTools).toEqual(['web_search', 'x_search']);
    expect(requestGrokAnalysisMock.mock.calls[1][0].searchTools).toEqual([]);
    expect(requestGrokAnalysisMock.mock.calls[1][0].prompt).toContain('本次未启用联网检索');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('退回普通 Grok 请求'));
    expect(result).toMatchObject({ type: 'analysis', analysisText: '1. 项目核心信息\nfallback' });
  });

  it('does not fall back for other xAI errors', async () => {
    const store = createStore();
    const reply = vi.fn();
    requestGrokAnalysisMock.mockRejectedValue(new Error('xAI request failed: 401 API key is disabled'));

    await expect(
      triggerAnalysisComment({
        ...baseOptions(store),
        xaiSearchTools: ['x_search'],
        loadSkill: async () => '# 测试 Skill',
        reply
      })
    ).rejects.toThrow('401 API key is disabled');

    expect(requestGrokAnalysisMock).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });
});
