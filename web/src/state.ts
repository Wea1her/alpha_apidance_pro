import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageInfo, VersionedRow } from './api.js';

/**
 * 轮询与状态管理（Q14、Q25、Q92）。
 *
 * 依据：
 * - Q14：首版以轮询 + 实体版本号去重实现状态刷新，SSE 为二期；
 * - Q25：列表页与运行状态页 2 秒、项目详情页 5 秒；标签页不可见时暂停轮询；
 * - 页面刷新不得触发模型调用或创建任务（第 8 节）——本模块只做读取。
 */

export const POLL_INTERVAL_MS = {
  /** 列表页与运行状态页（Q25）。 */
  list: 2_000,
  /** 项目详情页（Q25）。 */
  detail: 5_000,
  /** 健康/运维类信息变化慢，用更长的间隔，避免无谓请求。 */
  health: 5_000
} as const;

/**
 * 版本比较：服务端版本形如 `<epoch>-<序号>`。
 * 返回是否为新版本；无法解析时保守地视为“有新数据”（宁可多渲染一次，不丢更新）。
 */
export function isNewerVersion(previous: string | null, next: string | null): boolean {
  if (!next) return false;
  if (!previous) return true;
  const parse = (value: string): [number, number] | null => {
    const [epochText, seqText] = value.split('-');
    const epoch = Number(epochText);
    const seq = Number(seqText);
    if (!Number.isFinite(epoch) || !Number.isFinite(seq)) return null;
    return [epoch, seq];
  };
  const left = parse(previous);
  const right = parse(next);
  if (!left || !right) return true;
  if (right[0] !== left[0]) return right[0] > left[0];
  return right[1] > left[1];
}

/**
 * 轮询 Hook：按间隔取数，版本未变化时保留上一次的数据引用，
 * 避免下游组件因为“数据没变”而重新渲染（Q14 的实体版本号去重）。
 */
export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** 最近一次成功刷新的时间。 */
  lastUpdatedAt: Date | null;
}

