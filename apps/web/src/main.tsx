import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './login.css';

type View = 'feed' | 'reports' | 'trench' | 'ledger' | 'calendar' | 'settings';
type ProjectStatus = 'screening' | 'active' | 'trench' | 'dormant' | 'pending_review' | 'excluded';
type Project = {
  id: string; xUserId: string; handle: string; name: string; star: number; follows: number;
  status: ProjectStatus; reportStatus: string | null;
  surge: boolean; surgeUntil?: string | null; ca: boolean; latestSignalAt: string | null;
  avatarUrl?: string | null; chainCategory?: string | null; playbookCategory?: string | null;
  screeningAccountType?: string | null; screeningReason?: string | null; exclusionReason?: string | null;
  monitorStatus?: string | null; monitorDesiredState?: string | null; tags: string[];
};
type Signal = { id: string; type: string; occurred_at: string; common_follow_count: number | null; x_post_url: string | null; content: string | null; data: unknown };
type CommonFollowUser = { id: string; handle: string; name: string; avatarUrl: string | null; followers: number | null; verified: boolean; occurredAt: string };
type ReportVersion = { id: string; version: number; status: string; change_summary?: unknown; created_at: string; completed_at?: string | null };
type ReportDocument = { status: string; version: number; rendered_markdown: string | null; structured_document: Record<string, unknown> | null; created_at: string };
type LedgerEntry = { id: string; project_id: string; type: string; status: string; amount_text: string | null; content: string; occurred_at: string | null; created_at: string };
type CalendarEvent = { id: string; project_id: string; title: string; starts_at: string; status: string; confidence: number | null; remind_24h: boolean; remind_1h: boolean };
type StarAlert = { projectId: string; projectName: string; handle: string; from: number; to: number };

const STATUS_LABEL: Record<ProjectStatus, string> = { screening: '初筛中', active: '已通过', trench: '战壕中', dormant: '休眠', pending_review: '待确认', excluded: '已排除' };
const REPORT_LABEL: Record<string, string> = { queued: '排队中', collecting: '证据收集中', generating: '生成中', ready: '已完成', failed: '生成失败' };
const ACCOUNT_TYPE_LABEL: Record<string, string> = { KOL: 'KOL 账号', PERSONAL: '个人账号', DEV: '个人开发者 / Dev 账号', MEDIA: '媒体 / 社媒账号', PROJECT: '项目账号', ALPHA: 'Alpha 账号', UNKNOWN: '未知账号', NFT: 'NFT / PFP 项目', TRADFI: '传统金融 / 非加密项目', CORPORATE: '企业 / 品牌官方账号', CAPITAL: 'VC / 基金 / 资本账号', CHAIN: '公链 / 网络官方账号', EXCHANGE: '交易所官方账号', FOUNDATION: '基金会官方账号', AFFILIATE: '官方附属账号' };

