/**
 * API 客户端（第 7 节只读查询 + M3 的写操作）。
 *
 * 约定：
 * - 所有请求带 Cookie（同域部署，Q22）；写操作带同源 Origin 由浏览器自动附加；
 * - 服务端返回的实体版本号用于轮询去重（Q14），前端不重复渲染未变数据；
 * - 任何非 2xx 都抛出结构化错误，页面据此显示“数据服务异常”，绝不显示成空列表（F11）。
 */

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.status = error.status;
    this.code = error.code;
  }
}

export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface VersionedRow {
  version: string;
}

export interface ProjectRow extends VersionedRow {
  projectId: string;
  projectKey: string;
  displayName: string | null;
  link: string | null;
  source: 'natural' | 'restored' | 'history_import';
  poolState: 'monitored' | 'excluded';
  star: number;
  displayPushCount: number;
  confirmedSendCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  enteredPoolAt: string;
  excludedAt: string | null;
  exclusionReason: 'classification' | 'manual' | null;
  hasContractAddress: boolean;
  updatedAt: string;
}

export interface DecisionRow extends VersionedRow {
  decisionId: string;
  eventId: string;
  projectId: string | null;
  projectKey: string | null;
  reasonCode: string;
  decidedAt: string;
  star: number | null;
  previousStar: number | null;
  count: number | null;
  classificationType: string | null;
  classificationConfidence: number | null;
  classificationReason: string | null;
  classificationError: string | null;
  configVersionId: string | null;
  title: string | null;
  link: string | null;
  upstreamPushAtSec: number | null;
  parseError: string | null;
}

export interface ExcludedRow {
  projectId: string;
  projectKey: string;
  displayName: string | null;
  link: string | null;
  exclusionReason: 'classification' | 'manual';
  excludedAt: string | null;
  excludedStar: number | null;
  excludedEventCount: number | null;
  restoreReason: string | null;
  latestReasonCode: string | null;
}

export interface HealthSnapshot {
  lastInboundAt: string | null;
  jobs: Record<string, number>;
  failedJobs: number;
  deadLetterJobs: number;
  pendingDeliveries: number;
  abandonedDeliveries: number;
  uncertainDeliveries: number;
  projects: number;
  excludedProjects: number;
  inboundEvents: number;
  decisions: number;
  sampledAt: string;
  queue?: { queued: number; running: number; failed: number; deadLetter: number; waitingDependency: number; oldestWaitMs: number | null };
  deliveryBacklog?: { pending: number; abandoned: number; uncertain: number; oldestPendingAt: string | null };
  sessions?: { visitors: number; admins: number };
}

export interface SessionInfo {
  authenticated: boolean;
  role?: 'visitor' | 'admin';
  canWrite?: boolean;
  expiresAt?: string | null;
}

export interface ProjectListResponse {
  rows: ProjectRow[];
  page: PageInfo;
}

export interface DecisionListResponse {
  rows: DecisionRow[];
  page: PageInfo;
}

/**
 * 构造查询串：跳过空值，数组用逗号连接，与 M3 路由的解析方式一致。
 */
export type QueryValue = string | number | boolean | null | undefined | readonly string[] | readonly number[];

export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
      continue;
    }
    const text = String(value);
    if (text.length === 0) continue;
    search.set(key, text);
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiRequestError({
      status: response.status,
      code: error?.code ?? 'request_failed',
      message: error?.message ?? `请求失败（HTTP ${response.status}）`
    });
  }
  return parsed as T;
}

