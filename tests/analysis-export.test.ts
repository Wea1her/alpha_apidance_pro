import { describe, expect, it } from 'vitest';
import {
  buildAnalysisExport,
  buildAnalysisExportFilename,
  isExportAuthorized,
  parseShanghaiHourRange
} from '../src/analysis-export.js';
import type { AnalysisArchiveRecord } from '../src/analysis-archive-store.js';

function analysisRecord(overrides: Partial<Extract<AnalysisArchiveRecord, { recordType: 'analysis' }>> = {}) {
  return {
    version: 1 as const,
    recordType: 'analysis' as const,
    sourceTaskKey: 'a:1',
    projectKey: 'project-a',
    title: 'Project A',
    content: '你关注的12个用户也关注了ta',
    link: 'https://x.com/project_a',
    mainPushedAt: '2026-05-20T01:00:00.000Z',
    archivedAt: '2026-05-20T01:01:00.000Z',
    analysisCreatedAt: '2026-05-20T01:01:00.000Z',
    star: 3,
    count: 12,
    channelMessage: { chatId: -1001111111111, messageId: 10 },
    discussionAnalysisMessage: { chatId: '-1002222222222', messageId: 20 },
    analysisText: 'Project A 完整分析\n\n第二段不应被截断。',
    ...overrides
  };
}

function hitRecord(overrides: Partial<Extract<AnalysisArchiveRecord, { recordType: 'hit' }>> = {}) {
  return {
    version: 1 as const,
    recordType: 'hit' as const,
    sourceTaskKey: 'a:2',
    projectKey: 'project-a',
    title: 'Project A 再次命中',
    content: '你关注的20个用户也关注了ta',
    link: 'https://x.com/project_a',
    mainPushedAt: '2026-05-20T03:00:00.000Z',
    archivedAt: '2026-05-20T03:01:00.000Z',
    star: 5,
    count: 20,
    channelMessage: { chatId: -1001111111111, messageId: 11 },
    discussionAnalysisMessage: { chatId: '-1002222222222', messageId: 20 },
    reminderMessage: { chatId: -1002222222222, messageId: 21 },
    ...overrides
  };
}

describe('parseShanghaiHourRange', () => {
  it('parses inclusive Shanghai hour range', () => {
    expect(parseShanghaiHourRange('2026-05-20T09', '2026-05-20T18')).toEqual({
      from: new Date('2026-05-20T01:00:00.000Z'),
      to: new Date('2026-05-20T10:59:59.999Z'),
      fromLabel: '2026-05-20 09:00',
      toLabel: '2026-05-20 18:59'
    });
  });

  it('rejects invalid format and reversed ranges', () => {
    expect(() => parseShanghaiHourRange('2026-05-20 09', '2026-05-20T18')).toThrow(
      '时间格式必须是 YYYY-MM-DDTHH'
    );
    expect(() => parseShanghaiHourRange('2026-05-20T19', '2026-05-20T18')).toThrow('开始时间不能晚于结束时间');
  });
});

describe('isExportAuthorized', () => {
  it('normalizes chat id and username authorization', () => {
    expect(isExportAuthorized({ chatId: '-1001', username: undefined }, [], ['-1001'])).toBe(true);
    expect(isExportAuthorized({ chatId: '-1002', username: '@Alice' }, ['alice'], [])).toBe(true);
    expect(isExportAuthorized({ chatId: '-1002', username: 'alice' }, ['@ALICE'], [])).toBe(true);
    expect(isExportAuthorized({ chatId: '-1002', username: 'mallory' }, ['alice'], ['-1001'])).toBe(false);
  });
});

