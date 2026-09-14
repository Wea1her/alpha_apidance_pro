import { Badge, Modal, PromptDialog, describeError, formatCount } from './ui.js';
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import {
  ApiRequestError,
  api,
  type AuditResponse,
  type DecisionRow,
  type ExcludedRow,
  type HealthSnapshot,
  type ProjectRow,
  type SessionInfo
} from './api.js';
import { ProjectDetailView } from './ProjectDetailView.js';
import { DiagnoseView } from './DiagnoseView.js';
import { StatusView } from './StatusView.js';
import { TweetFeedColumn } from './TweetFeedColumn.js';
import {
  POLL_INTERVAL_MS,
  describeListState,
  formatRelativeTime,
  reasonLabel,
  sourceLabel,
  starLabel,
  describeLoadedCount,
  joinedAfterIso,
  auditActionLabel,
  usePaginatedList,
  usePolledValue,
  usePolling,
  useTheme
} from './state.js';

/**
 * 三栏工作台（Q105）：项目池 / 最近动态 / 推特喊单，已排除项目为可收起栏。
 *
 * 本文件只负责视图与交互；数据获取走 usePolling（轮询 + 版本去重），
 * 不触发任何模型调用或任务创建（第 8 节）。
 */

type PoolFilter = {
  search: string;
  stars: number[];
  hasCa: boolean | null;
  /** Q105：来源筛选（自然入池 / 恢复入池 / 历史导入）。 */
  source: 'natural' | 'restored' | 'history_import' | null;
  /** Q105：按“加入监控时间”筛选。 */
  joinedAfter: 'all' | '7d' | '30d';
};

function Card({ title, subtitle, children, actions }: { title: string; subtitle?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-line bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {subtitle ? <p className="truncate text-2xs text-muted">{subtitle}</p> : null}
        </div>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2">{children}</div>
    </section>
  );
}


function StatusLine({ loading, error, rowCount }: { loading: boolean; error: Error | null; rowCount: number }) {
  const state = describeListState({ loading, error, rowCount });
  const tone = state.tone === 'error' ? 'text-alert' : 'text-muted';
  // 错误是"需要用户注意的状态变化"，用 alert 播报；加载/空态用 status（礼貌播报，不打断）。
  return (
    <p
      className={`px-1 py-1 text-2xs ${tone}`}
      {...(state.tone === 'error' ? { role: 'alert' } : { role: 'status', 'aria-live': 'polite' as const })}
    >
      {state.text}
    </p>
  );
}

function LoginPanel({ onLoggedIn }: { onLoggedIn: (session: SessionInfo) => void }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(secret);
      onLoggedIn({ authenticated: true, role: result.role, canWrite: result.role === 'admin' });
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-line bg-surface p-5">
        <h1 className="text-base font-semibold">项目监控台</h1>
        <p className="mt-1 text-2xs text-muted">
          首次访问请输入访问密钥；管理员密码用于写入操作。
        </p>
        <label className="mt-4 block text-2xs text-muted" htmlFor="secret">
          访问密钥或管理员密码
        </label>
        <input
          id="secret"
          type="password"
          autoComplete="current-password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          className="mt-1 w-full rounded-md border border-line bg-surface-soft px-2 py-2 text-sm outline-none focus:border-accent"
        />
        {error ? <p className="mt-2 text-2xs text-alert">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || secret.length === 0}
          className="mt-4 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? '验证中…' : '进入'}
        </button>
      </form>
    </div>
  );
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 每页条数：与服务端默认一致；滚动加载时按游标追加。 */
const PAGE_SIZE = 50;