async function api<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: 'include', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) } });
  if (response.status === 401) throw new Error('unauthorized');
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? `请求失败（${response.status}）`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function Stars({ value }: { value: number }) { return <span className="stars" aria-label={`${value} 星`}>{'★'.repeat(Math.max(0, Math.min(5, value)))}<i>{'★'.repeat(Math.max(0, 5 - value))}</i></span>; }
function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  if (totalPages <= 1) return null;
  return <nav className="pagination" aria-label="项目分页"><button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button><span>第 {page} / {totalPages} 页</span><button type="button" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>下一页</button></nav>;
}
function formatDateTime(value: string | null): string { if (!value) return '暂无推送时间'; const date = new Date(value); if (Number.isNaN(date.getTime())) return '时间未知'; return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
function mapProject(item: Record<string, unknown>): Project { return { id: String(item.id ?? ''), xUserId: String(item.xUserId ?? ''), handle: String(item.handle ?? ''), name: String(item.displayName || item.handle || '未命名项目'), star: Number(item.highestStar ?? 0), follows: Number(item.currentCommonFollowCount ?? item.highestCommonFollowCount ?? 0), status: (String(item.status ?? 'screening') as ProjectStatus), reportStatus: item.reportStatus ? String(item.reportStatus) : null, surge: Boolean(item.surge), surgeUntil: item.surgeUntil ? String(item.surgeUntil) : null, ca: Boolean(item.hasCa), latestSignalAt: item.latestSignalAt ? String(item.latestSignalAt) : null, avatarUrl: item.avatarUrl ? String(item.avatarUrl) : null, chainCategory: item.chainCategory ? String(item.chainCategory) : null, playbookCategory: item.playbookCategory ? String(item.playbookCategory) : null, screeningAccountType: item.screeningAccountType ? String(item.screeningAccountType) : null, screeningReason: item.screeningReason ? String(item.screeningReason) : null, exclusionReason: item.exclusionReason ? String(item.exclusionReason) : null, monitorStatus: item.monitorStatus ? String(item.monitorStatus) : null, monitorDesiredState: item.monitorDesiredState ? String(item.monitorDesiredState) : null, tags: [] }; }
function matchesProjectFilter(project: Project, filter: string): boolean { if (filter === 'all') return true; if (filter === 'excluded') return project.status === 'excluded'; if (filter === 'surge') return project.surge; if (filter === 'ca') return project.ca; const star = /^star_([1-5])$/.exec(filter); return star ? project.star === Number(star[1]) : true; }
function recordValue(value: unknown): Record<string, unknown> { let current = value; for (let i = 0; i < 2 && typeof current === 'string'; i += 1) { try { current = JSON.parse(current); } catch { return {}; } } return current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {}; }
function commonFollowUserFromSignal(signal: Signal): CommonFollowUser | null { const payload = recordValue(signal.data); const user = recordValue(payload.user); const id = String(user.id_str ?? user.id ?? '').trim(); const handle = String(user.screen_name ?? user.username ?? user.handle ?? '').trim(); if (!id && !handle) return null; return { id: id || handle, handle, name: String(user.name ?? (handle || '未命名账号')), avatarUrl: typeof user.profile_image_url_https === 'string' ? user.profile_image_url_https : null, followers: Number.isFinite(Number(user.followers_count)) ? Number(user.followers_count) : null, verified: Boolean(user.verified || user.is_blue_verified), occurredAt: signal.occurred_at }; }

function LoginView({ onSuccess }: { onSuccess: () => void }) {
  const [accessKey, setAccessKey] = useState(''); const [error, setError] = useState(''); const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setSubmitting(true); setError(''); try { await api('/auth/access-key', { method: 'POST', body: JSON.stringify({ accessKey }) }); onSuccess(); } catch (error) { setError(error instanceof Error && error.message === 'too_many_attempts' ? '尝试次数过多，请稍后再试' : '访问密钥不正确'); } finally { setSubmitting(false); } };
  return <div className="login-shell"><div className="login-card"><div className="brand login-brand"><span className="brand-mark">α</span><div><strong>ALPHA</strong><small>RESEARCH DESK</small></div></div><p className="eyebrow">PRIVATE RESEARCH DESK</p><h1>进入投研工作台</h1><p className="login-copy">这是私人部署的实时信号与 AI 调研系统，请输入访问密钥。</p><form onSubmit={submit}><label className="access-label">访问密钥<input autoFocus type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} placeholder="请输入访问密钥" /></label>{error && <p className="login-error">{error}</p>}<button className="login-submit" disabled={!accessKey || submitting}>{submitting ? '验证中…' : '进入工作台'}</button></form><small className="login-hint">密钥只在服务端校验，不会保存到浏览器。</small></div></div>;
}

function ProjectCard({ project, onDetail, onExclude, onRestore }: { project: Project; onDetail: () => void; onExclude: () => void; onRestore: () => void }) {
  const xUrl = project.handle ? `https://x.com/${project.handle.replace(/^@/, '')}` : `https://x.com/i/user/${project.xUserId}`;
  return <article className={`project-card ${project.surge ? 'is-surge' : ''} ${project.ca ? 'has-ca' : ''}`}><a className="card-open" href={xUrl} target="_blank" rel="noreferrer" aria-label={`打开 ${project.name} 的 X 主页`}><div className="card-main"><div className="project-icon">{project.avatarUrl ? <img src={project.avatarUrl} alt="" /> : project.name.slice(0, 1)}</div><div className="project-title"><div><h2>{project.name}</h2><span>{project.handle ? `@${project.handle.replace(/^@/, '')}` : `X ID ${project.xUserId}`} ↗</span></div><div className="badges">{project.surge && <b className="badge surge">↗ 飙升</b>}{project.ca && <b className="badge ca">CA 检测到</b>}</div></div><div className="project-score"><Stars value={project.star} /><strong>{project.follows}</strong><small>共同关注</small></div></div><div className="project-classification"><span><b>链分类</b>{project.chainCategory ?? '待研判'}</span><span><b>玩法板块</b>{project.playbookCategory ?? '待研判'}</span></div>{project.status === 'excluded' && <div className="exclusion-reason"><strong>AI 排除理由</strong><span>{project.screeningReason ?? project.exclusionReason ?? '未记录具体理由'}</span>{project.screeningAccountType && <em>{ACCOUNT_TYPE_LABEL[project.screeningAccountType] ?? project.screeningAccountType}</em>}</div>}<div className="card-bottom"><div className="status"><span className={`status-dot ${project.status === 'active' || project.status === 'trench' ? 'ok' : project.status === 'pending_review' ? 'warn' : ''}`} />{STATUS_LABEL[project.status]}<span className="divider" /><span className="report-label">AI 报告</span><span className="report-status">{project.reportStatus ? (REPORT_LABEL[project.reportStatus] ?? project.reportStatus) : '尚未生成'}</span></div><div className="tags">{project.status === 'trench' && <span>战壕</span>}{project.ca && <span>重点信号</span>}</div><time title="最近一次 Alpha 推送时间">{formatDateTime(project.latestSignalAt)}</time></div></a><div className="card-actions"><button className="detail-button" onClick={onDetail}>详情</button>{project.status === 'excluded' ? <button onClick={onRestore}>恢复</button> : <button onClick={onExclude}>排除</button>}</div></article>;
}