export const api = {
  session: () => request<SessionInfo>('/api/auth/session'),
  login: (secret: string) =>
    request<{ role: 'visitor' | 'admin'; expiresAt: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ secret })
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  projects: (params: {
    limit?: number;
    cursor?: string | null;
    search?: string | null;
    stars?: readonly number[];
    state?: 'monitored' | 'excluded' | null;
    source?: 'natural' | 'restored' | 'history_import' | null;
    hasCa?: boolean | null;
    joinedAfter?: string | null;
  }) => request<ProjectListResponse>(`/api/projects${buildQuery(params)}`),

  decisions: (params: { limit?: number; cursor?: string | null; projectId?: string | null; reasons?: readonly string[]; since?: string | null }) =>
    request<DecisionListResponse>(`/api/decisions${buildQuery(params)}`),

  tweets: (params: { projectId?: string | null; limit?: number } = {}) =>
    request<TweetsResponse>(`/api/tweets${buildQuery(params)}`),

  excluded: (limit = 100) => request<{ rows: ExcludedRow[] }>(`/api/excluded${buildQuery({ limit })}`),
  health: () => request<HealthSnapshot>('/api/health'),

  /** 判定排查：按账号查为主入口（Q100）。 */
  diagnose: (account: string) => request<DiagnoseResponse>(`/api/diagnose${buildQuery({ account })}`),

  /** 配置变更时间线（Q102）。 */
  configVersions: (limit = 50) => request<ConfigVersionsResponse>(`/api/config/versions${buildQuery({ limit })}`),
  effectiveConfig: () => request<Record<string, unknown>>('/api/config/effective'),

  /** 写操作：带二次确认标记（Q54/Q74）。 */
  exclude: (projectId: string, body: { reason: 'classification' | 'manual'; note?: string | null }) =>
    request<{ applied: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/exclude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-confirm': 'yes' },
      body: JSON.stringify({ ...body, confirm: true })
    }),

  restore: (projectId: string, reason: string | null) =>
    request<{ applied: boolean; jobCreated: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-confirm': 'yes' },
      body: JSON.stringify({ reason, confirm: true })
    }),

  projectDetail: (projectId: string) => request<ProjectDetailResponse>(`/api/projects/${encodeURIComponent(projectId)}`),

  /** 提权：把当前只读会话升级为管理员（Q106）。只改角色，不新建会话。 */
  elevate: (adminPassword: string) =>
    request<{ ok: boolean; role: 'admin' | null }>('/api/auth/elevate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminPassword })
    }),

  /** 审计记录（Q50/Q62；不含身份，Q75/Q85）。 */
  audit: (params: { limit?: number; cursor?: string | null; action?: string | null } = {}) =>
    request<AuditResponse>(`/api/audit${buildQuery(params)}`),

  /** 立即检索一次喊单（Q116）。数据源未配置时返回 409，页面需如实提示。 */
  refreshTweets: (projectId?: string | null) =>
    request<TweetPollResult>('/api/tweets/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(projectId ? { projectId } : {})
    }),

  deliveryPreview: (deliveryId: string) =>
    request<DeliveryPreview>(`/api/deliveries/${encodeURIComponent(deliveryId)}/preview`),

  replayDelivery: (deliveryId: string, reason: string) =>
    request<{ applied: boolean }>(`/api/deliveries/${encodeURIComponent(deliveryId)}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-confirm': 'yes' },
      body: JSON.stringify({ reason, confirm: true })
    })
};

export interface ProjectReport {
  reportId: string;
  kind: 'standard' | 'deep';
  model: string | null;
  promptVersion: string | null;
  generatedAt: string | null;
  generatedAtMissing: boolean;
  triggeredBy: 'natural' | 'restore';
  body: string;
  bodyLength: number;
  responseId: string | null;
  reportedModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ProjectDelivery {
  deliveryId: string;
  reportId: string | null;
  purpose: string;
  targetChatId: string | null;
  targetThreadMessageId: number | null;
  shardIndex: number;
  attempts: number;
  sentAt: string | null;
  messageId: number | null;
  lastError: string | null;
  uncertain: boolean;
  abandoned: boolean;
}

export interface ProjectDetailResponse {
  project: ProjectRow;
  reports: ProjectReport[];
  deliveries: ProjectDelivery[];
  links: { channel: string | null; discussion: string | null };
  timeline: DecisionRow[];
  latestConfigVersionId: string | null;
}

export interface DeliveryPreview {
  deliveryId: string;
  projectId: string;
  reportId: string | null;
  purpose: string;
  targetChatId: string | null;
  targetThreadMessageId: number | null;
  shardIndex: number;
  attempts: number;
  lastError: string | null;
  uncertain: boolean;
  alreadySent: boolean;
  sentAt: string | null;
  messageId: number | null;
  bodyExcerpt: string | null;
  bodyLength: number | null;
  replayable: boolean;
  blockedBy: 'already_sent' | 'cooldown' | 'not_found' | null;
  cooldownEndsAt: string | null;
  historyCount: number;
}

/** 在 api 对象上补充详情与重放预览（保持调用风格一致）。 */
export const projectDetailApi = {
  detail: (projectId: string) => request<ProjectDetailResponse>(`/api/projects/${encodeURIComponent(projectId)}`),
  deliveryPreview: (deliveryId: string) =>
    request<DeliveryPreview>(`/api/deliveries/${encodeURIComponent(deliveryId)}/preview`)
};

export interface DiagnoseResponse {
  found: boolean;
  query: string;
  normalizedKey: string;
  project?: ProjectRow;
  timeline: DecisionRow[];
}

export interface ConfigVersionRow {
  configVersionId: string;
  hash: string;
  effectiveAt: string;
  changedFields: string[];
  snapshot: {
    starLevels: number[];
    maxStar: number;
    classificationModel: string | null;
    standardModel: string | null;
    deepModel: string | null;
    searchTools: string[];
    deepSearchTools: string[];
    classificationConcurrency: number;
    standardConcurrency: number;
    deepConcurrency: number;
    requestTimeoutMs: { classification: number; standard: number; deep: number };
    analysisMaxAttempts: number;
    deepAnalysisMaxAttempts: number;
    telegramRetryAttempts: number;
  };
}

export interface ConfigVersionsResponse {
  versions: ConfigVersionRow[];
  currentVersionId: string | null;
}

export interface TweetFeedRow {
  tweetId: string;
  authorHandle: string | null;
  authorName: string | null;
  authorVerified: boolean | null;
  authorFollowers: number | null;
  body: string;
  postedAt: string | null;
  likeCount: number | null;
  retweetCount: number | null;
  replyCount: number | null;
  viewCount: number | null;
  url: string | null;
  source: string;
  firstSeenAt: string;
  summaryStatus: 'pending' | 'done' | 'failed';
  summaryText: string | null;
  mentionedProjects: Array<{ projectId: string; projectKey: string }>;
}

export interface TweetsResponse {
  rows: TweetFeedRow[];
  freshness: { lastSuccessAt: string | null; failingProjects: number; pendingSummaries: number };
}

export interface AuditRecordRow {
  auditId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  beforeSummary: string | null;
  afterSummary: string | null;
  occurredAt: string;
}

export interface AuditResponse {
  rows: AuditRecordRow[];
  page: { nextCursor: string | null; hasMore: boolean; limit: number };
}

/** “立即查一次”的结果（Q116）。skipped 表示数据源未配置，reason 说明原因。 */
export interface TweetPollResult {
  source: string;
  handles: number;
  fetched: number;
  created: number;
  filteredOut: number;
  newMentions: string[];
  failures: Array<{ handles: string[]; error: string }>;
  skipped: boolean;
  reason: string | null;
  polledAt: string;
}
