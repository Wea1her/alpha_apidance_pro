import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisArchiveStore, type AnalysisArchiveRecord } from '../src/analysis-archive-store.js';

async function tempPath(name = 'analysis-archive.jsonl'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'analysis-archive-'));
  return join(dir, name);
}

const analysisRecord = {
  version: 1 as const,
  recordType: 'analysis' as const,
  sourceTaskKey: '-1001:10',
  projectKey: 'project-a',
  title: 'A 关注了 Project A',
  content: '你关注的12个用户也关注了ta',
  link: 'https://x.com/project_a',
  mainPushedAt: '2026-05-20T02:00:00.000Z',
  archivedAt: '2026-05-20T02:01:00.000Z',
  analysisCreatedAt: '2026-05-20T02:01:00.000Z',
  star: 3,
  count: 12,
  channelMessage: { chatId: -1001, messageId: 10 },
  discussionAnalysisMessage: { chatId: '-1002', messageId: 20 },
  analysisText: '完整分析'
};

describe('AnalysisArchiveStore', () => {
  it('upserts archive records by sourceTaskKey', async () => {
    const filePath = await tempPath();
    const store = new AnalysisArchiveStore({ filePath });

    await expect(store.listAll()).resolves.toEqual([]);
    await store.upsert(analysisRecord);
    await store.upsert({
      ...analysisRecord,
      title: 'A 关注了 Project A 更新',
      count: 13
    });

    await expect(store.listAll()).resolves.toEqual([
      {
        ...analysisRecord,
        title: 'A 关注了 Project A 更新',
        count: 13
      }
    ]);

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('skips invalid JSONL lines with a warning', async () => {
    const filePath = await tempPath();
    await writeFile(filePath, `${JSON.stringify(analysisRecord)}\n{bad json\n`, 'utf8');
    const warn = vi.fn();
    const store = new AnalysisArchiveStore({ filePath, warn });

    await expect(store.listAll()).resolves.toEqual([analysisRecord]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('跳过无效分析归档行');
  });

  it('finds the first analysis record for a project', async () => {
    const filePath = await tempPath();
    const laterRecord: AnalysisArchiveRecord = {
      ...analysisRecord,
      sourceTaskKey: '-1001:11',
      mainPushedAt: '2026-05-20T03:00:00.000Z'
    };
    const earliestRecord: AnalysisArchiveRecord = {
      ...analysisRecord,
      sourceTaskKey: '-1001:9',
      mainPushedAt: '2026-05-20T01:00:00.000Z',
      discussionAnalysisMessage: { chatId: -1002, messageId: 19 }
    };
    const hitRecord: AnalysisArchiveRecord = {
      version: 1,
      recordType: 'hit',
      sourceTaskKey: '-1001:8',
      projectKey: 'project-a',
      title: 'A 又被关注',
      content: '你关注的13个用户也关注了ta',
      link: 'https://x.com/project_a',
      mainPushedAt: '2026-05-20T00:00:00.000Z',
      archivedAt: '2026-05-20T00:01:00.000Z',
      star: 3,
      count: 13,
      channelMessage: { chatId: -1001, messageId: 8 },
      discussionAnalysisMessage: { chatId: '-1002', messageId: 18 }
    };
    const store = new AnalysisArchiveStore({ filePath });

    await store.upsert(laterRecord);
    await store.upsert(hitRecord);
    await store.upsert(earliestRecord);

    await expect(store.getFirstAnalysis('project-a')).resolves.toEqual(earliestRecord);
    await expect(store.hasAnalysis('project-a')).resolves.toBe(true);
    await expect(store.getFirstAnalysis('project-b')).resolves.toBeNull();
    await expect(store.hasAnalysis('project-b')).resolves.toBe(false);
  });

  it('hydrates analysis tracker entries from analysis records', async () => {
    const filePath = await tempPath();
    const store = new AnalysisArchiveStore({ filePath });
    await store.upsert({
      ...analysisRecord,
      sourceTaskKey: '-1001:11',
      mainPushedAt: '2026-05-20T03:00:00.000Z',
      discussionAnalysisMessage: { chatId: -1002, messageId: 21 }
    });
    await store.upsert(analysisRecord);
    await store.upsert({
      ...analysisRecord,
      sourceTaskKey: '-1001:12',
      projectKey: 'project-b',
      discussionAnalysisMessage: { chatId: '-1003', messageId: 30 }
    });

    await expect(store.listAnalysisTrackerEntries()).resolves.toEqual([
      ['project-a', { discussionChatId: '-1002', analysisMessageId: 20 }],
      ['project-b', { discussionChatId: '-1003', analysisMessageId: 30 }]
    ]);
  });
});
