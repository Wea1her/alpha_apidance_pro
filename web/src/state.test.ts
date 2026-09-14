import { describe, expect, it } from 'vitest';
import {
  POLL_INTERVAL_MS,
  advancePagination,
  auditActionLabel,
  joinedAfterIso,
  appendPage,
  canLoadMore,
  describeListState,
  describeLoadedCount,
  formatRelativeTime,
  identifyRow,
  isNewerVersion,
  reasonLabel,
  resolveInitialTheme,
  sourceLabel,
  starLabel
} from './state.js';
import { buildQuery } from './api.js';

/** 前端纯逻辑测试（Q14 版本去重、Q25 轮询间隔、Q94 主题、F11 空态与异常区分）。 */

describe('轮询间隔（Q25）', () => {
  it('列表与运行状态用 2 秒，详情用 5 秒', () => {
    expect(POLL_INTERVAL_MS.list).toBe(2_000);
    expect(POLL_INTERVAL_MS.detail).toBe(5_000);
  });
});

describe('实体版本比较（Q14 去重）', () => {
  it('首次拿到版本视为有新数据', () => {
    expect(isNewerVersion(null, '100-0')).toBe(true);
  });

  it('时间戳更大或同批次序号更大都算新版本', () => {
    expect(isNewerVersion('100-0', '200-0')).toBe(true);
    expect(isNewerVersion('100-0', '100-3')).toBe(true);
  });

  it('相同或更旧的版本不算新数据', () => {
    expect(isNewerVersion('100-3', '100-3')).toBe(false);
    expect(isNewerVersion('200-0', '100-9')).toBe(false);
  });

  it('无法解析的版本保守地当作有新数据（宁可多渲染，不丢更新）', () => {
    expect(isNewerVersion('garbage', '100-0')).toBe(true);
    expect(isNewerVersion('100-0', 'garbage')).toBe(true);
  });

  it('空版本不触发刷新', () => {
    expect(isNewerVersion('100-0', null)).toBe(false);
  });
});

describe('行标识', () => {
  it('按实体类型区分，保证版本去重比较的是同一条记录', () => {
    expect(identifyRow({ version: '1-0', projectId: 'p1' } as never)).toBe('project:p1');
    expect(identifyRow({ version: '1-0', decisionId: 'd1' } as never)).toBe('decision:d1');
    expect(identifyRow({ version: '1-0' } as never)).toBe('row:1-0');
  });
});

describe('主题（Q94）', () => {
  it('本地偏好优先于系统偏好', () => {
    expect(resolveInitialTheme('dark', false)).toBe('dark');
    expect(resolveInitialTheme('light', true)).toBe('light');
  });

  it('没有本地偏好时跟随系统', () => {
    expect(resolveInitialTheme(null, true)).toBe('dark');
    expect(resolveInitialTheme(null, false)).toBe('light');
    expect(resolveInitialTheme('bogus', true)).toBe('dark');
  });
});

