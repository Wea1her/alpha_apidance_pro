import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, api, type SessionInfo, type TweetFeedRow } from './api.js';
import { Badge } from './ui.js';
import { POLL_INTERVAL_MS, formatRelativeTime, usePolledValue } from './state.js';
import { describeError } from './ui.js';

/**
 * 推特喊单栏（Q105、Q112-Q117）。
 *
 * 依据：
 * - Q117：条目按六行结构渲染——作者头 / 元信息 / AI 中文摘要块 / 原文 / Original 链接 / 互动数；
 * - Q113：没有提及就不显示该栏内容；检索失败与配额耗尽必须与“没有提及”区分；
 * - Q116：显示最后成功检索时间，并说明数据源延迟；
 * - Q120：显示这条推文提及了哪些监控池账号；
 * - Q114：新条目高亮 + 页面内消息条提示“有 N 条新喊单”；
 * - Q116：提供“立即查一次”（管理员），数据源未配置时如实说明而不是静默无反应。
 */


/** 互动数：数据源不提供时显示“未提供”，不显示 0（Q117）。 */
export function formatMetric(value: number | null): string {
  return value === null ? '未提供' : String(value);
}

/** 摘要块文案：失败或未完成时明确说明，而不是留空（Q117）。 */
export function summaryText(row: Pick<TweetFeedRow, 'summaryStatus' | 'summaryText'>): string {
  if (row.summaryStatus === 'done' && row.summaryText) return row.summaryText;
  if (row.summaryStatus === 'failed') return '摘要不可用（原文已保留）';
  return '摘要生成中…';
}

function TweetItem({ row, isNew = false }: { row: TweetFeedRow; isNew?: boolean }) {
  const bodyPreview = row.body.length > 400 ? `${row.body.slice(0, 400)}…` : row.body;
  return (
    // Q114：新条目整行高亮，直到用户点“知道了”。
    <li
      className={`rounded-lg border p-2 ${
        isNew ? 'border-accent bg-accent-soft' : 'border-line bg-surface-soft'
      }`}
    >
      {/* 第 1 行：作者头 */}
      <div className="flex flex-wrap items-center gap-1">
        {row.authorName ? <span className="text-xs font-medium">{row.authorName}</span> : null}
        <span className="text-2xs text-discover">@{row.authorHandle ?? '未知作者'}</span>
        {row.authorVerified ? <Badge tone="discover">已认证</Badge> : null}
        <Badge>{row.source}</Badge>
      </div>

      {/* 第 2 行：元信息（粉丝数 / 发布时间） */}
      <p className="mt-1 text-2xs text-muted">
        {row.authorFollowers === null ? '粉丝数未提供' : `${row.authorFollowers} 粉丝`} ·{' '}
        {row.postedAt ? formatRelativeTime(row.postedAt) : '发布时间未提供'}
      </p>

      {/* 第 3 行：AI 中文摘要块 */}
      <p
        className={`mt-1 rounded-md border p-1 text-2xs ${
          row.summaryStatus === 'done' ? 'border-discover bg-discover-soft text-ink' : 'border-line text-muted'
        }`}
      >
        {summaryText(row)}
      </p>

      {/* 第 4 行：原文 */}
      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed">{bodyPreview}</p>

      {/* 第 5 行：链接 + 关联项目 */}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {row.url ? (
          <a href={row.url} target="_blank" rel="noreferrer noopener" className="text-2xs text-discover underline">
            Original ↗
          </a>
        ) : (
          <span className="text-2xs text-muted">无原文链接</span>
        )}
        {row.mentionedProjects.map((project) => (
          <Badge key={project.projectId} tone="accent">
            提及 {project.projectKey}
          </Badge>
        ))}
        <Badge>首次见到 {formatRelativeTime(row.firstSeenAt)}</Badge>
      </div>

      {/* 第 6 行：互动数 */}
      <p className="mt-1 text-2xs text-muted">
        views {formatMetric(row.viewCount)} · likes {formatMetric(row.likeCount)} · rt {formatMetric(row.retweetCount)} · replies{' '}
        {formatMetric(row.replyCount)}
      </p>
    </li>
  );
}

