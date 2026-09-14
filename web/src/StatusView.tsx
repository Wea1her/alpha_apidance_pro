import { useCallback } from 'react';
import { api, type ConfigVersionRow, type HealthSnapshot } from './api.js';
import { Badge } from './ui.js';
import { POLL_INTERVAL_MS, describeConfigChange, formatRelativeTime, summarizeHealth, usePolledValue } from './state.js';

/**
 * 运行状态页（Q101、Q102）：业务健康优先 + 配置变更时间线。
 *
 * 依据：
 * - Q101：采集连接与最后事件时间、队列最久等待与深度、失败/死信、投递积压、数据服务异常；
 * - Q102：配置变更时间线 + 前后对比，排查时不靠猜“当时用的是哪套配置”；
 * - Q61：首版不做备份/恢复页面，因此这里只展示只读指标。
 */


function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-soft p-2">
      <p className="text-2xs text-muted">{label}</p>
      <p className="text-sm font-medium">{value}</p>
      {hint ? <p className="text-2xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function StatusView(): React.ReactElement {
  const healthFetcher = useCallback(() => api.health(), []);
  const configFetcher = useCallback(() => api.configVersions(), []);
  const health = usePolledValue<HealthSnapshot>(healthFetcher, { intervalMs: POLL_INTERVAL_MS.health });
  const configs = usePolledValue<{ versions: ConfigVersionRow[]; currentVersionId: string | null }>(configFetcher, {
    intervalMs: POLL_INTERVAL_MS.health * 6
  });

  if (health.error) {
    return <p className="p-4 text-sm text-alert">数据服务异常：{health.error.message}</p>;
  }
  if (!health.data) {
    return <p className="p-4 text-sm text-muted">正在加载运行状态…</p>;
  }

  const data = health.data;
  const alerts = summarizeHealth({
    lastInboundAt: data.lastInboundAt,
    deadLetterJobs: data.deadLetterJobs,
    abandonedDeliveries: data.abandonedDeliveries,
    uncertainDeliveries: data.uncertainDeliveries,
    failedJobs: data.failedJobs
  });

  return (
    <div className="space-y-3 p-3">
      <section className="rounded-xl border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">运行状态</h2>
          <span className="text-2xs text-muted">
            最后刷新 {health.lastUpdatedAt ? formatRelativeTime(health.lastUpdatedAt.toISOString()) : '—'}
          </span>
        </div>

        {alerts.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {alerts.map((alert) => (
              <li key={alert.text} className={`text-2xs ${alert.level === 'alert' ? 'text-alert' : 'text-muted'}`}>
                {alert.level === 'alert' ? '● ' : '○ '}
                {alert.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-2xs text-muted">没有需要处理的异常。</p>
        )}

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="采集最近事件"
            value={data.lastInboundAt ? formatRelativeTime(data.lastInboundAt) : '无记录'}
            hint={data.lastInboundAt ?? '尚未收到任何业务事件'}
          />
          <Metric label="项目" value={data.projects} hint={`其中已排除 ${data.excludedProjects}`} />
          <Metric label="接收记录" value={data.inboundEvents} hint={`判定记录 ${data.decisions}`} />
          <Metric
            label="队列最久等待"
            value={data.queue?.oldestWaitMs !== null && data.queue?.oldestWaitMs !== undefined ? `${Math.round(data.queue.oldestWaitMs / 1000)} 秒` : '无排队'}
            hint={data.queue ? `排队 ${data.queue.queued} / 执行 ${data.queue.running}` : undefined}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {data.queue ? (
            <>
              <Badge tone={data.queue.queued > 0 ? 'discover' : 'neutral'}>排队 {data.queue.queued}</Badge>
              <Badge tone={data.queue.running > 0 ? 'accent' : 'neutral'}>执行中 {data.queue.running}</Badge>
              <Badge tone={data.queue.waitingDependency > 0 ? 'discover' : 'neutral'}>
                等待依赖 {data.queue.waitingDependency}
              </Badge>
              <Badge tone={data.queue.failed > 0 ? 'alert' : 'neutral'}>失败 {data.queue.failed}</Badge>
              <Badge tone={data.queue.deadLetter > 0 ? 'alert' : 'neutral'}>死信 {data.queue.deadLetter}</Badge>
            </>
          ) : null}
          {data.deliveryBacklog ? (
            <>
              <Badge tone={data.deliveryBacklog.pending > 0 ? 'discover' : 'neutral'}>
                投递待发 {data.deliveryBacklog.pending}
              </Badge>
              <Badge tone={data.deliveryBacklog.abandoned > 0 ? 'alert' : 'neutral'}>
                已放弃 {data.deliveryBacklog.abandoned}
              </Badge>
              <Badge tone={data.deliveryBacklog.uncertain > 0 ? 'alert' : 'neutral'}>
                结果不确定 {data.deliveryBacklog.uncertain}
              </Badge>
            </>
          ) : null}
          {data.sessions ? (
            <>
              <Badge>访客会话 {data.sessions.visitors}</Badge>
              <Badge>管理员会话 {data.sessions.admins}</Badge>
            </>
          ) : null}
        </div>
        {data.deliveryBacklog?.oldestPendingAt ? (
          <p className="mt-1 text-2xs text-muted">最久待发投递：{formatRelativeTime(data.deliveryBacklog.oldestPendingAt)}</p>
        ) : null}
      </section>

      <section className="rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-3 py-2">
          <h3 className="text-xs font-semibold">配置变更时间线</h3>
          <p className="text-2xs text-muted">显示生效时间与相对上一版变化的字段；阈值与模型不一致正是排查时的常见误导来源。</p>
        </header>
        <div className="p-3">
          {configs.error ? <p className="text-2xs text-alert">数据服务异常：{configs.error.message}</p> : null}
          {!configs.data ? (
            <p className="text-2xs text-muted">正在加载配置版本…</p>
          ) : configs.data.versions.length === 0 ? (
            <p className="text-2xs text-muted">尚无配置版本记录。</p>
          ) : (
            <ol className="space-y-2">
              {configs.data.versions.map((version) => (
                <li key={version.configVersionId} className="rounded-lg border border-line bg-surface-soft p-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {version.configVersionId === configs.data?.currentVersionId ? <Badge tone="accent">当前生效</Badge> : null}
                    <Badge>{formatRelativeTime(version.effectiveAt)}</Badge>
                    <span className="text-2xs text-muted">{describeConfigChange(version.changedFields)}</span>
                  </div>
                  <p className="mt-1 text-2xs text-muted">
                    阈值 {version.snapshot.starLevels.join(' / ')}；分类模型 {version.snapshot.classificationModel ?? '未记录'}；
                    深度模型 {version.snapshot.deepModel ?? '未记录'}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