describe('时间与文案', () => {
  const now = new Date('2026-09-14T12:00:00.000Z');

  it('相对时间覆盖秒/分/时/天', () => {
    expect(formatRelativeTime('2026-09-14T11:59:30.000Z', now)).toBe('30 秒前');
    expect(formatRelativeTime('2026-09-14T11:30:00.000Z', now)).toBe('30 分钟前');
    expect(formatRelativeTime('2026-09-14T09:00:00.000Z', now)).toBe('3 小时前');
    expect(formatRelativeTime('2026-09-11T12:00:00.000Z', now)).toBe('3 天前');
  });

  it('缺失与异常时间不伪造“刚刚”', () => {
    expect(formatRelativeTime(null, now)).toBe('无记录');
    expect(formatRelativeTime('not-a-date', now)).toBe('时间无效');
  });

  it('原因码与来源有中文说明，未知值原样返回', () => {
    expect(reasonLabel('BELOW_THRESHOLD')).toBe('未达到推送门槛');
    expect(reasonLabel('CLASSIFY_ERROR_ALLOWED')).toBe('分类异常后保守放行');
    expect(reasonLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(sourceLabel('restored')).toBe('恢复入池');
    expect(sourceLabel('other')).toBe('other');
  });

  it('星级文案区分未达门槛', () => {
    expect(starLabel(0)).toBe('未达门槛');
    expect(starLabel(3)).toContain('3 星');
  });
});

describe('列表状态区分“无数据”与“服务异常”（F11）', () => {
  it('加载中与异常与空数据互不混淆', () => {
    expect(describeListState({ loading: true, error: null, rowCount: 0 }).tone).toBe('loading');
    expect(describeListState({ loading: false, error: new Error('连接中断'), rowCount: 0 }).tone).toBe('error');
    expect(describeListState({ loading: false, error: null, rowCount: 0 }).tone).toBe('empty');
    expect(describeListState({ loading: false, error: null, rowCount: 5 }).tone).toBe('ok');
  });

  it('异常状态优先于空数据：不能把服务异常显示成“没有记录”', () => {
    const state = describeListState({ loading: false, error: new Error('connection terminated'), rowCount: 0 });
    expect(state.text).toContain('数据服务异常');
    expect(state.text).not.toContain('没有记录');
  });
});

describe('查询串构造', () => {
  it('跳过空值，数组用逗号连接，布尔转字符串', () => {
    expect(buildQuery({ limit: 50, cursor: null, search: undefined, stars: [3, 5] })).toBe('?limit=50&stars=3%2C5');
    expect(buildQuery({ hasCa: true })).toBe('?hasCa=true');
    expect(buildQuery({ search: '' })).toBe('');
    expect(buildQuery({ stars: [] })).toBe('');
  });
});

describe('详情页时间线状态归纳（第 6 节状态表）', () => {
  it('没有记录时明确说明“不代表被过滤”', async () => {
    const { summarizeTimelineState } = await import('./ProjectDetailView.js');
    const state = summarizeTimelineState([]);
    expect(state.tone).toBe('empty');
    expect(state.text).toContain('不代表账号被过滤');
  });

  it('区分拦截、推送、等待与失败', async () => {
    const { summarizeTimelineState } = await import('./ProjectDetailView.js');
    expect(summarizeTimelineState(['CLASSIFY_BLOCKED']).tone).toBe('blocked');
    expect(summarizeTimelineState(['PUSHED']).tone).toBe('pushed');
    expect(summarizeTimelineState(['ANALYSIS_QUEUED']).tone).toBe('waiting');
    expect(summarizeTimelineState(['SEND_FAILED']).tone).toBe('failed');
    expect(summarizeTimelineState(['BELOW_THRESHOLD']).text).toContain('尚未达到推送门槛');
  });

  it('失败优先于其它状态：不能把失败记录显示成正常', async () => {
    const { summarizeTimelineState } = await import('./ProjectDetailView.js');
    expect(summarizeTimelineState(['PUSHED', 'PARSE_ERROR']).tone).toBe('failed');
  });
});

describe('配置变更文案（Q102）', () => {
  it('首次记录与无变化有专门措辞', async () => {
    const { describeConfigChange } = await import('./state.js');
    expect(describeConfigChange(['（首次记录）'])).toBe('首次记录');
    expect(describeConfigChange([])).toBe('与上一版一致');
  });

  it('差异字段翻成中文，未知字段原样保留', async () => {
    const { describeConfigChange, configFieldLabel } = await import('./state.js');
    expect(configFieldLabel('starLevels')).toBe('星级阈值');
    expect(configFieldLabel('unknownField')).toBe('unknownField');
    const text = describeConfigChange(['starLevels', 'deepModel']);
    expect(text).toContain('星级阈值');
    expect(text).toContain('深度分析模型');
  });
});

describe('排查结论（Q100、第 6 节状态表）', () => {
  it('查不到账号时明确说明不代表被过滤', async () => {
    const { describeDiagnosis } = await import('./state.js');
    const result = describeDiagnosis({ found: false, timeline: [] });
    expect(result.tone).toBe('not_found');
    expect(result.text).toContain('不代表账号被过滤');
  });

  it('有项目但无判定记录时说明历史数据可能缺失', async () => {
    const { describeDiagnosis } = await import('./state.js');
    const result = describeDiagnosis({ found: true, timeline: [] });
    expect(result.tone).toBe('no_record');
    expect(result.text).toContain('历史数据可能缺失');
  });

  it('区分被拦截、已推送与未达门槛', async () => {
    const { describeDiagnosis } = await import('./state.js');
    expect(describeDiagnosis({ found: true, timeline: [{ reasonCode: 'CLASSIFY_BLOCKED' }] }).tone).toBe('blocked');
    expect(describeDiagnosis({ found: true, timeline: [{ reasonCode: 'PUSHED' }] }).tone).toBe('pushed');
    expect(describeDiagnosis({ found: true, timeline: [{ reasonCode: 'BELOW_THRESHOLD' }] }).tone).toBe('below');
  });

  it('失败记录优先于其它结论', async () => {
    const { describeDiagnosis } = await import('./state.js');
    expect(describeDiagnosis({ found: true, timeline: [{ reasonCode: 'PUSHED' }, { reasonCode: 'SEND_FAILED' }] }).tone).toBe('failed');
  });
});

describe('运行状态告警摘要（Q101）', () => {
  const base = {
    lastInboundAt: '2026-09-14T12:00:00.000Z',
    deadLetterJobs: 0,
    abandonedDeliveries: 0,
    uncertainDeliveries: 0,
    failedJobs: 0
  };
  const now = new Date('2026-09-14T12:05:00.000Z');

  it('一切正常时没有告警', async () => {
    const { summarizeHealth } = await import('./state.js');
    expect(summarizeHealth({ ...base, now })).toEqual([]);
  });

  it('采集静默超阈值给出紧急告警', async () => {
    const { summarizeHealth } = await import('./state.js');
    const items = summarizeHealth({ ...base, lastInboundAt: '2026-09-14T11:00:00.000Z', now });
    expect(items[0]).toMatchObject({ level: 'alert' });
    expect(items[0]?.text).toContain('采集静默');
  });

  it('没有收到过任何事件时是提示而不是紧急', async () => {
    const { summarizeHealth } = await import('./state.js');
    const items = summarizeHealth({ ...base, lastInboundAt: null, now });
    expect(items[0]).toMatchObject({ level: 'warn' });
  });

  it('死信与已放弃投递是紧急，不确定投递与失败任务是提示', async () => {
    const { summarizeHealth } = await import('./state.js');
    const items = summarizeHealth({
      ...base,
      now,
      deadLetterJobs: 2,
      abandonedDeliveries: 1,
      uncertainDeliveries: 3,
      failedJobs: 4
    });
    const byLevel = (level: string): string[] => items.filter((item) => item.level === level).map((item) => item.text);
    expect(byLevel('alert').join()).toContain('死信');
    expect(byLevel('alert').join()).toContain('已放弃');
    expect(byLevel('warn').join()).toContain('结果不确定');
    expect(byLevel('warn').join()).toContain('失败任务');
  });
});

describe('喊单条目的展示规则（Q117）', () => {
  it('互动数缺失显示“未提供”，不显示 0', async () => {
    const { formatMetric } = await import('./TweetFeedColumn.js');
    expect(formatMetric(0)).toBe('0');
    expect(formatMetric(12)).toBe('12');
    expect(formatMetric(null)).toBe('未提供');
  });

  it('摘要状态有明确文案：完成用摘要、失败说明不可用、进行中说明生成中', async () => {
    const { summaryText } = await import('./TweetFeedColumn.js');
    expect(summaryText({ summaryStatus: 'done', summaryText: '某人在喊单。' })).toBe('某人在喊单。');
    expect(summaryText({ summaryStatus: 'failed', summaryText: null })).toContain('摘要不可用');
    expect(summaryText({ summaryStatus: 'pending', summaryText: null })).toContain('生成中');
  });
});

/**
 * 游标分页累积（Q95）。
 *
 * 这组用例守住三个容易写错的地方：
 * 1) 轮询刷新第一页时，已加载的后续页不能被挤掉；
 * 2) 同一行重复到达要按 id 去重，并让新版本覆盖旧版本、位置不变；
 * 3) 没有游标或仍在加载时不能重复发请求（否则会重复拉同一页）。
 */
interface Row {
  projectId: string;
  star: number;
}

describe('游标分页累积（Q95）', () => {
  it('追加新页时保留已加载的行，新行按顺序接到末尾', () => {
    const loaded: Row[] = [
      { projectId: 'a', star: 1 },
      { projectId: 'b', star: 2 }
    ];
    const merged = appendPage(loaded, [
      { projectId: 'c', star: 3 },
      { projectId: 'd', star: 4 }
    ]);
    expect(merged.map((row) => row.projectId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('轮询刷新第一页时不挤掉后续页，且用新版本覆盖旧行（位置不变）', () => {
    const loaded: Row[] = [
      { projectId: 'a', star: 1 },
      { projectId: 'b', star: 2 },
      { projectId: 'c', star: 3 }
    ];
    // 第一页刷新后 b 升到 5 星，a 不变，没有新行
    const merged = appendPage(loaded, [
      { projectId: 'a', star: 1 },
      { projectId: 'b', star: 5 }
    ]);
    expect(merged.map((row) => row.projectId)).toEqual(['a', 'b', 'c']);
    expect(merged[1]?.star).toBe(5);
    expect(merged).toHaveLength(3);
  });

  it('同一页内重复的 id 只保留一条', () => {
    const merged = appendPage<Row>([], [
      { projectId: 'a', star: 1 },
      { projectId: 'a', star: 2 }
    ]);
    expect(merged).toHaveLength(1);
  });

  it('空输入不产生副作用', () => {
    expect(appendPage([], [])).toEqual([]);
    const loaded: Row[] = [{ projectId: 'a', star: 1 }];
    expect(appendPage(loaded, [])).toHaveLength(1);
    expect(appendPage<Row>([], [{ projectId: 'b', star: 2 }])).toHaveLength(1);
  });

  it('只有“还有数据 + 不在加载 + 有游标”三个条件同时满足才继续加载', () => {
    expect(canLoadMore({ hasMore: true, loading: false, cursor: 'cursor-1' })).toBe(true);
    expect(canLoadMore({ hasMore: false, loading: false, cursor: 'cursor-1' })).toBe(false);
    expect(canLoadMore({ hasMore: true, loading: true, cursor: 'cursor-1' })).toBe(false);
    expect(canLoadMore({ hasMore: true, loading: false, cursor: null })).toBe(false);
    expect(canLoadMore({ hasMore: true, loading: false, cursor: '' })).toBe(false);
  });

  it('进度文案区分“还有更多”与“已全部加载”', () => {
    expect(describeLoadedCount(50, true)).toContain('继续加载');
    expect(describeLoadedCount(50, false)).toContain('已全部加载');
    expect(describeLoadedCount(0, false)).toContain('0');
  });
});

describe('分页位置推进（轮询不得回退游标）', () => {
  it('轮询刷新第一页时保持游标与 hasMore 不变', () => {
    const previous = { cursor: 'cursor-page-3', hasMore: true };
    const result = advancePagination({
      mode: 'merge',
      previous,
      // 第一页响应里的 nextCursor 指向第 2 页——用它覆盖就会让滚动加载退回第 2 页
      page: { nextCursor: 'cursor-page-2', hasMore: true }
    });
    expect(result).toEqual(previous);
  });

  it('首屏与追加会推进游标', () => {
    const previous = { cursor: 'cursor-page-1', hasMore: true };
    expect(advancePagination({ mode: 'replace', previous, page: { nextCursor: 'cursor-page-2', hasMore: true } })).toEqual({
      cursor: 'cursor-page-2',
      hasMore: true
    });
    expect(advancePagination({ mode: 'more', previous, page: { nextCursor: 'cursor-page-3', hasMore: true } })).toEqual({
      cursor: 'cursor-page-3',
      hasMore: true
    });
    // 末页：hasMore 变 false，停止继续加载
    expect(advancePagination({ mode: 'more', previous, page: { nextCursor: null, hasMore: false } })).toEqual({
      cursor: null,
      hasMore: false
    });
  });

  it('回归场景：连续轮询 5 次后游标仍停在第 3 页，滚动加载还能继续', () => {
    let position: { cursor: string | null; hasMore: boolean } = { cursor: 'cursor-page-2', hasMore: true };
    position = advancePagination({ mode: 'more', previous: position, page: { nextCursor: 'cursor-page-3', hasMore: true } });
    for (let i = 0; i < 5; i += 1) {
      position = advancePagination({
        mode: 'merge',
        previous: position,
        page: { nextCursor: 'cursor-page-2', hasMore: true }
      });
    }
    expect(position.cursor).toBe('cursor-page-3');
    expect(canLoadMore({ hasMore: position.hasMore, loading: false, cursor: position.cursor })).toBe(true);
  });
});

describe('审计与筛选的纯逻辑（Q62、Q105）', () => {
  it('已知审计动作有中文说明，未知动作原样显示不猜测', () => {
    expect(auditActionLabel('project.exclude')).toBe('项目移入排除池');
    expect(auditActionLabel('delivery.replay')).toBe('投递重放');
    // 未收录的动作必须原样透出，避免出现编造的中文含义
    expect(auditActionLabel('unknown.action')).toBe('unknown.action');
  });

  it('加入时间筛选项换算成起点时间，全部则不过滤', () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    expect(joinedAfterIso('all', now)).toBeNull();
    expect(joinedAfterIso('7d', now)).toBe('2026-09-07T00:00:00.000Z');
    expect(joinedAfterIso('30d', now)).toBe('2026-08-15T00:00:00.000Z');
  });
});
