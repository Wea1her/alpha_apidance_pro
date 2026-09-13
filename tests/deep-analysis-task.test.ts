import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisArchiveStore } from '../src/analysis-archive-store.js';
import { triggerDeepAnalysisComment, type TriggerDeepAnalysisOptions } from '../src/analysis-service.js';
import { AnalysisTaskQueue, type AnalysisTaskRecord } from '../src/analysis-task-queue.js';
import { parseServiceConfig } from '../src/config.js';
import { enqueueDeepAnalysisTask, processDeepAnalysisTask } from '../src/deep-analysis-task.js';
import { DiscussionMappingStore } from '../src/discussion-store.js';

const task = {
  taskKey: '-1001:50', projectKey: 'project_a', channelChatId: -1001, channelMessageId: 50,
  title: '首次 5 星', content: '共同关注达到 20', link: 'https://x.com/project_a',
  mainPushedAt: '2026-09-13T05:00:00.000Z', count: 20, star: 5
};

async function fixture(withMapping = true) {
  const dir = await mkdtemp(join(tmpdir(), 'deep-task-'));
  const queueOptions = { filePath: join(dir, 'queue.jsonl'), deadLetterPath: join(dir, 'dead.jsonl') };
  const queue = new AnalysisTaskQueue(queueOptions);
  const archiveOptions = { filePath: join(dir, 'archive.jsonl') };
  const archiveStore = new AnalysisArchiveStore(archiveOptions);
  const discussionStore = new DiscussionMappingStore({ persistPath: join(dir, 'mappings.jsonl') });
  if (withMapping) discussionStore.ingest([{
    channelChatId: -1001, channelMessageId: 50, discussionChatId: -1002, discussionMessageId: 60
  }]);
  const config = parseServiceConfig({
    ALPHA_WALLET_PRIVATE_KEY: '0xabc', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: '-1001',
    DISCUSSION_CHAT_ID: '-1002', XAI_API_KEY: 'standard-key', XAI_MODEL: 'grok-4.3',
    XAI_BASE_URL: 'https://standard.example', XAI_DEEP_API_KEY: 'deep-key'
  });
  const analyze = vi.fn().mockResolvedValue('深度报告 https://example.com');
  const reply = vi.fn().mockResolvedValue({ chatId: -1002, messageId: 61 });
  const trigger = vi.fn((options: TriggerDeepAnalysisOptions) => triggerDeepAnalysisComment({
    ...options, analyze, reply, loadSkill: async () => '测试深度模板'
  }));
  const options = { config, queue, archiveStore, discussionStore, trigger, info: vi.fn(), warn: vi.fn() };
  const enqueue = (input = task) => enqueueDeepAnalysisTask({ ...options, task: input });
  const process = async (record?: AnalysisTaskRecord) => processDeepAnalysisTask({
    ...options, task: record ?? (await queue.listAll()).find((row) => row.kind === 'deep')!
  });
  return { ...options, dir, queueOptions, archiveOptions, analyze, reply, enqueue, process };
}