function MarkdownDocument({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/);
  return <div className="markdown-document">{lines.map((line, index) => { const trimmed = line.trim(); if (!trimmed) return <div className="md-space" key={index} />; if (trimmed.startsWith('# ')) return <h2 key={index}>{trimmed.slice(2)}</h2>; if (trimmed.startsWith('## ')) return <h3 key={index}>{trimmed.slice(3)}</h3>; if (trimmed.startsWith('### ')) return <h4 key={index}>{trimmed.slice(4)}</h4>; if (trimmed.startsWith('- ')) return <li key={index}>{trimmed.slice(2)}</li>; return <p key={index}>{trimmed}</p>; })}</div>;
}

function DetailPanel({ project, onClose, onRefresh }: { project: Project; onClose: () => void; onRefresh: () => void }) {
  const [signals, setSignals] = useState<Signal[]>([]); const [tweets, setTweets] = useState<Signal[]>([]); const [note, setNote] = useState(''); const [saving, setSaving] = useState(false); const [message, setMessage] = useState(''); const [report, setReport] = useState<ReportDocument | null>(null);
  const [showAllCommonFollows, setShowAllCommonFollows] = useState(false);
  const commonFollowUsers = useMemo(() => { const seen = new Set<string>(); const users: CommonFollowUser[] = []; for (const signal of signals.filter((item) => item.type === 'common_follow')) { const user = commonFollowUserFromSignal(signal); if (user && !seen.has(user.id)) { seen.add(user.id); users.push(user); } } return users; }, [signals]);
  const commonFollowPreviewLimit = 8;
  const visibleCommonFollowUsers = showAllCommonFollows ? commonFollowUsers : commonFollowUsers.slice(0, commonFollowPreviewLimit);
  useEffect(() => { setShowAllCommonFollows(false); }, [project.id]);
  useEffect(() => { void api<{ items: Signal[] }>(`/api/projects/${project.id}/signals`).then((payload) => setSignals(payload.items)).catch(() => setSignals([])); void api<{ items: Signal[] }>(`/api/projects/${project.id}/tweets`).then((payload) => setTweets(payload.items)).catch(() => setTweets([])); }, [project.id]);
  useEffect(() => { void api<{ items: ReportVersion[] }>(`/api/projects/${project.id}/reports`).then(async (payload) => { const latest = payload.items[0]; if (latest) { const detail = await api<{ item: ReportDocument }>(`/api/projects/${project.id}/reports/${latest.version}`); setReport(detail.item); } else setReport(null); }).catch(() => { setReport(null); }); }, [project.id]);
  const saveNote = async () => { if (!note.trim()) return; setSaving(true); try { await api(`/api/projects/${project.id}/notes`, { method: 'POST', body: JSON.stringify({ content: note.trim() }) }); setNote(''); setMessage('笔记已保存'); } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); } finally { setSaving(false); } };
  const copyReport = async () => { if (!report?.rendered_markdown) return; await navigator.clipboard?.writeText(report.rendered_markdown); setMessage('报告正文已复制'); };
  const downloadReport = () => { if (!report?.rendered_markdown) return; const blob = new Blob([report.rendered_markdown], { type: 'text/markdown;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${project.handle || project.name}-ai-report.md`; link.click(); URL.revokeObjectURL(url); };
  const dynamicSignals = project.star >= 3 && project.status === 'trench' ? tweets : [];
  return <div className="drawer-backdrop" onClick={onClose}><aside className="detail-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-head"><div><p className="eyebrow">PROJECT DETAIL</p><h2>{project.name}</h2><span>{project.handle ? `@${project.handle.replace(/^@/, '')}` : project.xUserId}</span></div><button className="close" onClick={onClose}>×</button></div><div className="detail-kpis"><div><span>历史最高星级</span><strong><Stars value={project.star} /></strong></div><div><span>共同关注峰值</span><strong>{project.follows}</strong></div><div><span>当前状态</span><strong>{STATUS_LABEL[project.status]}</strong></div></div><section className="detail-section"><div className="section-title"><h3>共同关注用户</h3><small>{commonFollowUsers.length ? `已收到 ${commonFollowUsers.length} 个账号` : '上游未提供明细'}</small></div>{commonFollowUsers.length ? <><p className="section-hint">列表来自 Alpha 逐条推送中的触发账号；总人数以共同关注峰值为准。</p><div className="common-follow-list">{visibleCommonFollowUsers.map((user) => <div className="common-follow-user" key={user.id}>{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="common-follow-avatar">{user.name.slice(0, 1)}</span>}<div><strong>{user.name}{user.verified && <em>✓</em>}</strong><small>{user.handle ? `@${user.handle}` : `X ID ${user.id}`}{user.followers != null ? ` · ${user.followers.toLocaleString()} 粉丝` : ''}</small></div><a href={user.handle ? `https://x.com/${user.handle}` : `https://x.com/i/user/${user.id}`} target="_blank" rel="noreferrer">查看 ↗</a></div>)}</div>{commonFollowUsers.length > commonFollowPreviewLimit && <button type="button" className="common-follow-toggle" aria-expanded={showAllCommonFollows} onClick={() => setShowAllCommonFollows((visible) => !visible)}>{showAllCommonFollows ? '收起共同关注账号' : `展开全部 ${commonFollowUsers.length} 个账号`}</button>}</> : <div className="empty small">当前 Alpha Hook 只下发共同关注数量，暂无用户明细。</div>}</section><section className="detail-section"><div className="section-title"><h3>项目历史推文</h3><small>{project.star >= 3 && project.status === 'trench' ? `${dynamicSignals.length} 条` : '三星战壕后开放'}</small></div>{project.star >= 3 && project.status === 'trench' ? (dynamicSignals.length ? <div className="signal-list">{dynamicSignals.map((signal) => <div className="signal-item" key={signal.id}><div><b>Alpha 新推文</b></div><time>{formatDateTime(signal.occurred_at)}</time>{signal.content && <p>{signal.content}</p>}{signal.x_post_url && <a href={signal.x_post_url} target="_blank" rel="noreferrer">查看原帖 ↗</a>}</div>)}</div> : <div className="empty small">已进入战壕，等待 Alpha 推送该账号的新推文。</div>) : <div className="empty small">项目达到三星并进入战壕后，才会显示 Alpha 监控到的历史推文。</div>}</section><section className="detail-section"><div className="section-title"><h3>AI 调研报告</h3></div>{report?.rendered_markdown ? <><div className="report-actions"><button className="secondary" onClick={() => void copyReport()}>复制全文</button><button className="secondary" onClick={downloadReport}>下载 Markdown</button></div><MarkdownDocument markdown={report.rendered_markdown} /></> : <p className="muted">{project.reportStatus ? `当前状态：${REPORT_LABEL[project.reportStatus] ?? project.reportStatus}` : '尚未生成可阅读报告。'}</p>}</section><section className="detail-section"><div className="section-title"><h3>个人笔记</h3></div><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录下一步判断、参与计划或待核实问题…" /><div className="note-actions"><button className="primary" disabled={saving || !note.trim()} onClick={() => void saveNote()}> {saving ? '保存中…' : '保存笔记'}</button>{message && <span>{message}</span>}</div></section><section className="detail-section"><button className="secondary" onClick={() => { onRefresh(); setMessage('已刷新项目状态'); }}>刷新项目状态</button></section></aside></div>;
}

function ReportsView({ projects, onOpen }: { projects: Project[]; onOpen: (project: Project) => void }) {
  const [reports, setReports] = useState<Array<{ project: Project; versions: ReportVersion[] }>>([]); const [loading, setLoading] = useState(true);
  useEffect(() => { let cancelled = false; setLoading(true); void Promise.all(projects.filter((item) => item.status !== 'excluded' && (item.reportStatus || item.star >= 3)).map(async (project) => { const payload = await api<{ items: ReportVersion[] }>(`/api/projects/${project.id}/reports`).catch(() => ({ items: [] })); return { project, versions: payload.items }; })).then((items) => { if (!cancelled) setReports(items); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [projects]);
  if (loading) return <div className="panel-loading">正在加载报告目录…</div>;
  return <section className="workspace-panel"><div className="panel-heading"><div><p className="eyebrow">AI RESEARCH</p><h2>AI 调研报告</h2><p>报告以可读文档展示，生成后自动更新。</p></div><span className="panel-count">{reports.filter((item) => item.versions.length).length} 个项目</span></div>{reports.length ? <div className="report-grid">{reports.map(({ project, versions }) => <button className="report-card" key={project.id} onClick={() => onOpen(project)}><div className="report-card-top"><span className="project-icon small">{project.avatarUrl ? <img src={project.avatarUrl} alt="" /> : project.name.slice(0, 1)}</span><div><strong>{project.name}</strong><small>{project.handle}</small></div><span className={`status-pill ${project.reportStatus === 'ready' ? 'ready' : ''}`}>{project.reportStatus ? (REPORT_LABEL[project.reportStatus] ?? project.reportStatus) : '待生成'}</span></div><div className="report-card-bottom"><span>{versions.length ? '报告已生成' : '待生成报告'}</span><span>{formatDateTime(project.latestSignalAt)} ↗</span></div></button>)}</div> : <div className="empty panel-empty"><strong>还没有可阅读的报告</strong><span>初筛通过后，系统会自动收集证据并生成中文报告。</span></div>}</section>;
}

const TWEET_KEYWORDS = ['空投', '积分', '快照', '领取', '测试网', '主网', '上线', 'TGE', 'token', 'airdrop', 'points', 'snapshot', 'claim', 'mainnet', 'testnet', 'launch', '融资', '合作'];
function highlightKeywords(text: string) { const pattern = new RegExp(`(${TWEET_KEYWORDS.map((item) => item.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|')})`, 'gi'); return text.split(pattern).map((part, index) => TWEET_KEYWORDS.some((keyword) => keyword.toLowerCase() === part.toLowerCase()) ? <mark key={index}>{part}</mark> : part); }

function TrenchBoard({ projects, onOpen }: { projects: Project[]; onOpen: (project: Project) => void }) {
  const trenchProjects = projects.filter((project) => project.star >= 3 && project.status !== 'excluded');
  const [signals, setSignals] = useState<Array<Signal & { project: Project }>>([]);
  useEffect(() => { let cancelled = false; void Promise.all(trenchProjects.map(async (project) => { const payload = await api<{ items: Signal[] }>(`/api/projects/${project.id}/signals`).catch(() => ({ items: [] })); return payload.items.map((signal) => ({ ...signal, project })); })).then((groups) => { if (!cancelled) setSignals(groups.flat().sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())); }); return () => { cancelled = true; }; }, [projects]);
  const columns = [
    { key: 'projects', title: '项目流', subtitle: `${trenchProjects.length} 个项目`, items: trenchProjects },
    { key: 'updates', title: '更新流', subtitle: `${signals.filter((item) => item.type === 'profile_change').length} 条`, items: signals.filter((item) => item.type === 'profile_change') },
    { key: 'tweets', title: '推文流', subtitle: `${signals.filter((item) => item.type === 'new_tweet').length} 条`, items: signals.filter((item) => item.type === 'new_tweet') },
    { key: 'ca', title: 'CA 流', subtitle: `${signals.filter((item) => item.type === 'ca').length} 条`, items: signals.filter((item) => item.type === 'ca') }
  ];
  const monitorPending = trenchProjects.some((project) => project.monitorStatus !== 'enabled');
  return <section className="trench-board"><div className="board-intro"><div><p className="eyebrow">TRENCH BOARD / ALPHA MONITOR</p><h2>战壕多列盯盘</h2><p>三星以上项目自动进入战壕；推文命中关键词时高亮显示。关键词：{TWEET_KEYWORDS.slice(0, 8).join('、')} 等</p></div><span className={`monitor-intent ${monitorPending ? 'monitor-pending' : ''}`}>{monitorPending ? 'Alpha 监控同步中：新推文 + CA' : 'Alpha 监控已开启：新推文 + CA'}</span></div><div className="board-columns">{columns.map((column) => <section className={`board-column board-${column.key}`} key={column.key}><header><div><h3>{column.title}</h3><small>{column.subtitle}</small></div><span className="board-live">实时</span></header><div className="board-scroll">{column.key === 'projects' ? (column.items as Project[]).map((project) => <button className="board-project" key={project.id} onClick={() => onOpen(project)}><div className="project-icon small">{project.avatarUrl ? <img src={project.avatarUrl} alt="" /> : project.name.slice(0, 1)}</div><div><strong>{project.name}</strong><small>{project.handle ? `@${project.handle}` : project.xUserId}</small></div><span><Stars value={project.star} /></span></button>) : (column.items as Array<Signal & { project: Project }>).map((signal) => { const text = signal.content ?? ''; const hit = signal.type === 'new_tweet' && TWEET_KEYWORDS.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase())); return <article className={`board-signal ${signal.type === 'ca' ? 'board-signal-ca' : ''} ${hit ? 'keyword-hit' : ''}`} key={signal.id}><div className="board-signal-head"><strong>{signal.project.name}</strong><time>{formatDateTime(signal.occurred_at)}</time></div><small>{signal.project.handle ? `@${signal.project.handle}` : signal.project.xUserId}{signal.common_follow_count != null ? ` · 共同关注 ${signal.common_follow_count}` : ''}</small><p>{signal.type === 'ca' && <b className="ca-label">CA 检测到</b>}{hit && <b className="keyword-label">关键词命中</b>}{signal.type === 'new_tweet' ? highlightKeywords(text) : text || '暂无正文'}</p>{signal.x_post_url && <a href={signal.x_post_url} target="_blank" rel="noreferrer">打开原帖 ↗</a>}</article>; })}{column.items.length === 0 && <div className="board-empty">暂无信号</div>}</div></section>)}</div></section>;
}

function LedgerView({ projects }: { projects: Project[] }) {
  const [items, setItems] = useState<LedgerEntry[]>([]); const [content, setContent] = useState(''); const [projectId, setProjectId] = useState(projects[0]?.id ?? ''); const [saving, setSaving] = useState(false);
  const load = useCallback(() => { void api<{ items: LedgerEntry[] }>('/api/ledger').then((payload) => setItems(payload.items)).catch(() => setItems([])); }, []); useEffect(() => { load(); }, [load]); useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projectId, projects]);
  const add = async () => { if (!content.trim() || !projectId) return; setSaving(true); try { await api('/api/ledger', { method: 'POST', body: JSON.stringify({ projectId, type: 'note', status: 'active', content: content.trim() }) }); setContent(''); load(); } finally { setSaving(false); } };
  return <section className="workspace-panel"><div className="panel-heading"><div><p className="eyebrow">OPERATIONS</p><h2>台账</h2><p>记录参与、任务、成本、结果和个人备注，不连接钱包、不计算盈亏。</p></div></div><div className="inline-form"><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">选择项目</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><input value={content} onChange={(event) => setContent(event.target.value)} placeholder="记录一条台账事项…" /><button className="primary" disabled={saving || !content.trim() || !projectId} onClick={() => void add()}>添加</button></div>{items.length ? <div className="ledger-list">{items.map((item) => <div className="ledger-row" key={item.id}><span className={`ledger-type ${item.type}`}>{item.type === 'note' ? '备注' : item.type}</span><strong>{item.content}</strong><span>{item.status}</span><time>{item.occurred_at ? new Date(item.occurred_at).toLocaleDateString('zh-CN') : new Date(item.created_at).toLocaleDateString('zh-CN')}</time></div>)}</div> : <div className="empty panel-empty">还没有台账记录</div>}</section>;
}