function ProjectPoolColumn({ session, onOpen }: { session: SessionInfo; onOpen: (projectId: string) => void }) {
  const [filter, setFilter] = useState<PoolFilter>({ search: '', stars: [], hasCa: null, source: null, joinedAfter: 'all' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // 筛选指纹：变化时分页状态整体重置（游标与已加载行一起清空）。
  const resetKey = `${filter.search}|${filter.stars.join(',')}|${String(filter.hasCa)}|${String(filter.source)}|${filter.joinedAfter}`;

  const fetchPage = useCallback(
    (cursor: string | null) =>
      api.projects({
        limit: PAGE_SIZE,
        cursor,
        search: filter.search || null,
        stars: filter.stars,
        hasCa: filter.hasCa,
        source: filter.source,
        joinedAfter: joinedAfterIso(filter.joinedAfter)
      }),
    [filter]
  );

  const { rows, error, loading, loadingMore, hasMore, loadMore, refresh, lastUpdatedAt } = usePaginatedList(fetchPage, {
    intervalMs: POLL_INTERVAL_MS.list,
    resetKey
  });

  // 滚动到底自动加载（Q95）：哨兵元素进入视口即取下一页。
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      // 提前 240px 触发，滚动时不必真的贴到底部才加载。
      { rootMargin: '240px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, hasMore]);

  const toggleStar = (star: number): void => {
    setFilter((current) => ({
      ...current,
      stars: current.stars.includes(star) ? current.stars.filter((value) => value !== star) : [...current.stars, star]
    }));
  };

  const exclude = async (row: ProjectRow): Promise<void> => {
    setBusyId(row.projectId);
    try {
      await api.exclude(row.projectId, { reason: 'manual' });
      await refresh();
    } catch (caught) {
      setFailure(describeError(caught).text);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card
      title="项目池"
      subtitle={lastUpdatedAt ? `更新于 ${formatRelativeTime(lastUpdatedAt.toISOString())}` : '等待数据'}
      actions={
        <button onClick={() => void refresh()} className="rounded-md border border-line px-2 py-1 text-2xs text-muted">
          刷新
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-1 pb-2">
        <input
          value={filter.search}
          onChange={(event) => setFilter((current) => ({ ...current, search: event.target.value }))}
          placeholder="搜索账号"
          className="w-32 rounded-md border border-line bg-surface-soft px-2 py-1 text-xs outline-none focus:border-accent"
        />
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            onClick={() => toggleStar(star)}
            className={`rounded-full border px-2 py-[1px] text-2xs ${
              filter.stars.includes(star) ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
            }`}
          >
            {star}★
          </button>
        ))}
        <button
          onClick={() => setFilter((current) => ({ ...current, hasCa: current.hasCa === true ? null : true }))}
          className={`rounded-full border px-2 py-[1px] text-2xs ${
            filter.hasCa === true ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
          }`}
        >
          有 CA
        </button>
        <button
          onClick={() => setFilter((current) => ({ ...current, hasCa: current.hasCa === false ? null : false }))}
          className={`rounded-full border px-2 py-[1px] text-2xs ${
            filter.hasCa === false ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
          }`}
        >
          无 CA
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1 pb-2">
        <span className="text-2xs text-muted">来源</span>
        {([
          { key: null, label: '全部' },
          { key: 'natural', label: '自然入池' },
          { key: 'restored', label: '恢复入池' },
          { key: 'history_import', label: '历史导入' }
        ] as const).map((item) => (
          <button
            key={item.key ?? 'all'}
            onClick={() => setFilter((current) => ({ ...current, source: item.key }))}
            className={`rounded-full border px-2 py-[1px] text-2xs ${
              filter.source === item.key ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-2 text-2xs text-muted">加入时间</span>
        {([
          { key: 'all', label: '不限' },
          { key: '7d', label: '近 7 天' },
          { key: '30d', label: '近 30 天' }
        ] as const).map((item) => (
          <button
            key={item.key}
            onClick={() => setFilter((current) => ({ ...current, joinedAfter: item.key }))}
            className={`rounded-full border px-2 py-[1px] text-2xs ${
              filter.joinedAfter === item.key ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <StatusLine loading={loading} error={error} rowCount={rows.length} />
      {failure ? (
        <p role="alert" className="mx-1 mb-1 rounded-md border border-alert bg-alert-soft px-2 py-1 text-2xs text-alert">
          {failure}
        </p>
      ) : null}
      <p className="px-1 pb-1 text-2xs text-muted">{describeLoadedCount(rows.length, hasMore)}</p>

      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <li key={row.projectId} className="row-compact row-lazy flex items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <button
                onClick={() => onOpen(row.projectId)}
                className="truncate text-left text-xs font-medium underline decoration-dotted"
                title={`查看详情：${row.displayName ?? row.projectKey}`}
              >
                {row.displayName ?? row.projectKey}
              </button>
              <p className="truncate text-2xs text-muted">{row.projectKey}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Badge tone="accent">{starLabel(row.star)}</Badge>
                <Badge>{sourceLabel(row.source)}</Badge>
                {row.hasContractAddress ? <Badge tone="discover">有 CA</Badge> : null}
                <Badge>展示序号 {row.displayPushCount}</Badge>
                <Badge>真实发送 {row.confirmedSendCount}</Badge>
                <Badge>最近事件 {formatRelativeTime(row.lastEventAt)}</Badge>
              </div>
            </div>
            {session.canWrite ? (
              <button
                onClick={() => void exclude(row)}
                disabled={busyId === row.projectId}
                className="shrink-0 rounded-md border border-line px-2 py-1 text-2xs text-alert disabled:opacity-50"
              >
                移入排除
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {/* 滚动加载哨兵：进入视口即触发下一页 */}
      <div ref={sentinelRef} className="h-2" aria-hidden="true" />
      {loadingMore ? <p className="py-2 text-center text-2xs text-muted">正在加载更多…</p> : null}
      {hasMore && !loadingMore ? (
        <button
          onClick={() => void loadMore()}
          className="mt-1 w-full rounded-md border border-line py-1 text-2xs text-muted"
        >
          加载更多
        </button>
      ) : null}
    </Card>
  );
}

function RecentActivityColumn() {
  const fetcher = useCallback(() => api.decisions({ limit: 50 }), []);
  const { data, error, loading } = usePolling(fetcher, { intervalMs: POLL_INTERVAL_MS.list });

  return (
    <Card title="最近动态" subtitle="接收 / 判定 / 任务 / 投递 按时间混排">
      <StatusLine loading={loading} error={error} rowCount={data?.rows.length ?? 0} />
      <ul className="space-y-2">
        {(data?.rows ?? []).map((row: DecisionRow) => (
          <li key={row.decisionId} className="rounded-lg border border-line bg-surface-soft p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium">{row.projectKey ?? '（无项目）'}</span>
              <span className="shrink-0 text-2xs text-muted">{formatRelativeTime(row.decidedAt)}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Badge tone={row.reasonCode === 'PUSHED' ? 'accent' : row.reasonCode.includes('FAILED') || row.reasonCode.includes('BLOCKED') ? 'alert' : 'neutral'}>
                {reasonLabel(row.reasonCode)}
              </Badge>
              {row.count !== null ? <Badge>关注数 {row.count}</Badge> : null}
              {row.previousStar !== null && row.star !== null ? (
                <Badge>
                  星级 {row.previousStar} → {row.star}
                </Badge>
              ) : null}
              {row.classificationType ? <Badge tone="discover">{row.classificationType}</Badge> : null}
              {row.classificationError ? <Badge tone="alert">分类异常</Badge> : null}
            </div>
            {row.title ? <p className="mt-1 line-clamp-2 text-2xs text-muted">{row.title}</p> : null}
            {row.classificationReason ? (
              <p className="mt-1 line-clamp-2 text-2xs text-muted">理由：{row.classificationReason}</p>
            ) : null}
            {row.parseError ? <p className="mt-1 text-2xs text-alert">解析失败：{row.parseError}</p> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ExcludedPanel({ session, onChanged }: { session: SessionInfo; onChanged: () => void }) {
  // 这个接口返回的是 { rows } 而不是分页信封，用 usePolledValue（按对象整体去重），
  // 不要用面向列表的 usePolling——后者会去读 X.rows 并因形状不符在运行时抛错。
  const fetcher = useCallback(() => api.excluded(100), []);
  const { data, error, loading } = usePolledValue(fetcher, { intervalMs: POLL_INTERVAL_MS.list * 2 });
  const [busyId, setBusyId] = useState<string | null>(null);
  // 待确认恢复的项目：人工排除的项目必须填理由（Q136），因此用对话框而不是 window.prompt。
  const [pendingRestore, setPendingRestore] = useState<ExcludedRow | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const performRestore = async (row: ExcludedRow, reason: string | null): Promise<void> => {
    setBusyId(row.projectId);
    setFailure(null);
    try {
      await api.restore(row.projectId, reason);
      setPendingRestore(null);
      onChanged();
    } catch (caught) {
      // 用页面内提示替代 window.alert：原生弹窗会被浏览器抑制且无法承载上下文。
      setFailure(describeError(caught).text);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card
      title="已排除项目"
      subtitle={data ? `${data.rows.length} 个 · 按进入原因区分` : '等待数据'}
    >
      <StatusLine loading={loading} error={error} rowCount={data?.rows.length ?? 0} />
      {failure ? (
        <p role="alert" className="mx-1 mb-1 rounded-md border border-alert bg-alert-soft px-2 py-1 text-2xs text-alert">
          {failure}
        </p>
      ) : null}
      {pendingRestore ? (
        <PromptDialog
          title="恢复监控"
          hint={`${pendingRestore.displayName ?? pendingRestore.projectKey} 是人工排除的，恢复必须填写理由（Q136）。`}
          label="恢复理由（必填）"
          placeholder="例如：误排除，确认项目仍在推进"
          confirmLabel="确认恢复"
          busy={busyId === pendingRestore.projectId}
          error={failure}
          onSubmit={(reason) => void performRestore(pendingRestore, reason)}
          onClose={() => setPendingRestore(null)}
        />
      ) : null}
      <ul className="divide-y divide-line">
        {(data?.rows ?? []).map((row) => (
          <li key={row.projectId} className="row-compact flex items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{row.displayName ?? row.projectKey}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Badge tone={row.exclusionReason === 'manual' ? 'alert' : 'neutral'}>
                  {row.exclusionReason === 'manual' ? '人工排除' : '规则拦截'}
                </Badge>
                {row.excludedStar !== null ? <Badge>排除时 {row.excludedStar}★</Badge> : null}
                {row.excludedEventCount !== null ? <Badge>{row.excludedEventCount} 条事件</Badge> : null}
                <Badge>{formatRelativeTime(row.excludedAt)}</Badge>
                {row.latestReasonCode ? <Badge tone="discover">{reasonLabel(row.latestReasonCode)}</Badge> : null}
              </div>
            </div>
            {session.canWrite ? (
              <button
                onClick={() => {
                  if (row.exclusionReason === 'manual') setPendingRestore(row);
                  else void performRestore(row, null);
                }}
                disabled={busyId === row.projectId}
                className="shrink-0 rounded-md border border-line px-2 py-1 text-2xs text-accent disabled:opacity-50"
              >
                恢复
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function HealthStrip() {
  // 健康接口返回快照对象（没有 rows），必须用 usePolledValue。
  // 之前这里用 usePolling + `as never` 压掉了类型错误，导致运行时抛
  // “X.rows is not iterable”，页面顶部出现“数据服务异常”横幅。
  const fetcher = useCallback(() => api.health(), []);
  const { data, error, loading } = usePolledValue<HealthSnapshot>(fetcher, { intervalMs: POLL_INTERVAL_MS.health });

  const freshness = useMemo(() => {
    if (!data) return '';
    return `采集最近事件：${formatRelativeTime(data.lastInboundAt)}`;
  }, [data]);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2 text-2xs">
      <span className="font-semibold">运行状态</span>
      {loading && !data ? <span className="text-muted">加载中…</span> : null}
      {error ? <span className="text-alert">数据服务异常：{error.message}</span> : null}
      {data ? (
        <>
          <Badge tone={data.lastInboundAt ? 'accent' : 'alert'}>{freshness}</Badge>
          <Badge>项目 {formatCount(data.projects)}（排除 {data.excludedProjects}）</Badge>
          <Badge>接收 {formatCount(data.inboundEvents)}</Badge>
          <Badge>判定 {formatCount(data.decisions)}</Badge>
          {data.queue ? (
            <Badge tone={data.queue.deadLetter > 0 ? 'alert' : 'neutral'}>
              队列 排队 {data.queue.queued} / 执行 {data.queue.running} / 死信 {data.queue.deadLetter}
            </Badge>
          ) : null}
          {data.deliveryBacklog ? (
            <Badge tone={data.deliveryBacklog.abandoned > 0 ? 'alert' : 'neutral'}>
              投递待发 {data.deliveryBacklog.pending} / 放弃 {data.deliveryBacklog.abandoned}
            </Badge>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Workspace({
  session,
  onLogout,
  onElevated
}: {
  session: SessionInfo;
  onLogout: () => void;
  onElevated: () => void;
}) {
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [view, setView] = useState<'dashboard' | 'diagnose' | 'status' | 'audit'>('dashboard');
  const { theme, toggle } = useTheme();
  const [showExcluded, setShowExcluded] = useState(false);
  const [showAdminDialog, setShowAdminDialog] = useState(false);
  const [, forceRefresh] = useState(0);

  // 提权成功后重新拉一次会话：同一个 Cookie 的角色已经变成 admin（Q106）。
  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      const current = await api.session();
      if (current.authenticated && current.canWrite) {
        onElevated();
      }
    } catch {
      // 会话查询失败不额外弹错：提权本身已成功，下次轮询会纠正显示。
    }
  }, [onElevated]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold">项目监控台</h1>
          <Badge tone={session.role === 'admin' ? 'accent' : 'neutral'}>
            {session.role === 'admin' ? '管理员（可写）' : '只读访客'}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {(['dashboard', 'diagnose', 'status', 'audit'] as const).map((item) => (
            <button
              key={item}
              onClick={() => {
                setView(item);
                setOpenProjectId(null);
              }}
              className={`rounded-md border px-2 py-1 text-2xs ${
                view === item ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
              }`}
            >
              {item === 'dashboard' ? '工作台' : item === 'diagnose' ? '判定排查' : item === 'status' ? '运行状态' : '审计'}
            </button>
          ))}
          <button
            onClick={() => setShowExcluded((current) => !current)}
            className={`rounded-md border px-2 py-1 text-2xs ${
              showExcluded ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
            }`}
          >
            已排除项目
          </button>
          {session.canWrite ? null : (
            <button
              onClick={() => setShowAdminDialog(true)}
              className="rounded-md border border-accent bg-accent-soft px-2 py-1 text-2xs text-accent"
            >
              管理
            </button>
          )}
          <button onClick={toggle} className="rounded-md border border-line px-2 py-1 text-2xs text-muted">
            {theme === 'dark' ? '浅色' : '深色'}
          </button>
          <button onClick={onLogout} className="rounded-md border border-line px-2 py-1 text-2xs text-muted">
            退出
          </button>
        </div>
      </header>

      {showAdminDialog ? (
        <AdminElevateDialog
          onClose={() => setShowAdminDialog(false)}
          onElevated={() => void refreshSession()}
        />
      ) : null}

      <HealthStrip />

      {view === 'diagnose' ? (
        <main className="min-h-0 flex-1 overflow-auto">
          <DiagnoseView />
        </main>
      ) : view === 'status' ? (
        <main className="min-h-0 flex-1 overflow-auto">
          <StatusView />
        </main>
      ) : view === 'audit' ? (
        <main className="min-h-0 flex-1 overflow-auto">
          <AuditView />
        </main>
      ) : (
      <main className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-3">
        {openProjectId ? (
          <div className="min-h-0 overflow-auto lg:col-span-3">
            <ProjectDetailView
              projectId={openProjectId}
              canWrite={session.canWrite === true}
              onBack={() => setOpenProjectId(null)}
            />
          </div>
        ) : (
          <>
            <ProjectPoolColumn session={session} onOpen={setOpenProjectId} />
            <RecentActivityColumn />
            <TweetFeedColumn session={session} />
          </>
        )}
      </main>
      )}

      {showExcluded && view === 'dashboard' ? (
        <div className="border-t border-line bg-bg p-3">
          <ExcludedPanel session={session} onChanged={() => forceRefresh((value) => value + 1)} />
        </div>
      ) : null}
    </div>
  );
}

function App(): React.ReactElement {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setSession(await api.session());
      } catch {
        setSession({ authenticated: false });
      } finally {
        setChecked(true);
      }
    })();
  }, []);

  const logout = async (): Promise<void> => {
    await api.logout();
    setSession({ authenticated: false });
  };

  if (!checked) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">正在检查会话…</div>;
  }
  if (!session?.authenticated) {
    return <LoginPanel onLoggedIn={setSession} />;
  }
  return (
    <Workspace
      session={session}
      onLogout={() => void logout()}
      onElevated={() => {
        void (async () => {
          try {
            setSession(await api.session());
          } catch {
            // 保持现有会话显示；下次整体刷新会纠正。
          }
        })();
      }}
    />
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

/**
 * 管理入口（Q106）：只读访客点“管理”并输入管理员密码后，**同一个会话**升级为管理员。
 * 与"登出再用管理员密码登录"相比，不产生第二个 Cookie、不丢当前页面状态。
 */
function AdminElevateDialog({ onClose, onElevated }: { onClose: () => void; onElevated: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.elevate(password);
      onElevated();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : '提权失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="进入管理模式"
      hint="校验管理员密码后，当前会话获得写权限（不新建会话，也不需要重新登录）。"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <input
          type="password"
          value={password}
          autoFocus
          onChange={(event) => setPassword(event.target.value)}
          placeholder="管理员密码"
          className="mt-3 w-full rounded-md border border-line bg-surface-soft px-2 py-1 text-xs outline-none focus:border-accent"
        />
        {error ? (
          <p role="alert" className="mt-2 text-2xs text-alert">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-1 text-2xs text-muted">
            取消
          </button>
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="rounded-md border border-accent bg-accent-soft px-3 py-1 text-2xs text-accent disabled:opacity-50"
          >
            {busy ? '校验中…' : '确认'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 审计视图（Q50、Q62）。
 *
 * 审计记录**不含身份**（Q75、Q85），所以这里只展示"发生了什么"：动作、目标、前后摘要与时间。
 * 不做轮询：审计变化不频繁，按需加载即可（首屏 + 加载更多）。
 */
function AuditView() {
  const [rows, setRows] = useState<AuditResponse['rows']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(
    async (next: string | null, mode: 'replace' | 'more', filter: string | null): Promise<void> => {
      if (mode === 'more') setLoadingMore(true);
      else setLoading(true);
      try {
        const page = await api.audit({ limit: 50, cursor: next, action: filter });
        setRows((previous) => (mode === 'replace' ? page.rows : [...previous, ...page.rows]));
        setCursor(page.page.nextCursor);
        setHasMore(page.page.hasMore);
        setError(null);
        setForbidden(false);
      } catch (caught) {
        // 403 与数据服务异常要分开表达：前者是权限，后者是故障。
        if (caught instanceof ApiRequestError && caught.status === 403) setForbidden(true);
        else setError(caught instanceof ApiRequestError ? caught.message : '加载失败');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(null, 'replace', action);
  }, [load, action]);

  const actions: Array<{ key: string | null; label: string }> = [
    { key: null, label: '全部' },
    { key: 'project.exclude', label: '移入排除' },
    { key: 'project.restore', label: '恢复监控' },
    { key: 'delivery.replay', label: '投递重放' }
  ];

  if (forbidden) {
    return <p className="p-4 text-sm text-alert">需要管理员权限：请点顶部“管理”并输入管理员密码。</p>;
  }

  return (
    <div className="mx-auto max-w-3xl p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {actions.map((item) => (
          <button
            key={item.key ?? 'all'}
            onClick={() => setAction(item.key)}
            className={`rounded-full border px-2 py-[1px] text-2xs ${
              action === item.key ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
        <button
          onClick={() => void load(null, 'replace', action)}
          className="ml-auto rounded-md border border-line px-2 py-1 text-2xs text-muted"
        >
          刷新
        </button>
      </div>

      <p className="mb-2 text-2xs text-muted">
        审计记录写操作与导出，按 Q75/Q85 <strong>不记录身份</strong>，只反映“发生了什么”。
      </p>

      <StatusLine loading={loading} error={error ? new Error(error) : null} rowCount={rows.length} />

      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {rows.map((row) => (
          <li key={row.auditId} className="p-2">
            <div className="flex flex-wrap items-center gap-1">
              <Badge tone="accent">{auditActionLabel(row.action)}</Badge>
              <Badge>{row.targetType}</Badge>
              {row.targetId ? <span className="text-2xs text-muted">{row.targetId}</span> : null}
              <span className="ml-auto text-2xs text-muted">{formatRelativeTime(row.occurredAt)}</span>
            </div>
            {row.beforeSummary || row.afterSummary ? (
              <p className="mt-1 text-2xs text-muted">
                {row.beforeSummary ?? '—'} → {row.afterSummary ?? '—'}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {rows.length === 0 && !loading ? <p className="p-3 text-2xs text-muted">还没有审计记录。</p> : null}
      {hasMore ? (
        <button
          onClick={() => void load(cursor, 'more', action)}
          disabled={loadingMore}
          className="mt-2 w-full rounded-md border border-line py-1 text-2xs text-muted disabled:opacity-50"
        >
          {loadingMore ? '正在加载…' : '加载更多'}
        </button>
      ) : null}
    </div>
  );
}