export function usePolling<T extends { rows: VersionedRow[] }>(
  fetcher: () => Promise<T>,
  options: { intervalMs: number; enabled?: boolean; mergeRows?: (previous: T, next: T) => T }
): PollingState<T> & { refresh: () => Promise<void> } {
  const [state, setState] = useState<PollingState<T>>({ data: null, error: null, loading: true, lastUpdatedAt: null });
  const previousRowsRef = useRef<Map<string, string>>(new Map());
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const enabled = options.enabled ?? true;

  const refresh = useCallback(async () => {
    try {
      const next = await fetcherRef.current();
      // 版本去重：所有行的版本都没变时，沿用旧对象引用，避免无意义重渲染。
      const nextVersions = new Map<string, string>();
      for (const row of next.rows) {
        const key = identifyRow(row);
        nextVersions.set(key, row.version);
      }
      const changed =
        nextVersions.size !== previousRowsRef.current.size ||
        [...nextVersions.entries()].some(([key, version]) => previousRowsRef.current.get(key) !== version);
      previousRowsRef.current = nextVersions;

      setState((previous) => {
        if (!changed && previous.data) {
          return { ...previous, error: null, loading: false, lastUpdatedAt: previous.lastUpdatedAt };
        }
        return { data: next, error: null, loading: false, lastUpdatedAt: new Date() };
      });
    } catch (error) {
      // 数据服务异常要显式暴露，不能把旧数据当最新（F11）。
      setState((previous) => ({ ...previous, error: error as Error, loading: false }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      // Q25：标签页不可见时暂停轮询，避免多标签页空耗。
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(tick, options.intervalMs);
        return;
      }
      await refresh();
      if (!cancelled) timer = setTimeout(tick, options.intervalMs);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, options.intervalMs, refresh]);

  return { ...state, refresh };
}

/** 行标识：不同实体用不同字段，保证版本去重按“同一条记录”比较。 */
export function identifyRow(row: VersionedRow): string {
  if ('projectId' in row) return `project:${(row as { projectId: string }).projectId}`;
  if ('decisionId' in row) return `decision:${(row as { decisionId: string }).decisionId}`;
  if ('deliveryId' in row) return `delivery:${(row as { deliveryId: string }).deliveryId}`;
  return `row:${row.version}`;
}

/** 主题：浅色/深色（Q94，参照站的 data-theme 机制）。 */
export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'djk-theme';

/** 初始主题：本地偏好优先，其次跟随系统。 */
export function resolveInitialTheme(
  stored: string | null,
  prefersDark: boolean
): ThemeMode {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark ? 'dark' : 'light';
}

export function applyTheme(theme: ThemeMode, root: HTMLElement): void {
  root.setAttribute('data-theme', theme);
}

/** 主题切换 Hook：写入 data-theme 与本地存储。 */
export function useTheme(): { theme: ThemeMode; toggle: () => void } {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const prefersDark = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;
    return resolveInitialTheme(window.localStorage.getItem(THEME_STORAGE_KEY), prefersDark);
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    applyTheme(theme, document.documentElement);
    if (typeof window !== 'undefined') window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  return { theme, toggle: () => setTheme((current) => (current === 'dark' ? 'light' : 'dark')) };
}

/** 人可读的相对时间；页面用它表达“多久前”，避免暴露原始时间戳。 */
export function formatRelativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return '无记录';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '时间无效';
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return '刚刚';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return then.toISOString().slice(0, 10);
}

/** 原因码中文说明（与 shared/domain.ts 的 REASON_CODE_LABELS 保持一致）。 */
export const REASON_LABELS: Record<string, string> = {
  PARSE_ERROR: '消息无法解析',
  HEARTBEAT: '连接心跳',
  COUNT_MISSING: '未识别到共同关注数',
  BELOW_THRESHOLD: '未达到推送门槛',
  DEDUPE_REPEAT: '重复事件已跳过',
  IN_FLIGHT: '同一事件正在处理中',
  STAR_NOT_INCREASED: '项目星级未升高',
  CLASSIFY_BLOCKED: '账号分类拦截',
  CLASSIFY_ALLOWED: '账号分类放行',
  CLASSIFY_ERROR_ALLOWED: '分类异常后保守放行',
  PUSHED: '已推送到频道',
  SEND_FAILED: '频道推送失败',
  ANALYSIS_QUEUED: '标准分析已排队',
  ANALYSIS_GENERATED: '标准分析已生成',
  DEEP_QUEUED: '深度分析已排队',
  DEEP_GENERATED: '深度分析已生成',
  DEPENDENCY_WAIT: '等待依赖',
  DELIVERY_PENDING: '投递待完成',
  DELIVERY_SENT: '投递已确认',
  DELIVERY_FAILED: '投递失败',
  DELIVERY_UNCERTAIN: '投递结果不确定',
  EXCLUDED_BY_CLASSIFICATION: '依据分类结果排除',
  EXCLUDED_MANUALLY: '人工移入排除池',
  RESTORED: '从排除池恢复'
};

export function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? code;
}

/** 项目来源标签（Q125）。 */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'natural':
      return '自然发现';
    case 'restored':
      return '恢复入池';
    case 'history_import':
      return '历史导入';
    default:
      return source;
  }
}

/** 星级的可访问文本。 */
export function starLabel(star: number): string {
  return star > 0 ? `${'★'.repeat(Math.min(star, 8))}（${star} 星）` : '未达门槛';
}

/** 让异常状态可读：区分“无数据”与“服务异常”（F11）。 */
export function describeListState(input: { loading: boolean; error: Error | null; rowCount: number }): {
  tone: 'loading' | 'error' | 'empty' | 'ok';
  text: string;
} {
  if (input.loading) return { tone: 'loading', text: '正在加载…' };
  if (input.error) return { tone: 'error', text: `数据服务异常：${input.error.message}` };
  if (input.rowCount === 0) return { tone: 'empty', text: '当前条件下没有记录' };
  return { tone: 'ok', text: `共 ${input.rowCount} 条` };
}

/**
 * 轮询单个对象（健康快照、配置版本这类非列表数据）。
 *
 * 与 usePolling 的差别：不做逐行版本比较；仍遵守 Q25 的间隔与标签页不可见暂停。
 */
