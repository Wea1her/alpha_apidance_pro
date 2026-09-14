import { useCallback, useState } from 'react';
import { ApiRequestError, api, type DecisionRow, type ProjectRow } from './api.js';
import { Badge } from './ui.js';
import { describeDiagnosis, formatRelativeTime, reasonLabel, sourceLabel, starLabel } from './state.js';

/**
 * 判定排查页（Q100）：以“按账号查”为主入口，展开完整判定链。
 *
 * 页面职责是“解释”，不是“改动”：
 * - 查不到账号时明确说明这不代表被过滤（第 6 节状态表）；
 * - 逐条展示原因码、当时阈值与关注数、分类结论与异常、原始输入与解析错误；
 * - 保持只读（Q76 已确认排查页不提供人工放行/拦截）。
 */

interface DiagnoseResponse {
  found: boolean;
  query: string;
  normalizedKey: string;
  project?: ProjectRow;
  timeline: DecisionRow[];
}


export function DiagnoseView(): React.ReactElement {
  const [account, setAccount] = useState('');
  const [result, setResult] = useState<DiagnoseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async () => {
    if (account.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.diagnose(account.trim()));
    } catch (caught) {
      setResult(null);
      setError(caught instanceof ApiRequestError ? caught.message : '查询失败');
    } finally {
      setBusy(false);
    }
  }, [account]);

  const conclusion = result ? describeDiagnosis({ found: result.found, timeline: result.timeline }) : null;

  return (
    <div className="space-y-3 p-3">
      <section className="rounded-xl border border-line bg-surface p-3">
        <h2 className="text-sm font-semibold">判定排查</h2>
        <p className="mt-1 text-2xs text-muted">
          输入账号、@handle 或主页链接，查看它在保留范围内的完整判定链。
        </p>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <input
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            placeholder="例如 boopfamily 或 https://x.com/boopfamily"
            className="w-full max-w-md rounded-md border border-line bg-surface-soft px-2 py-2 text-xs outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy || account.trim().length === 0}
            className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? '查询中…' : '查询'}
          </button>
        </form>
        {error ? <p className="mt-2 text-2xs text-alert">数据服务异常：{error}</p> : null}
      </section>

      {conclusion ? (
        <section
          className={`rounded-xl border p-3 text-xs ${
            conclusion.tone === 'failed' || conclusion.tone === 'blocked'
              ? 'border-alert bg-alert-soft text-alert'
              : 'border-line bg-surface'
          }`}
        >
          <p className="font-medium">{conclusion.text}</p>
          {result?.found && result.project ? (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <Badge tone={result.project.poolState === 'excluded' ? 'alert' : 'accent'}>
                {result.project.poolState === 'excluded' ? '已排除' : '监控中'}
              </Badge>
              <Badge>{starLabel(result.project.star)}</Badge>
              <Badge>{sourceLabel(result.project.source)}</Badge>
              <Badge>展示序号 {result.project.displayPushCount}</Badge>
              <Badge>真实发送 {result.project.confirmedSendCount}</Badge>
              <Badge>最近事件 {formatRelativeTime(result.project.lastEventAt)}</Badge>
            </div>
          ) : null}
        </section>
      ) : null}

      {result && result.timeline.length > 0 ? (
        <section className="rounded-xl border border-line bg-surface">
          <header className="border-b border-line px-3 py-2">
            <h3 className="text-xs font-semibold">判定链（最近 {result.timeline.length} 条）</h3>
          </header>
          <ol className="divide-y divide-line">
            {result.timeline.map((row) => (
              <li key={row.decisionId} className="p-3">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-2xs text-muted">{formatRelativeTime(row.decidedAt)}</span>
                  <Badge
                    tone={
                      row.reasonCode === 'PUSHED'
                        ? 'accent'
                        : row.reasonCode.includes('FAILED') || row.reasonCode.includes('BLOCKED')
                          ? 'alert'
                          : 'neutral'
                    }
                  >
                    {reasonLabel(row.reasonCode)}
                  </Badge>
                  {row.count !== null ? <Badge>共同关注 {row.count}</Badge> : null}
                  {row.previousStar !== null && row.star !== null ? (
                    <Badge>
                      星级 {row.previousStar} → {row.star}
                    </Badge>
                  ) : null}
                  {row.configVersionId ? <Badge>配置 {row.configVersionId}</Badge> : <Badge tone="alert">配置版本未记录</Badge>}
                </div>
                {row.classificationType || row.classificationReason || row.classificationError ? (
                  <p className="mt-1 text-2xs text-muted">
                    分类：
                    {row.classificationError ? (
                      <span className="text-alert">调用异常（按保守策略放行）：{row.classificationError}</span>
                    ) : (
                      <>
                        {row.classificationType ?? '未提供'}
                        {row.classificationConfidence !== null ? `（置信度 ${row.classificationConfidence}）` : ''}
                        {row.classificationReason ? ` · ${row.classificationReason}` : ''}
                      </>
                    )}
                  </p>
                ) : null}
                {row.title ? <p className="mt-1 text-2xs text-muted">原始标题：{row.title}</p> : null}
                {row.upstreamPushAtSec !== null ? (
                  <p className="text-2xs text-muted">上游时间（秒）：{row.upstreamPushAtSec}</p>
                ) : (
                  <p className="text-2xs text-alert">上游时间缺失（历史数据）</p>
                )}
                {row.parseError ? <p className="text-2xs text-alert">解析失败：{row.parseError}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