function CalendarView({ projects }: { projects: Project[] }) {
  const [items, setItems] = useState<CalendarEvent[]>([]); const [title, setTitle] = useState(''); const [projectId, setProjectId] = useState(projects[0]?.id ?? ''); const [startsAt, setStartsAt] = useState('');
  const load = useCallback(() => { void api<{ items: CalendarEvent[] }>('/api/calendar').then((payload) => setItems(payload.items)).catch(() => setItems([])); }, []); useEffect(() => { load(); }, [load]); useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projectId, projects]);
  const add = async () => { if (!title.trim() || !startsAt || !projectId) return; await api('/api/calendar', { method: 'POST', body: JSON.stringify({ projectId, title: title.trim(), startsAt, status: 'pending' }) }); setTitle(''); setStartsAt(''); load(); };
  return <section className="workspace-panel"><div className="panel-heading"><div><p className="eyebrow">OPERATIONS</p><h2>台账与日历</h2><p>待确认事件只显示在网站；确认后才会进入提醒流程。</p></div></div><div className="inline-form calendar-form"><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">选择项目</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="事件名称" /><input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /><button className="primary" disabled={!title.trim() || !startsAt || !projectId} onClick={() => void add()}>添加事件</button></div><div className="calendar-list">{items.length ? items.map((item) => <div className="calendar-row" key={item.id}><div className="calendar-date"><strong>{new Date(item.starts_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</strong><small>{new Date(item.starts_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></div><div><strong>{item.title}</strong><span>{item.status === 'confirmed' ? '已确认' : '待确认'}{item.confidence != null ? ` · 置信度 ${Math.round(item.confidence * 100)}%` : ''}</span></div></div>) : <div className="empty panel-empty">还没有日历事件</div>}</div></section>;
}