export function usePolledValue<T>(
  fetcher: () => Promise<T>,
  options: { intervalMs: number; enabled?: boolean }
): { data: T | null; error: Error | null; loading: boolean; lastUpdatedAt: Date | null; refresh: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const enabled = options.enabled ?? true;

  const refresh = useCallback(async () => {
    try {
      const next = await fetcherRef.current();
      setData(next);
      setError(null);
      setLastUpdatedAt(new Date());
    } catch (caught) {
      // 数据服务异常必须显式暴露，不能拿旧数据当最新（F11）。
      setError(caught as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(tick, options.intervalMs);
        return;
      }
      await refresh();
      if (!cancelled) timer = setTimeout(tick, options.intervalMs);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, options.intervalMs, refresh]);

  return { data, error, loading, lastUpdatedAt, refresh };
}

/** 配置字段的中文说明，用于配置变更时间线的前后对比。 */
export const CONFIG_FIELD_LABELS: Record<string, string> = {
  starLevels: '星级阈值',
  maxStar: '最高星级',
  classificationModel: '分类模型',
  standardModel: '标准分析模型',
  deepModel: '深度分析模型',
  searchTools: '检索工具',
  deepSearchTools: '深度检索工具',
  classificationConcurrency: '分类并发',
  standardConcurrency: '标准分析并发',
  deepConcurrency: '深度分析并发',
  requestTimeoutMs: '请求时限',
  analysisMaxAttempts: '标准重试预算',
  deepAnalysisMaxAttempts: '深度重试预算',
  telegramRetryAttempts: 'Telegram 重试预算'
};

export function configFieldLabel(field: string): string {
  return CONFIG_FIELD_LABELS[field] ?? field;
}

/** 配置变更摘要：把差异字段翻成一句可读文案。 */
export function describeConfigChange(changedFields: readonly string[]): string {
  if (changedFields.length === 0) return '与上一版一致';
  if (changedFields.length === 1 && changedFields[0] === '（首次记录）') return '首次记录';
  return '变更：' + changedFields.map(configFieldLabel).join('、');
}

/** 排查结论：把“查不到”与“查到但没推”区分开（第 6 节状态表）。 */
export function describeDiagnosis(input: {
  found: boolean;
  timeline: Array<{ reasonCode: string }>;
}): { tone: 'not_found' | 'no_record' | 'pushed' | 'blocked' | 'below' | 'failed'; text: string } {
  if (!input.found) {
    return {
      tone: 'not_found',
      text: '当前保留范围内没有该账号的项目记录；这不代表账号被过滤，也可能是从未收到过事件。'
    };
  }
  if (input.timeline.length === 0) {
    return { tone: 'no_record', text: '已建立项目记录，但保留范围内没有判定记录（历史数据可能缺失）。' };
  }
  const codes = input.timeline.map((row) => row.reasonCode);
  if (codes.some((code) => code.includes('FAILED') || code === 'PARSE_ERROR')) {
    return { tone: 'failed', text: '存在失败记录，需要人工查看具体尝试结果。' };
  }
  if (codes.some((code) => code === 'CLASSIFY_BLOCKED')) {
    return { tone: 'blocked', text: '该项目被账号分类拦截过；可在已排除项目中查看并恢复。' };
  }
  if (codes.includes('PUSHED')) {
    return { tone: 'pushed', text: '至少成功推送过一次。' };
  }
  return { tone: 'below', text: '收到过事件但未达到推送门槛。' };
}

/** 运行状态页的告警摘要：把“需要人处理”的东西挑出来（Q101）。 */
export function summarizeHealth(input: {
  lastInboundAt: string | null;
  deadLetterJobs: number;
  abandonedDeliveries: number;
  uncertainDeliveries: number;
  failedJobs: number;
  now?: Date;
}): Array<{ level: 'alert' | 'warn'; text: string }> {
  const now = input.now ?? new Date();
  const items: Array<{ level: 'alert' | 'warn'; text: string }> = [];
  if (!input.lastInboundAt) {
    items.push({ level: 'warn', text: '还没有收到任何事件' });
  } else {
    const silenceMs = now.getTime() - new Date(input.lastInboundAt).getTime();
    if (silenceMs > 30 * 60_000) {
      items.push({ level: 'alert', text: '采集静默 ' + Math.floor(silenceMs / 60_000) + ' 分钟' });
    }
  }
  if (input.deadLetterJobs > 0) items.push({ level: 'alert', text: '死信任务 ' + input.deadLetterJobs + ' 个' });
  if (input.abandonedDeliveries > 0) {
    items.push({ level: 'alert', text: '已放弃投递 ' + input.abandonedDeliveries + ' 条，需人工重放' });
  }
  if (input.uncertainDeliveries > 0) {
    items.push({ level: 'warn', text: '结果不确定的投递 ' + input.uncertainDeliveries + ' 条（可能已送达）' });
  }
  if (input.failedJobs > 0) items.push({ level: 'warn', text: '失败任务 ' + input.failedJobs + ' 个，等待重试' });
  return items;
}

/**
 * 列表游标分页的累积逻辑（Q95：游标分页 + 滚动到底自动加载）。
 *
 * 设计要点：
 * - 已加载的行按 `projectId` 去重；轮询刷新第一页时，**已存在的行用新版本覆盖**，新行追加；
 * - 已加载的后续页不会被第一页刷新挤掉（否则用户滚动到一半列表会突然变短）；
 * - 分页只依赖服务端的 `nextCursor`，不在前端算偏移量——服务端游标才是稳定排序的依据。
 */
export function appendPage<T extends { projectId: string }>(loaded: readonly T[], incoming: readonly T[]): T[] {
  const updates = new Map(incoming.map((row) => [row.projectId, row] as const));
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const row of loaded) {
    merged.push(updates.get(row.projectId) ?? row);
    seen.add(row.projectId);
  }
  // 用 updates 的 values 迭代：Map 已按 id 去重（同 id 保留最后一条、位置取首次出现），
  // 直接遍历 incoming 会让同一页内的重复 id 被追加两次（这一点由测试发现）。
  for (const row of updates.values()) {
    if (!seen.has(row.projectId)) merged.push(row);
  }
  return merged;
}