describe('five-star deep task lifecycle', () => {
  it('does not enqueue below five stars or when the deep channel/discussion is disabled', async () => {
    const context = await fixture();
    await expect(context.enqueue({ ...task, star: 4 })).resolves.toBe(false);
    await expect(enqueueDeepAnalysisTask({
      ...context, task, config: { ...context.config, deepAnalysis: undefined }
    })).resolves.toBe(false);
    await expect(enqueueDeepAnalysisTask({
      ...context, task, config: { ...context.config, discussionChatId: undefined }
    })).resolves.toBe(false);
    await expect(context.queue.listAll()).resolves.toEqual([]);
  });

  it.each(['direct five-star arrival', 'four-to-five transition'])('enqueues once on %s and retains the first message', async (scenario) => {
    const context = await fixture();
    if (scenario === 'four-to-five transition') await context.enqueue({ ...task, star: 4 });
    await expect(context.enqueue()).resolves.toBe(true);
    await expect(context.enqueue({ ...task, channelMessageId: 51 })).resolves.toBe(false);
    expect(await context.queue.listAll()).toMatchObject([{
      taskKey: '-1001:50:deep', kind: 'deep', channelMessageId: 50, star: 5
    }]);
  });

  it('waits for the first message mapping even when a later five-star message is mapped', async () => {
    const context = await fixture(false);
    await context.enqueue();
    context.discussionStore.ingest([{
      channelChatId: -1001, channelMessageId: 51, discussionChatId: -1002, discussionMessageId: 70
    }]);
    await expect(context.enqueue({ ...task, channelMessageId: 51 })).resolves.toBe(false);
    await expect(context.process()).resolves.toEqual({ status: 'retry', reason: 'discussion mapping pending' });
    expect(context.analyze).not.toHaveBeenCalled();
    expect(context.reply).not.toHaveBeenCalled();
  });

  it('uses the independent model with prior standard context and leaves standard tracking unchanged', async () => {
    const context = await fixture();
    await context.archiveStore.upsert({
      ...task, version: 1, recordType: 'analysis', sourceTaskKey: '-1001:10',
      archivedAt: '2026-09-13T04:00:00.000Z', analysisCreatedAt: '2026-09-13T04:00:00.000Z',
      channelMessage: { chatId: -1001, messageId: 10 },
      discussionAnalysisMessage: { chatId: '-1002', messageId: 20 },
      analysisText: 'grok-4.3 标准分析正文'
    });
    await context.enqueue();
    await expect(context.process()).resolves.toEqual({ status: 'done' });
    expect(context.trigger).toHaveBeenCalledWith(expect.objectContaining({
      xaiApiKey: 'deep-key', xaiBaseUrl: 'https://api.fengshao1227.com',
      xaiModel: 'grok-4.20-multi-agent-0309', previousAnalysisText: 'grok-4.3 标准分析正文'
    }));
    expect(context.config.xaiModel).toBe('grok-4.3');
    expect(context.analyze.mock.calls[0][0]).toContain('grok-4.3 标准分析正文');
    await expect(context.archiveStore.listAnalysisTrackerEntries()).resolves.toEqual([
      ['project_a', { discussionChatId: '-1002', analysisMessageId: 20 }]
    ]);
    await expect(context.archiveStore.getFirstDeepAnalysis('project_a')).resolves.toMatchObject({
      sourceTaskKey: '-1001:50:deep', channelMessage: { chatId: -1001, messageId: 50 },
      discussionAnalysisMessage: { chatId: -1002, messageId: 61 },
      analysisText: '深度报告 https://example.com'
    });
  });

  it('skips a completed project after archive and service restart', async () => {
    const context = await fixture();
    await context.enqueue();
    const originalTask = (await context.queue.listAll())[0];
    await context.process(originalTask);
    await context.queue.remove(originalTask.taskKey);
    const archiveStore = new AnalysisArchiveStore(context.archiveOptions);
    const queue = new AnalysisTaskQueue(context.queueOptions);
    await expect(enqueueDeepAnalysisTask({ ...context, queue, archiveStore, task })).resolves.toBe(false);
    await expect(processDeepAnalysisTask({ ...context, queue, archiveStore, task: originalTask })).resolves.toEqual({ status: 'done' });
    expect(context.analyze).toHaveBeenCalledOnce();
    expect(context.reply).toHaveBeenCalledOnce();
  });

  it('recovers persisted report and partial delivery after restart without calling the model twice', async () => {
    const context = await fixture();
    context.analyze.mockResolvedValue('甲'.repeat(4000));
    context.reply.mockResolvedValueOnce({ chatId: -1002, messageId: 61 })
      .mockRejectedValueOnce(new Error('Telegram unavailable'))
      .mockResolvedValueOnce({ chatId: -1002, messageId: 62 });
    await context.enqueue();
    await expect(context.process()).rejects.toThrow('Telegram unavailable');
    await expect(context.archiveStore.getFirstDeepAnalysis('project_a')).resolves.toBeNull();

    const queue = new AnalysisTaskQueue(context.queueOptions);
    const [recovered] = await queue.listAll();
    expect(recovered.deepProgress?.sentMessages).toEqual([{ chatId: -1002, messageId: 61 }]);
    const discussionStore = new DiscussionMappingStore({ persistPath: join(context.dir, 'empty-mappings.jsonl') });
    await expect(processDeepAnalysisTask({ ...context, queue, discussionStore, task: recovered })).resolves.toEqual({ status: 'done' });
    expect(context.analyze).toHaveBeenCalledOnce();
    expect(context.reply).toHaveBeenCalledTimes(3);
    expect(context.reply.mock.calls[2][0]).toMatchObject({
      chatId: '-1002', replyToMessageId: 60, text: context.reply.mock.calls[1][0].text
    });
    await expect(context.archiveStore.getFirstDeepAnalysis('project_a')).resolves.toMatchObject({
      analysisCreatedAt: recovered.deepProgress!.analysisCreatedAt, analysisText: '甲'.repeat(4000)
    });
  });

  it('retries archive persistence without another model request or Telegram send', async () => {
    const context = await fixture();
    await context.enqueue();
    vi.spyOn(context.archiveStore, 'upsert').mockRejectedValueOnce(new Error('archive disk full'));
    await expect(context.process()).rejects.toThrow('archive disk full');
    await expect(context.process()).resolves.toEqual({ status: 'done' });
    expect(context.analyze).toHaveBeenCalledOnce();
    expect(context.reply).toHaveBeenCalledOnce();
  });

  it('does not require the standard API key for an already queued deep task', async () => {
    const context = await fixture();
    await context.enqueue();
    context.config.xaiApiKey = undefined;
    await expect(context.process()).resolves.toEqual({ status: 'done' });
    expect(context.trigger.mock.calls[0][0].xaiApiKey).toBe('deep-key');
  });
});
