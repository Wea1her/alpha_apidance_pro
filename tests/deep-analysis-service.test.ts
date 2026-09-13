import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanDeepAnalysisText,
  splitTelegramMessageText,
  triggerDeepAnalysisComment,
  type TriggerDeepAnalysisOptions
} from '../src/analysis-service.js';
import type { DeepAnalysisProgress } from '../src/analysis-task-queue.js';
import { DiscussionMappingStore } from '../src/discussion-store.js';
import { requestGrokAnalysis, XaiSearchUnsupportedError } from '../src/xai-client.js';

vi.mock('../src/xai-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/xai-client.js')>(),
  requestGrokAnalysis: vi.fn()
}));
const request = vi.mocked(requestGrokAnalysis);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deep-comment-'));
  const discussionStore = new DiscussionMappingStore({ persistPath: join(dir, 'mappings.jsonl') });
  discussionStore.ingest([{
    channelChatId: -1001, channelMessageId: 50, discussionChatId: -1002, discussionMessageId: 60
  }]);
  const reply = vi.fn().mockResolvedValue({ chatId: -1002, messageId: 61 });
  const options: TriggerDeepAnalysisOptions = {
    xaiApiKey: 'deep-key',
    xaiBaseUrl: 'https://api.fengshao1227.com',
    xaiModel: 'grok-4.20-multi-agent-0309',
    xaiMaxTokens: 4096,
    xaiSearchTools: ['web_search'],
    discussionChatId: '-1002',
    botToken: 'bot',
    channelChatId: -1001,
    channelMessageId: 50,
    title: '首次 5 星项目',
    content: '共同关注数达到 20',
    link: 'https://x.com/project_a',
    count: 20,
    star: 5,
    previousAnalysisText: '此前标准分析正文',
    discussionStore,
    loadSkill: async () => '深度报告的六个章节',
    reply,
    info: vi.fn(),
    warn: vi.fn()
  };
  return { options, reply, discussionStore };
}

beforeEach(() => request.mockReset());

describe('deep analysis formatting', () => {
  it('keeps source links while removing citation markers and emphasis', () => {
    expect(cleanDeepAnalysisText('**证据** [[1]](https://x.com/project/status/1)【2】\n来源：https://example.com'))
      .toBe('证据 https://x.com/project/status/1\n来源：https://example.com');
  });

  it('splits long lines without breaking emoji or dropping content', () => {
    const text = '甲'.repeat(3799) + '🚀' + '乙'.repeat(4000);
    const chunks = splitTelegramMessageText(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 3800)).toBe(true);
    for (const chunk of chunks) expect(Buffer.from(chunk).toString()).toBe(chunk);
  });

  it('prefers line boundaries and rejects invalid limits', () => {
    expect(splitTelegramMessageText('abcde\nfghij\nklm', 10)).toEqual(['abcde', 'fghij\nklm']);
    expect(() => splitTelegramMessageText('test', 0)).toThrow('at least 2');
  });
});