/** 是否还能加载下一页：必须还有数据、不在加载中、且服务端给了游标。 */
export function canLoadMore(input: { hasMore: boolean; loading: boolean; cursor: string | null }): boolean {
  return input.hasMore && !input.loading && typeof input.cursor === 'string' && input.cursor.length > 0;
}

/** 加载进度文案：让用户知道"还有没有更多"，而不是滚动到底没反应。 */
export function describeLoadedCount(loaded: number, hasMore: boolean): string {
  return hasMore ? `已加载 ${loaded} 条，滚动到底继续加载` : `已全部加载（${loaded} 条）`;
}

/**
 * 分页位置推进规则（这是一个很容易写错的不变量）。
 *
 * 只有**首屏（replace）与追加（more）**才推进游标；
 * **轮询刷新第一页（merge）绝不能改动分页位置**——因为第一页响应里的 `nextCursor`
 * 指向的是第 2 页，用它覆盖游标会让"滚动加载"每次都退回去取第 2 页，
 * 去重后行数不再增长（表现为：滚动到底加载到 100 条就永久停住）。
 */
export function advancePagination(input: {
  mode: 'replace' | 'merge' | 'more';
  previous: { cursor: string | null; hasMore: boolean };
  page: { nextCursor: string | null; hasMore: boolean };
}): { cursor: string | null; hasMore: boolean } {
  if (input.mode === 'merge') return input.previous;
  return { cursor: input.page.nextCursor, hasMore: input.page.hasMore };
}

export interface PaginatedListState<T> {
  rows: T[];
  error: Error | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  lastUpdatedAt: Date | null;
}

export interface PaginatedListOptions {
  intervalMs: number;
  /** 筛选条件指纹；变化即重置列表（游标与已加载行一起清空）。 */
  resetKey: string;
  enabled?: boolean;
}

export interface PaginatedListResult<T> extends PaginatedListState<T> {
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  reset: () => void;
}

/**
 * 分页 + 轮询的组合 Hook。
 *
 * 轮询只刷新**第一页**并合并进已加载列表：这样既能拿到最新状态，又不会与滚动加载互相打断。
 */