export function TweetFeedColumn({ session }: { session?: SessionInfo } = {}): React.ReactElement {
  const fetcher = useCallback(() => api.tweets({ limit: 50 }), []);
  const { data, error, loading, lastUpdatedAt, refresh } = usePolledValue(fetcher, {
    intervalMs: POLL_INTERVAL_MS.list * 2
  });

  // ---- Q114：新条目高亮 ----
  // 用"已知推文 ID 集合"做差集，而不是比较数组长度（长度相同也可能内容已变）。
  const seenIdsRef = useRef<Set<string> | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const rows = data?.rows ?? [];
    if (rows.length === 0) return;
    const current = new Set(rows.map((row) => row.tweetId));
    const previous = seenIdsRef.current;
    seenIdsRef.current = current;
    if (previous === null) return; // 首屏不算“新”，否则一进页面就满屏高亮
    const fresh = new Set([...current].filter((id) => !previous.has(id)));
    if (fresh.size > 0) setNewIds(fresh);
  }, [data]);

  // ---- Q116：立即查一次 ----
  const [polling, setPolling] = useState(false);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const pollNow = async (): Promise<void> => {
    setPolling(true);
    setPollFailed(false);
    setPollMessage(null);
    try {
      const result = await api.refreshTweets();
      if (result.skipped) {
        setPollFailed(true);
        setPollMessage(result.reason ?? '数据源未配置：本次没有检索，也不代表“没有提及”');
      } else {
        setPollMessage(
          `检索完成：覆盖 ${result.handles} 个账号，候选 ${result.fetched} 条，新入库 ${result.created} 条` +
            (result.filteredOut > 0 ? `，过滤误召回 ${result.filteredOut} 条` : '') +
            (result.failures.length > 0 ? `，${result.failures.length} 批失败` : '')
        );
        await refresh();
      }
    } catch (caught) {
      setPollFailed(true);
      setPollMessage(describeError(caught).text);
    } finally {
      setPolling(false);
    }
  };

  if (error) {
    return (
      <section className="flex min-h-0 flex-col rounded-xl border border-alert bg-surface">
        <header className="border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">推特喊单</h2>
        </header>
        <div className="p-2 text-2xs text-alert">数据服务异常：{error.message}</div>
      </section>
    );
  }

  const rows = data?.rows ?? [];
  const freshness = data?.freshness;

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-line bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">推特喊单</h2>
          <p className="truncate text-2xs text-muted">
            {loading && !data
              ? '正在加载…'
              : freshness?.lastSuccessAt
                ? `最后成功检索 ${formatRelativeTime(freshness.lastSuccessAt)}（数据源可能有分钟级延迟）`
                : '尚未成功检索过（数据源未配置或全部失败）'}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {freshness && freshness.failingProjects > 0 ? (
            <Badge tone="alert">{freshness.failingProjects} 个账号检索失败</Badge>
          ) : null}
          {session?.canWrite ? (
            <button
              onClick={() => void pollNow()}
              disabled={polling}
              className="rounded-md border border-line px-2 py-1 text-2xs text-muted disabled:opacity-50"
            >
              {polling ? '检索中…' : '立即查一次'}
            </button>
          ) : null}
        </div>
      </header>

      {pollMessage ? (
        <p
          className={`border-b border-line px-3 py-1 text-2xs ${pollFailed ? 'text-alert' : 'text-muted'}`}
          {...(pollFailed ? { role: 'alert' } : { role: 'status', 'aria-live': 'polite' as const })}
        >
          {pollMessage}
        </p>
      ) : null}

      {newIds.size > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-2 border-b border-accent bg-accent-soft px-3 py-1"
        >
          <span className="text-2xs text-accent">有 {newIds.size} 条新喊单</span>
          <button onClick={() => setNewIds(new Set())} className="text-2xs text-accent underline">
            知道了
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {/* Q113：没有提及就不显示内容，也不显示“暂无数据”把失败伪装成空。 */}
        {rows.length === 0 ? (
          freshness && freshness.failingProjects > 0 ? (
            <p className="rounded-lg border border-dashed border-alert p-2 text-2xs text-alert">
              检索失败：当前无法确认是否存在提及。请检查数据源配置与配额。
            </p>
          ) : (
            <p className="rounded-lg border border-dashed border-line p-2 text-2xs text-muted">
              {freshness?.lastSuccessAt ? '当前没有检测到提及。' : '数据源未配置：暂不展示内容。'}
            </p>
          )
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <TweetItem key={row.tweetId} row={row} isNew={newIds.has(row.tweetId)} />
            ))}
          </ul>
        )}
        {freshness && freshness.pendingSummaries > 0 ? (
          <p className="mt-2 text-2xs text-muted">{freshness.pendingSummaries} 条推文等待生成摘要</p>
        ) : null}
        {lastUpdatedAt ? <p className="mt-1 text-2xs text-muted">本页刷新于 {formatRelativeTime(lastUpdatedAt.toISOString())}</p> : null}
      </div>
    </section>
  );
}