function SettingsView() { const [status, setStatus] = useState<Record<string, unknown> | null>(null); useEffect(() => { void api<Record<string, unknown>>('/api/system/status').then(setStatus).catch(() => setStatus(null)); }, []); return <section className="workspace-panel"><div className="panel-heading"><div><p className="eyebrow">SYSTEM</p><h2>系统设置与状态</h2><p>Hook、队列和 AI 服务商的运行状态。</p></div></div>{status ? <div className="system-grid"><div><span>Alpha Hook</span><strong className="ok-text">已连接</strong><small>累计收到 {(status.hook as { rawEvents?: number })?.rawEvents ?? 0} 条事件</small></div><div><span>待处理任务</span><strong>{(status.queue as { pending?: number })?.pending ?? 0}</strong><small>死信 {(status.queue as { dead?: number })?.dead ?? 0} 条</small></div><div><span>当前项目</span><strong>{String(status.projects ?? 0)}</strong><small>排除项目不计入</small></div><div><span>AI 服务商</span><strong>{Array.isArray(status.aiProviders) ? status.aiProviders.length : 0}</strong><small>健康状态由 Worker 更新</small></div></div> : <div className="empty panel-empty">无法读取系统状态</div>}<div className="settings-note"><strong>访问密钥</strong><span>当前使用服务端会话 Cookie；密钥不会发送到前端或写入浏览器存储。</span></div></section>; }