describe('triggerDeepAnalysisComment', () => {
  it('uses the independent fengshao model and replies under the triggering channel message', async () => {
    const { options, reply } = fixture();
    request.mockResolvedValue('**1. 项目定位与玩法**\n证据 https://example.com');
    const result = await triggerDeepAnalysisComment(options);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'deep-key', baseUrl: 'https://api.fengshao1227.com',
      model: 'grok-4.20-multi-agent-0309', maxTokens: 4096, searchTools: ['web_search']
    }));
    expect(request.mock.calls[0][0].prompt).toContain('此前标准分析正文');
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '-1002', replyToMessageId: 60,
      text: 'Grok 深度分析\n\n1. 项目定位与玩法\n证据 https://example.com'
    }));
    expect(result).toMatchObject({ messages: [{ chatId: -1002, messageId: 61 }] });
  });

  it('sends every long report part to the same discussion root within Telegram limits', async () => {
    const { options, reply } = fixture();
    request.mockResolvedValue('甲'.repeat(8000));
    const result = await triggerDeepAnalysisComment(options);
    expect(result?.messages).toHaveLength(3);
    expect(reply).toHaveBeenCalledTimes(3);
    for (const [sent] of reply.mock.calls) {
      expect(sent.chatId).toBe('-1002');
      expect(sent.replyToMessageId).toBe(60);
      expect(sent.text.length).toBeLessThanOrEqual(4096);
    }
  });

  it('does not spend a model request before a discussion mapping is available', async () => {
    const { options, reply, discussionStore } = fixture();
    vi.spyOn(discussionStore, 'waitFor').mockResolvedValue(null);
    await expect(triggerDeepAnalysisComment(options)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('rebuilds the prompt without search claims when the relay rejects tools', async () => {
    const { options } = fixture();
    request.mockRejectedValueOnce(new XaiSearchUnsupportedError('unsupported tools', 400))
      .mockResolvedValueOnce('未经检索确认的报告');
    await triggerDeepAnalysisComment(options);
    expect(request).toHaveBeenCalledTimes(2);
    const fallback = request.mock.calls[1][0];
    expect(fallback.searchTools).toEqual([]);
    expect(fallback.model).toBe('grok-4.20-multi-agent-0309');
    expect(fallback.prompt).toContain('本次未启用联网检索');
    expect(fallback.prompt).not.toContain('可用工具：');
    expect(fallback.prompt).not.toContain('当前只启用了 web_search');
  });

  it('propagates ordinary failures without falling back or sending an empty report', async () => {
    const { options, reply } = fixture();
    request.mockRejectedValueOnce(new Error('401 invalid key'));
    await expect(triggerDeepAnalysisComment(options)).rejects.toThrow('401 invalid key');
    expect(request).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    request.mockResolvedValueOnce('  [1]  ');
    await expect(triggerDeepAnalysisComment(options)).rejects.toThrow('empty report');
    expect(reply).not.toHaveBeenCalled();
  });

  it('persists generation before sending and resumes only unfinished parts after a failure', async () => {
    const { options, reply, discussionStore } = fixture();
    request.mockResolvedValue('甲'.repeat(4000));
    let saved: DeepAnalysisProgress | undefined;
    const onProgress = vi.fn(async (progress: DeepAnalysisProgress) => { saved = structuredClone(progress); });
    reply.mockImplementationOnce(async () => {
      expect(saved?.analysisText).toBe('甲'.repeat(4000));
      expect(saved?.sentMessages).toEqual([]);
      return { chatId: -1002, messageId: 61 };
    }).mockRejectedValueOnce(new Error('Telegram unavailable'))
      .mockResolvedValueOnce({ chatId: -1002, messageId: 62 });

    await expect(triggerDeepAnalysisComment({ ...options, onProgress })).rejects.toThrow('Telegram unavailable');
    expect(saved?.sentMessages).toEqual([{ chatId: -1002, messageId: 61 }]);
    const wait = vi.spyOn(discussionStore, 'waitFor');
    const result = await triggerDeepAnalysisComment({ ...options, progress: saved, onProgress, discussionChatId: '-999' });

    expect(request).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(3);
    expect(reply.mock.calls[2][0]).toMatchObject({
      chatId: '-1002', replyToMessageId: 60, text: reply.mock.calls[1][0].text
    });
    expect(result?.messages).toEqual([{ chatId: -1002, messageId: 61 }, { chatId: -1002, messageId: 62 }]);
    const callsBeforeRetry = reply.mock.calls.length;
    await triggerDeepAnalysisComment({ ...options, progress: saved, onProgress });
    expect(reply).toHaveBeenCalledTimes(callsBeforeRetry);
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not send any report if saving its generated checkpoint fails', async () => {
    const { options, reply } = fixture();
    request.mockResolvedValue('生成后的报告');
    await expect(triggerDeepAnalysisComment({
      ...options, onProgress: async () => { throw new Error('disk full'); }
    })).rejects.toThrow('disk full');
    expect(reply).not.toHaveBeenCalled();
  });
});