export function usePaginatedList<T extends { projectId: string }>(
  fetchPage: (cursor: string | null) => Promise<{ rows: T[]; page: { nextCursor: string | null; hasMore: boolean } }>,
  options: PaginatedListOptions
): PaginatedListResult<T> {
  const [state, setState] = useState<PaginatedListState<T>>({
    rows: [],
    error: null,
    loading: true,
    loadingMore: false,
    hasMore: false,
    lastUpdatedAt: null
  });
  const cursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(false);
  const busyRef = useRef(false);
  // 被轮询占用时，滚动加载的请求必须**排队**而不是丢弃：
  // 丢弃会让哨兵一直停在视口内，IntersectionObserver 不再触发，加载永久停住。
  const pendingMoreRef = useRef(false);
  const loadRef = useRef<(mode: 'replace' | 'merge' | 'more') => Promise<void>>(async () => undefined);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const enabled = options.enabled ?? true;

  const load = useCallback(async (mode: 'replace' | 'merge' | 'more'): Promise<void> => {
    // 串行化：轮询与滚动加载共用一条通道，避免同一游标被请求两次。
    if (busyRef.current) {
      if (mode === 'more') pendingMoreRef.current = true;
      return;
    }
    busyRef.current = true;
    if (mode === 'more') setState((previous) => ({ ...previous, loadingMore: true }));
    try {
      const cursor = mode === 'more' ? cursorRef.current : null;
      const page = await fetchRef.current(cursor);
      // 轮询刷新第一页时保持分页位置不变，否则滚动加载会被打回第 2 页（见 advancePagination）。
      const position = advancePagination({
        mode,
        previous: { cursor: cursorRef.current, hasMore: hasMoreRef.current },
        page: { nextCursor: page.page.nextCursor, hasMore: page.page.hasMore }
      });
      cursorRef.current = position.cursor;
      hasMoreRef.current = position.hasMore;
      setState((previous) => ({
        rows: mode === 'replace' ? page.rows : appendPage(previous.rows, page.rows),
        error: null,
        loading: false,
        loadingMore: false,
        hasMore: position.hasMore,
        lastUpdatedAt: new Date()
      }));
    } catch (error) {
      // 数据服务异常必须显式暴露，不能把旧数据当最新（F11）。
      setState((previous) => ({ ...previous, error: error as Error, loading: false, loadingMore: false }));
    } finally {
      busyRef.current = false;
      // 通道空出来后补做被排队的滚动加载；还有更多才继续，避免末页空转。
      if (pendingMoreRef.current) {
        pendingMoreRef.current = false;
        if (hasMoreRef.current) void loadRef.current('more');
      }
    }
  }, []);
  loadRef.current = load;

  const reset = useCallback((): void => {
    cursorRef.current = null;
    hasMoreRef.current = false;
    setState((previous) => ({ ...previous, rows: [], loading: true, hasMore: false, error: null }));
    void load('replace');
  }, [load]);

  // 筛选条件变化：重置游标与已加载行，重新从第一页开始。
  useEffect(() => {
    reset();
  }, [options.resetKey, reset]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      // Q25：标签页不可见时暂停轮询。
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        await load('merge');
      }
      if (!cancelled) timer = setTimeout(() => void tick(), options.intervalMs);
    };
    timer = setTimeout(() => void tick(), options.intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, load, options.intervalMs]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!hasMoreRef.current) return;
    const ready = canLoadMore({ hasMore: true, loading: false, cursor: cursorRef.current });
    if (!ready) {
      // 首屏还没回来（游标尚未就绪）：排队，等首屏完成后自动补上。
      pendingMoreRef.current = true;
      return;
    }
    await load('more');
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    await load('merge');
  }, [load]);

  return { ...state, loadMore, refresh, reset };
}

/** 审计动作的中文说明；未收录的动作原样显示，不猜测含义（Q62）。 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'project.exclude': '项目移入排除池',
  'project.restore': '项目恢复监控',
  'delivery.replay': '投递重放'
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/** “加入监控时间”筛选项 → 起始时间（ISO）；全部则不过滤（Q105）。 */
export function joinedAfterIso(preset: 'all' | '7d' | '30d', now = new Date()): string | null {
  if (preset === 'all') return null;
  const days = preset === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