describe('buildAnalysisExport', () => {
  it('groups projects by highest star and keeps full analysis text', () => {
    const range = parseShanghaiHourRange('2026-05-20T09', '2026-05-20T12');
    const result = buildAnalysisExport(
      [analysisRecord(), hitRecord()],
      range,
      new Date('2026-05-20T05:40:00.000Z')
    );

    expect(result.projectCount).toBe(1);
    expect(result.markdown).toContain('时间范围：2026-05-20 09:00 ~ 2026-05-20 12:59（Asia/Shanghai）');
    expect(result.markdown).toContain('导出时间：2026-05-20 13:40');
    expect(result.markdown).toContain('## 5 星项目（1 个）');
    expect(result.markdown).toContain('### 1. Project A');
    expect(result.markdown).toContain('- 最高监控池关注数：20');
    expect(result.markdown).toContain('Project A 完整分析\n\n第二段不应被截断。');
    expect(result.markdown).toContain('- 2026-05-20 09:00，3 星，监控池关注数 12');
    expect(result.markdown).toContain('- 2026-05-20 11:00，5 星，监控池关注数 20');
  });

  it('merges records by projectKey and renders multiple projects under one star group', () => {
    const range = parseShanghaiHourRange('2026-05-20T09', '2026-05-20T12');
    const records: AnalysisArchiveRecord[] = [
      analysisRecord(),
      hitRecord(),
      analysisRecord({
        sourceTaskKey: 'b:1',
        projectKey: 'project-b',
        title: 'Project B',
        link: 'https://x.com/project_b',
        star: 5,
        count: 18,
        analysisText: 'Project B 完整分析',
        channelMessage: { chatId: -1001111111111, messageId: 12 },
        discussionAnalysisMessage: { chatId: '-1002222222222', messageId: 22 }
      })
    ];

    const result = buildAnalysisExport(records, range);

    expect(result.projectCount).toBe(2);
    expect(result.markdown).toContain('## 5 星项目（2 个）');
    expect(result.markdown).toContain('### 1. Project A');
    expect(result.markdown).toContain('### 2. Project B');
    expect(result.markdown).not.toContain('## 3 星项目');
  });

  it('sorts same-star projects by highest count descending', () => {
    const range = parseShanghaiHourRange('2026-05-20T09', '2026-05-20T12');
    const result = buildAnalysisExport(
      [
        analysisRecord({ projectKey: 'low', title: 'Low Count', sourceTaskKey: 'low:1', star: 5, count: 10 }),
        analysisRecord({ projectKey: 'high', title: 'High Count', sourceTaskKey: 'high:1', star: 5, count: 30 })
      ],
      range
    );

    expect(result.markdown.indexOf('### 1. High Count')).toBeLessThan(result.markdown.indexOf('### 2. Low Count'));
  });

  it('uses deterministic tie breakers for same count projects', () => {
    const range = parseShanghaiHourRange('2026-05-20T09', '2026-05-20T12');
    const result = buildAnalysisExport(
      [
        analysisRecord({
          projectKey: 'later',
          title: 'Later Project',
          sourceTaskKey: 'later:1',
          mainPushedAt: '2026-05-20T02:00:00.000Z',
          star: 5,
          count: 10
        }),
        analysisRecord({
          projectKey: 'earlier',
          title: 'Earlier Project',
          sourceTaskKey: 'earlier:1',
          mainPushedAt: '2026-05-20T01:30:00.000Z',
          star: 5,
          count: 10
        })
      ],
      range
    );

    expect(result.markdown.indexOf('### 1. Earlier Project')).toBeLessThan(
      result.markdown.indexOf('### 2. Later Project')
    );
  });

  it('omits projects with no Grok analysis even when hits are in range', () => {
    const range = parseShanghaiHourRange('2026-05-20T09', '2026-05-20T12');
    const result = buildAnalysisExport([hitRecord({ projectKey: 'hit-only', sourceTaskKey: 'hit-only:1' })], range);

    expect(result.projectCount).toBe(0);
    expect(result.markdown).not.toContain('hit-only');
  });

  it('uses the earliest original analysis text even when it is outside the selected range', () => {
    const range = parseShanghaiHourRange('2026-05-20T10', '2026-05-20T12');
    const result = buildAnalysisExport(
      [
        analysisRecord({
          sourceTaskKey: 'a:old',
          mainPushedAt: '2026-05-20T00:00:00.000Z',
          analysisText: '最早完整分析'
        }),
        analysisRecord({
          sourceTaskKey: 'a:new',
          mainPushedAt: '2026-05-20T02:00:00.000Z',
          analysisText: '范围内较晚分析'
        })
      ],
      range
    );

    expect(result.projectCount).toBe(1);
    expect(result.markdown).toContain('最早完整分析');
    expect(result.markdown).not.toContain('范围内较晚分析');
    expect(result.markdown).toContain('- 2026-05-20 10:00，3 星，监控池关注数 12');
  });

  it('returns a useful Markdown document for empty results', () => {
    const range = parseShanghaiHourRange('2026-05-20T09', '2026-05-20T12');
    const result = buildAnalysisExport([], range, new Date('2026-05-20T05:40:00.000Z'));

    expect(result.projectCount).toBe(0);
    expect(result.markdown).toContain('# Alpha 项目分析导出');
    expect(result.markdown).toContain('项目数：0');
    expect(result.markdown).toContain('该时间段没有已完成 Grok 分析的项目。');
  });
});

describe('buildAnalysisExportFilename', () => {
  it('builds a stable markdown filename from the requested hour range', () => {
    const range = parseShanghaiHourRange('2026-05-20T09', '2026-05-20T18');

    expect(buildAnalysisExportFilename(range)).toBe('alpha-analysis-2026-05-20T09-2026-05-20T18.md');
  });
});
