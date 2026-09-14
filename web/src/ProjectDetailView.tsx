import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiRequestError,
  api,
  type DeliveryPreview,
  type ProjectDelivery,
  type ProjectDetailResponse,
  type ProjectReport
} from './api.js';
import { POLL_INTERVAL_MS, formatRelativeTime, reasonLabel, sourceLabel, starLabel, usePolledValue } from './state.js';
import { Modal, describeError } from './ui.js';
import { Badge } from './ui.js';

/**
 * 项目详情页（Q93、Q99、Q96）。
 *
 * 依据：
 * - Q93：列表只给摘要，完整报告在独立页阅读，报告正文不挤进列表；
 * - Q99：时间线为全量混排（接收/判定/任务/投递），页面负责区分而不是丢弃；
 * - Q96：展示序号与真实发送次数分列展示，两者不混用；
 * - 第 6 节状态表：明确区分“未观察到事件”“未达门槛”“被拦截”“等待依赖”“投递失败”。
 *
 * 写操作只有一处：**投递重放**（Q59），且仅对管理员显示，必须走预览 + 必填原因 + 二次确认。
 */

function Panel({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-3 py-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {hint ? <p className="text-2xs text-muted">{hint}</p> : null}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}


/**
 * 时间线状态归纳：把原因码翻译成页面状态，明确区分“无记录”与“被拦截”。
 */
export function summarizeTimelineState(reasonCodes: readonly string[]): {
  tone: 'empty' | 'blocked' | 'pushed' | 'waiting' | 'failed';
  text: string;
} {
  if (reasonCodes.length === 0) {
    return { tone: 'empty', text: '当前保留范围内没有匹配的接收记录；这不代表账号被过滤' };
  }
  if (reasonCodes.some((code) => code.includes('FAILED') || code.includes('PARSE_ERROR'))) {
    return { tone: 'failed', text: '存在失败记录，需要人工查看' };
  }
  if (reasonCodes.some((code) => code === 'CLASSIFY_BLOCKED' || code === 'EXCLUDED_MANUALLY' || code === 'EXCLUDED_BY_CLASSIFICATION')) {
    return { tone: 'blocked', text: '该项目曾被拦截或排除' };
  }
  if (reasonCodes.some((code) => code === 'PUSHED')) {
    return { tone: 'pushed', text: '至少成功推送过一次' };
  }
  if (reasonCodes.some((code) => code.startsWith('DEPENDENCY') || code.startsWith('ANALYSIS') || code.startsWith('DELIVERY'))) {
    return { tone: 'waiting', text: '存在等待依赖或投递中的记录' };
  }
  return { tone: 'empty', text: '仅收到事件，尚未达到推送门槛' };
}

/** 报告阅读：只渲染文本，不执行原始 HTML（第 7 节不可信内容）。 */
function ReportReader({ report }: { report: ProjectReport }) {
  const [expanded, setExpanded] = useState(false);
  const preview = expanded ? report.body : report.body.slice(0, 400);
  return (
    <article className="rounded-lg border border-line bg-surface-soft p-3">
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone={report.kind === 'deep' ? 'discover' : 'accent'}>
          {report.kind === 'deep' ? '深度投研' : '标准分析'}
        </Badge>
        {report.triggeredBy === 'restore' ? <Badge>恢复触发</Badge> : null}
        {report.model ? <Badge>{report.model}</Badge> : null}
        {report.generatedAt ? (
          <Badge>{formatRelativeTime(report.generatedAt)}</Badge>
        ) : (
          // 历史导入无法解析生成时间时如实标注，不用导入时间冒充（Q15）。
          <Badge tone="alert">生成时间缺失（历史数据）</Badge>
        )}
        {report.inputTokens !== null || report.outputTokens !== null ? (
          <Badge>
            用量 {report.inputTokens ?? '未提供'} / {report.outputTokens ?? '未提供'}
          </Badge>
        ) : (
          <Badge>用量未提供</Badge>
        )}
      </div>
      <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-ink">
        {preview}
        {!expanded && report.bodyLength > 400 ? '…' : ''}
      </pre>
      {report.bodyLength > 400 ? (
        <button onClick={() => setExpanded((value) => !value)} className="mt-2 rounded-md border border-line px-2 py-1 text-2xs text-muted">
          {expanded ? '收起' : `展开全文（${report.bodyLength} 字）`}
        </button>
      ) : null}
    </article>
  );
}

function DeliveryList({ detail, canWrite, onReplayed }: { detail: ProjectDetailResponse; canWrite: boolean; onReplayed: () => Promise<void> }) {
  if (detail.deliveries.length === 0) {
    return (
      <p className="text-2xs text-muted">
        没有投递记录。报告可以只存在于网页（例如手动触发的场景），这属于正常状态，不是失败。
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {detail.deliveries.map((delivery) => (
        <li key={delivery.deliveryId} className="rounded-lg border border-line bg-surface-soft p-2">
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone={delivery.sentAt ? 'accent' : delivery.abandoned ? 'alert' : 'neutral'}>
              {delivery.sentAt ? '已确认送达' : delivery.abandoned ? '已放弃（预算耗尽或永久错误）' : '待投递'}
            </Badge>
            <Badge>{delivery.purpose}</Badge>
            <Badge>尝试 {delivery.attempts} 次</Badge>
            {delivery.shardIndex > 0 ? <Badge>分片 {delivery.shardIndex}</Badge> : null}
            {delivery.uncertain ? <Badge tone="alert">结果不确定（可能已送达）</Badge> : null}
            {delivery.sentAt ? <Badge>{formatRelativeTime(delivery.sentAt)}</Badge> : null}
          </div>
          {delivery.lastError ? <p className="mt-1 text-2xs text-alert">最近错误：{delivery.lastError}</p> : null}
          {canWrite ? <DeliveryReplayControl delivery={delivery} onReplayed={onReplayed} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function ProjectDetailView({
  projectId,
  canWrite,
  onBack
}: {
  projectId: string;
  canWrite: boolean;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setDetail(await api.projectDetail(projectId));
      setError(null);
    } catch (caught) {
      // 详情页必须区分“项目不存在”与“数据服务异常”。
      setError(caught instanceof ApiRequestError ? caught.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const timelineState = useMemo(
    () => summarizeTimelineState((detail?.timeline ?? []).map((row) => row.reasonCode)),
    [detail]
  );

  if (loading) return <p className="p-4 text-sm text-muted">正在加载项目详情…</p>;
  if (error) return <p className="p-4 text-sm text-alert">数据服务异常：{error}</p>;
  if (!detail) return <p className="p-4 text-sm text-muted">项目不存在</p>;

  const { project } = detail;

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onBack} className="rounded-md border border-line px-2 py-1 text-2xs text-muted">
          返回列表
        </button>
        <h2 className="text-sm font-semibold">{project.displayName ?? project.projectKey}</h2>
        <Badge tone={project.poolState === 'excluded' ? 'alert' : 'accent'}>
          {project.poolState === 'excluded' ? '已排除' : '监控中'}
        </Badge>
        <Badge>{starLabel(project.star)}</Badge>
        <Badge>{sourceLabel(project.source)}</Badge>
        {project.hasContractAddress ? <Badge tone="discover">有 CA</Badge> : null}
        {project.link ? (
          <a href={project.link} target="_blank" rel="noreferrer noopener" className="text-2xs text-discover underline">
            账号主页 ↗
          </a>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="关键事实" hint="展示序号与真实发送次数是两件事，分列展示">
          <dl className="grid grid-cols-2 gap-2 text-2xs">
            <div>
              <dt className="text-muted">频道展示序号</dt>
              <dd className="text-sm font-medium">{project.displayPushCount}</dd>
            </div>
            <div>
              <dt className="text-muted">真实发送次数</dt>
              <dd className="text-sm font-medium">{project.confirmedSendCount}</dd>
            </div>
            <div>
              <dt className="text-muted">首次真实事件</dt>
              <dd>{project.firstEventAt ? formatRelativeTime(project.firstEventAt) : '历史数据缺失'}</dd>
            </div>
            <div>
              <dt className="text-muted">最近真实事件</dt>
              <dd>{project.lastEventAt ? formatRelativeTime(project.lastEventAt) : '历史数据缺失'}</dd>
            </div>
            <div>
              <dt className="text-muted">加入监控池</dt>
              <dd>{formatRelativeTime(project.enteredPoolAt)}</dd>
            </div>
            <div>
              <dt className="text-muted">最近判定配置版本</dt>
              <dd>{detail.latestConfigVersionId ?? '未记录'}</dd>
            </div>
          </dl>
          {project.poolState === 'excluded' ? (
            <p className="mt-2 text-2xs text-alert">
              已于 {formatRelativeTime(project.excludedAt)} 排除（
              {project.exclusionReason === 'manual' ? '人工排除' : '规则拦截'}）。排除后不再判定与生成。
            </p>
          ) : null}
        </Panel>

        <Panel title="消息链接" hint="Telegram 消息引用；缺失通常意味着历史数据未记录">
          <ul className="space-y-1 text-2xs">
            <li>
              频道消息：
              {detail.links.channel ? (
                <a href={detail.links.channel} target="_blank" rel="noreferrer noopener" className="text-discover underline">
                  打开 ↗
                </a>
              ) : (
                <span className="text-muted">无可用链接</span>
              )}
            </li>
            <li>
              讨论群报告：
              {detail.links.discussion ? (
                <a href={detail.links.discussion} target="_blank" rel="noreferrer noopener" className="text-discover underline">
                  打开 ↗
                </a>
              ) : (
                <span className="text-muted">无可用链接</span>
              )}
            </li>
          </ul>
        </Panel>
      </div>

      <Panel title="投递记录" hint="区分已送达、待投递、结果不确定与已放弃">
        <DeliveryList detail={detail} canWrite={canWrite} onReplayed={load} />
      </Panel>

      <Panel title="相关喊单" hint="谁在推上提到了这个账号（Q120 双向可达）">
        <RelatedTweets projectId={projectId} />
      </Panel>

      <Panel title="报告" hint="完整正文在详情页阅读，列表只给摘要（Q93）">
        {detail.reports.length === 0 ? (
          <p className="text-2xs text-muted">尚无报告。达到门槛后才会生成标准分析。</p>
        ) : (
          <div className="space-y-2">
            {detail.reports.map((report) => (
              <ReportReader key={report.reportId} report={report} />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="判定时间线" hint="接收 / 判定 / 任务 / 投递 全量混排">
        <p className={`mb-2 text-2xs ${timelineState.tone === 'failed' ? 'text-alert' : 'text-muted'}`}>{timelineState.text}</p>
        {detail.timeline.length === 0 ? null : (
          <ol className="space-y-1">
            {detail.timeline.map((row) => (
              <li key={row.decisionId} className="flex flex-wrap items-center gap-1 border-b border-line py-1 last:border-0">
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
                {row.count !== null ? <Badge>关注数 {row.count}</Badge> : null}
                {row.previousStar !== null && row.star !== null && row.previousStar !== row.star ? (
                  <Badge>
                    {row.previousStar} → {row.star} 星
                  </Badge>
                ) : null}
                {row.classificationType ? <Badge tone="discover">{row.classificationType}</Badge> : null}
                {row.classificationError ? <span className="text-2xs text-alert">分类异常：{row.classificationError}</span> : null}
                {row.parseError ? <span className="text-2xs text-alert">解析失败：{row.parseError}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

/**
 * 投递重放（Q59）。
 *
 * 流程固定为：**预览 → 必填原因 → 二次确认 → 执行**，原因是重放会在频道里再发一条消息，
 * 是唯一"能造成外部可见后果"的操作。预览会明确提示"已确认送达时重放会产生重复消息"，
 * 以及冷却中/终态等不可重放的原因。
 */
function DeliveryReplayControl({
  delivery,
  onReplayed
}: {
  delivery: ProjectDelivery;
  onReplayed: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<DeliveryPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const loadPreview = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.deliveryPreview(delivery.deliveryId));
      setOpen(true);
    } catch (caught) {
      setError(describeError(caught).text);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.replayDelivery(delivery.deliveryId, reason);
      setDone(true);
      setOpen(false);
      setReason('');
      await onReplayed();
    } catch (caught) {
      setError(describeError(caught).text);
    } finally {
      setBusy(false);
    }
  };

  const blockedText =
    preview?.blockedBy === 'already_sent'
      ? '该投递已确认送达：重放会在频道里再发一条重复消息'
      : preview?.blockedBy === 'cooldown'
        ? `冷却中，最早可重放时间 ${preview.cooldownEndsAt ? formatRelativeTime(preview.cooldownEndsAt) : '未知'}`
        : preview?.blockedBy === 'not_found'
          ? '投递记录不存在'
          : null;

  return (
    <div className="mt-2">
      <button
        onClick={() => void loadPreview()}
        disabled={busy}
        className="rounded-md border border-line px-2 py-1 text-2xs text-muted disabled:opacity-50"
      >
        {busy && !open ? '加载预览…' : '预览重放'}
      </button>
      {done ? <span className="ml-2 text-2xs text-accent">已提交重放，正在刷新…</span> : null}
      {error && !open ? <p className="mt-1 text-2xs text-alert">{error}</p> : null}

      {open && preview ? (
        <Modal title="重放预览" hint="请先核对目标与正文，再填写原因并确认。" onClose={() => setOpen(false)}>
          <div>
            <dl className="mt-3 space-y-1 text-2xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">用途</dt>
                <dd>{preview.purpose}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">目标</dt>
                <dd>{preview.targetChatId ?? '未记录'}{preview.targetThreadMessageId ? ` / 话题 ${preview.targetThreadMessageId}` : ''}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">分片</dt>
                <dd>{preview.shardIndex}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">历史重放次数</dt>
                <dd>{preview.historyCount}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">当前状态</dt>
                <dd>
                  {preview.alreadySent ? `已确认送达（${preview.sentAt ? formatRelativeTime(preview.sentAt) : ''}）` : '未确认送达'}
                </dd>
              </div>
            </dl>

            {preview.alreadySent ? (
              <p className="mt-2 rounded-md border border-alert bg-alert-soft p-2 text-2xs text-alert">
                该投递已确认送达：重放会在频道里**再发一条**，且无法撤回。
              </p>
            ) : null}
            {blockedText ? <p className="mt-2 text-2xs text-alert">{blockedText}</p> : null}
            {!preview.replayable && !blockedText ? (
              <p className="mt-2 text-2xs text-alert">当前状态不可重放。</p>
            ) : null}

            {preview.bodyExcerpt ? (
              <div className="mt-3">
                <p className="text-2xs text-muted">
                  正文摘要（共 {preview.bodyLength ?? 0} 字）
                </p>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-soft p-2 font-sans text-2xs">
                  {preview.bodyExcerpt}
                </pre>
              </div>
            ) : (
              <p className="mt-3 text-2xs text-muted">该投递没有关联正文（例如仅发送提示消息）。</p>
            )}

            <label className="mt-3 block text-2xs text-muted">
              重放原因（必填）
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                className="mt-1 w-full rounded-md border border-line bg-surface-soft px-2 py-1 text-xs outline-none focus:border-accent"
                placeholder="例如：频道当时不可用，确认未送达后补发"
              />
            </label>

            {error ? <p className="mt-2 text-2xs text-alert">{error}</p> : null}

            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
                className="rounded-md border border-line px-3 py-1 text-2xs text-muted"
              >
                取消
              </button>
              <button
                onClick={() => void submit()}
                disabled={busy || reason.trim().length === 0 || !preview.replayable}
                className="rounded-md border border-alert bg-alert-soft px-3 py-1 text-2xs text-alert disabled:opacity-50"
              >
                {busy ? '执行中…' : '确认重放'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * 相关喊单（Q120：喊单与项目双向可达）。
 * 数据源未配置时页面必须说明"未配置"，而不是让人以为"没有人提到过它"（Q113、Q129）。
 */
function RelatedTweets({ projectId }: { projectId: string }) {
  const fetcher = useCallback(() => api.tweets({ projectId, limit: 20 }), [projectId]);
  const { data, error, loading } = usePolledValue(fetcher, { intervalMs: POLL_INTERVAL_MS.list * 3 });

  if (error) return <p className="text-2xs text-alert">数据服务异常：{error.message}</p>;
  if (loading && !data) return <p className="text-2xs text-muted">正在加载喊单…</p>;

  const rows = data?.rows ?? [];
  const lastSuccessAt = data?.freshness.lastSuccessAt ?? null;
  if (rows.length === 0) {
    return (
      <p className="text-2xs text-muted">
        {lastSuccessAt === null
          ? '还没有喊单记录：喊单数据源尚未配置或尚未成功检索过（这不代表没有账号提到过它）。'
          : `最近检索 ${formatRelativeTime(lastSuccessAt)}，没有发现提及本项目的推文。`}
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.tweetId} className="rounded-lg border border-line bg-surface-soft p-2">
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone="accent">@{row.authorHandle ?? '未知'}</Badge>
            {row.authorFollowers !== null ? <Badge>{row.authorFollowers.toLocaleString('zh-CN')} 粉丝</Badge> : null}
            <Badge>{formatRelativeTime(row.postedAt ?? row.firstSeenAt)}</Badge>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-2xs">{row.body.slice(0, 200)}</p>
          {row.url ? (
            <a href={row.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-2xs text-accent underline">
              查看原推
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