function App() {
  const [view, setView] = useState<View>('feed'); const [filter, setFilter] = useState('all'); const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [projects, setProjects] = useState<Project[]>([]); const [selected, setSelected] = useState<Project | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [starAlert, setStarAlert] = useState<StarAlert | null>(null);
  const PAGE_SIZE = 30;
  const backgroundRefreshInFlight = useRef(false);
  // Filter changes can leave multiple requests in flight. Keep a monotonically
  // increasing request id so an older response can never overwrite the
  // currently selected filter (or turn off the loading state for a newer
  // request). Background SSE refreshes are skipped while a foreground load is
  // active to avoid cancelling a user-initiated filter switch.
  const loadRequestId = useRef(0);
  const activeLoad = useRef(false);
  const activeController = useRef<AbortController | null>(null);
  const previousStars = useRef(new Map<string, number>());
  const alertTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (alertTimer.current !== undefined) window.clearTimeout(alertTimer.current); }, []);
  const loadProjects = useCallback(async ({ showLoading = true }: { showLoading?: boolean } = {}) => {
    // Do not let an SSE/timer refresh race a user-triggered filter request.
    if (!showLoading && activeLoad.current) return;
    const requestId = ++loadRequestId.current;
    if (showLoading) {
      activeController.current?.abort();
      activeLoad.current = true;
      setLoading(true);
    }
    const controller = new AbortController();
    activeController.current = controller;
    let timedOut = false;
    const timeoutId = window.setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    const endpointFilter = filter === 'excluded' ? 'excluded' : 'all';
    try {
      // Fetch the complete pool; the UI applies the 30-item page size below.
      const payload = await api<{ items: Array<Record<string, unknown>> }>(`/api/projects?filter=${endpointFilter}&limit=all`, { signal: controller.signal });
      // A response for a previous filter is intentionally discarded.
      if (requestId !== loadRequestId.current) return;
      const nextProjects = payload.items.map(mapProject);
      let newestAlert: StarAlert | null = null;
      for (const project of nextProjects) {
        const previous = previousStars.current.get(project.id);
        if (project.status !== 'excluded' && previous != null && project.star > previous && (!newestAlert || project.star - previous > newestAlert.to - newestAlert.from)) newestAlert = { projectId: project.id, projectName: project.name, handle: project.handle, from: previous, to: project.star };
        previousStars.current.set(project.id, project.star);
      }
      if (newestAlert) {
        setStarAlert(newestAlert);
        if (alertTimer.current !== undefined) window.clearTimeout(alertTimer.current);
        alertTimer.current = window.setTimeout(() => setStarAlert(null), 5000);
      }
      setProjects(nextProjects);
      setError('');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (timedOut && requestId === loadRequestId.current) setError('项目同步超时，请点击刷新重试');
        return;
      }
      if (requestId !== loadRequestId.current) return;
      if (error instanceof Error && error.message === 'unauthorized') { window.location.reload(); return; }
      setError(error instanceof Error ? error.message : '项目加载失败');
    } finally {
      window.clearTimeout(timeoutId);
      if (requestId === loadRequestId.current) {
        if (showLoading) setLoading(false);
        activeLoad.current = false;
        if (activeController.current === controller) activeController.current = null;
      }
    }
  }, [filter]);
  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => {
    const stream = new EventSource('/events');
    let debounceTimer: number | undefined;
    const refresh = () => {
      if (debounceTimer !== undefined) return;
      debounceTimer = window.setTimeout(() => {
        debounceTimer = undefined;
        if (backgroundRefreshInFlight.current) return;
        backgroundRefreshInFlight.current = true;
        void loadProjects({ showLoading: false }).finally(() => { backgroundRefreshInFlight.current = false; });
      }, 300);
    };
    stream.onopen = refresh;
    stream.onmessage = refresh;
    const timer = window.setInterval(refresh, 15_000);
    return () => { stream.close(); window.clearInterval(timer); if (debounceTimer !== undefined) window.clearTimeout(debounceTimer); };
  }, [loadProjects, backgroundRefreshInFlight]);
  const filtered = useMemo(() => projects.filter((project) => matchesProjectFilter(project, filter) && `${project.handle} ${project.name} ${project.xUserId}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    if (/^star_[1-5]$/.test(filter) && b.follows !== a.follows) return b.follows - a.follows;
    const aTime = a.latestSignalAt ? new Date(a.latestSignalAt).getTime() : 0;
    const bTime = b.latestSignalAt ? new Date(b.latestSignalAt).getTime() : 0;
    return bTime - aTime;
  }), [projects, query, filter]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedProjects = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);
  useEffect(() => { setPage(1); }, [filter, query]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const exclude = async (project: Project) => { await api(`/api/projects/${project.id}/exclude`, { method: 'POST', body: JSON.stringify({ reason: '人工排除' }) }); await loadProjects(); if (selected?.id === project.id) setSelected(null); };
  const restore = async (project: Project) => { await api(`/api/projects/${project.id}/restore`, { method: 'POST' }); await loadProjects(); };
  const counts = useMemo(() => ({ all: projects.length, high: projects.filter((item) => item.star >= 3).length, surge: projects.filter((item) => item.surge).length, ca: projects.filter((item) => item.ca).length }), [projects]);
  const nav = [{ id: 'feed' as const, label: '实时信号流', count: counts.all }, { id: 'reports' as const, label: 'AI 调研报告' }, { id: 'trench' as const, label: '战壕看板', count: counts.high }, { id: 'ledger' as const, label: '台账' }, { id: 'calendar' as const, label: '日历' }];
  const visibleProjects = view === 'trench' ? projects.filter((item) => item.star >= 3 && item.status !== 'excluded') : pagedProjects;
  const title = view === 'feed' ? '实时信号流' : view === 'trench' ? '战壕看板' : view === 'reports' ? 'AI 调研报告' : view === 'ledger' ? '台账' : view === 'calendar' ? '日历' : '系统设置';
  return <div className="shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">α</span><div><strong>ALPHA</strong><small>RESEARCH DESK</small></div></div><nav>{nav.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>{item.label}{item.count != null && <b>{item.count}</b>}</button>)}</nav><div className="sidebar-bottom"><div className="live-dot" /> Alpha Hook 已连接 <button onClick={() => setView('settings')}>设置</button></div></aside><main className="main">{starAlert && <div className="star-alert" role="status"><span className="star-alert-icon">★</span><div><strong>星级上升</strong><span>{starAlert.projectName}{starAlert.handle ? ` @${starAlert.handle.replace(/^@/, '')}` : ''} 已从 {starAlert.from} 星升至 {starAlert.to} 星，已归入 {starAlert.to} 星项目。</span></div><button onClick={() => setStarAlert(null)} aria-label="关闭提醒">×</button></div>}<header className="topbar"><div><p className="eyebrow">PRIVATE RESEARCH DESK / {new Date().toLocaleDateString('zh-CN')}</p><h1>{title}</h1></div><div className="header-actions"><span className="sync"><span className="pulse" /> 实时同步中</span><button className="avatar" onClick={() => setView('settings')}>K</button></div></header>{view === 'feed' && <><section className="metrics"><div><span>当前项目</span><strong>{counts.all}</strong><em>实时</em></div><div><span>三星以上</span><strong>{counts.high}</strong><em className="muted">历史最高</em></div><div><span>飙升项目</span><strong>{counts.surge}</strong><em>30 分钟新增 ≥10</em></div><div><span>AI 自动处理</span><strong>{counts.all}</strong><em>无需人工</em></div></section><div className="toolbar"><div className="tabs">{[['all', '全部'], ['star_1', '1星'], ['star_2', '2星'], ['star_3', '3星'], ['star_4', '4星'], ['star_5', '5星'], ['surge', '飙升'], ['ca', 'CA'], ['excluded', '已排除']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => { setFilter(value); setView('feed'); }}>{label}</button>)}</div><label className="search">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或账号" /></label></div>
<div className="feed-head"><span>项目动态 <small>{loading ? '正在同步…' : `共 ${filtered.length} 个 · 第 ${page} / ${totalPages} 页`}</small></span><button onClick={() => void loadProjects()} title="刷新">↻</button></div>
{error && <div className="inline-error">{error}</div>}
<section className="feed">{loading && projects.length === 0 ? <div className="panel-loading">正在同步项目…</div> : visibleProjects.map((project) => <ProjectCard key={project.id} project={project} onDetail={() => setSelected(project)} onExclude={() => void exclude(project)} onRestore={() => void restore(project)} />)}{loading && projects.length > 0 && visibleProjects.length === 0 && <div className="panel-loading">正在同步项目…</div>}{!loading && visibleProjects.length === 0 && <div className="empty"><strong>暂无符合条件的项目</strong><span>AI 自动筛选通过后，项目会直接进入实时信号流。</span></div>}</section><Pagination page={page} totalPages={totalPages} onChange={setPage} /></>}
{view === 'trench' && <TrenchBoard projects={projects} onOpen={setSelected} />}{view === 'reports' && <ReportsView projects={projects} onOpen={setSelected} />}{view === 'ledger' && <LedgerView projects={projects} />}{view === 'calendar' && <CalendarView projects={projects} />}{view === 'settings' && <SettingsView />}</main>{selected && <DetailPanel project={selected} onClose={() => setSelected(null)} onRefresh={() => { void loadProjects(); }} />}</div>;
}

function Root() { const [authState, setAuthState] = useState<'checking' | 'signed_out' | 'signed_in'>('checking'); useEffect(() => { fetch('/api/projects?limit=1', { credentials: 'include' }).then((response) => setAuthState(response.ok || response.status === 200 ? 'signed_in' : 'signed_out')).catch(() => setAuthState('signed_out')); }, []); if (authState === 'checking') return <div className="login-shell"><div className="login-loading">正在连接 Alpha Research Desk…</div></div>; if (authState === 'signed_out') return <LoginView onSuccess={() => setAuthState('signed_in')} />; return <App />; }
createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
