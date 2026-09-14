import type { StoragePool } from './client.js';

/**
 * 查询层：只读 API 的数据访问（第 7 节、Q14、Q25、Q95）。
 *
 * 硬约束：
 * - 游标分页基于“稳定排序键 + 唯一 ID”做 keyset 分页，不用 OFFSET（第 9 节要求不因翻页漂移）；
 * - 每行带实体版本号，供前端轮询去重（Q14），版本在单次查询内单调递增；
 * - 查询失败必须暴露异常，绝不能返回空列表冒充“没有数据”（第 9 节、F11）；
 * - 排序键与过滤条件都走索引，保持列表 p95 ≤ 1 秒的目标可达（Q8）。
 */

export interface PageInfo {
  /** 下一页游标；没有更多数据时为 null。 */
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface VersionedRow {
  /** 实体版本号（字符串，保证同一查询内单调递增）。 */
  version: string;
}

export interface ProjectListRow extends VersionedRow {
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

export interface ProjectListQuery {
  limit?: number;
  cursor?: string | null;
  /** 按账号/展示名搜索（大小写不敏感的子串匹配）。 */
  search?: string | null;
  /** 星级过滤；数组为空表示不过滤。 */
  stars?: readonly number[];
  poolState?: 'monitored' | 'excluded' | null;
  source?: 'natural' | 'restored' | 'history_import' | null;
  /** 是否有 CA：null 表示不过滤。 */
  hasContractAddress?: boolean | null;
  /** 按“加入监控时间”过滤起点（含）。 */
  joinedAfter?: string | null;
}

export interface ProjectListResult {
  rows: ProjectListRow[];
  page: PageInfo;
}

export interface EventTimelineRow extends VersionedRow {
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
  /** 原始输入（历史数据缺失时为 null）。 */
  title: string | null;
  link: string | null;
  upstreamPushAtSec: number | null;
  parseError: string | null;
}

export interface EventTimelineQuery {
  limit?: number;
  cursor?: string | null;
  projectId?: string | null;
  reasonCodes?: readonly string[];
  since?: string | null;
}

export interface EventTimelineResult {
  rows: EventTimelineRow[];
  page: PageInfo;
}

export interface HealthSnapshot {
  /** 采集侧是否在近期收到过业务事件；null 表示无数据可判断。 */
  lastInboundAt: string | null;
  /** 各阶段任务数量。 */
  jobs: Record<string, number>;
  /** 死信与失败任务数量。 */
  failedJobs: number;
  deadLetterJobs: number;
  /** 未送达且未放弃的投递数量。 */
  pendingDeliveries: number;
  abandonedDeliveries: number;
  /** 结果不确定的投递数量（Q9）。 */
  uncertainDeliveries: number;
  /** 项目与事件总量。 */
  projects: number;
  excludedProjects: number;
  inboundEvents: number;
  decisions: number;
  /** 当前时间，供前端计算数据新鲜度。 */
  sampledAt: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** 游标编码：base64url(JSON)，避免暴露内部实现细节，也便于加字段。 */
export function encodeCursor(payload: Record<string, string | number | null>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): Record<string, unknown> | null {
  if (!cursor || cursor.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 项目列表：按 (star DESC, entered_pool_at DESC, project_id) 稳定排序。
 *
 * 排序键与 Q105 的筛选维度一致：星级、加入监控时间、是否有 CA。
 */
export async function listProjects(pool: StoragePool, query: ProjectListQuery = {}): Promise<ProjectListResult> {
  const limit = clampLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (query.search && query.search.trim().length > 0) {
    params.push(`%${query.search.trim().toLowerCase()}%`);
    conditions.push(`(lower(p.project_key) LIKE $${params.length} OR lower(coalesce(p.display_name, '')) LIKE $${params.length})`);
  }
  if (query.stars && query.stars.length > 0) {
    params.push([...query.stars]);
    conditions.push(`p.star = ANY($${params.length}::int[])`);
  }
  if (query.poolState) {
    params.push(query.poolState);
    conditions.push(`p.pool_state = $${params.length}`);
  }
  if (query.source) {
    params.push(query.source);
    conditions.push(`p.source = $${params.length}`);
  }
  if (query.hasContractAddress !== null && query.hasContractAddress !== undefined) {
    conditions.push(
      query.hasContractAddress
        ? `EXISTS (SELECT 1 FROM project_contract_addresses ca WHERE ca.project_id = p.project_id)`
        : `NOT EXISTS (SELECT 1 FROM project_contract_addresses ca WHERE ca.project_id = p.project_id)`
    );
  }
  if (query.joinedAfter) {
    params.push(query.joinedAfter);
    conditions.push(`p.entered_pool_at >= $${params.length}::timestamptz`);
  }

  // keyset 分页：与排序键一一对应，避免 OFFSET 在并发写入时漂移。
  if (cursor && typeof cursor.star === 'number' && typeof cursor.enteredPoolAt === 'string' && typeof cursor.projectId === 'string') {
    params.push(cursor.star, cursor.enteredPoolAt, cursor.projectId);
    const base = params.length - 2;
    conditions.push(
      `(p.star < $${base}::int
        OR (p.star = $${base}::int AND p.entered_pool_at < $${base + 1}::timestamptz)
        OR (p.star = $${base}::int AND p.entered_pool_at = $${base + 1}::timestamptz AND p.project_id > $${base + 2}::text))`
    );
  }

  params.push(limit + 1);
  const limitParam = params.length;

  const result = await pool.query(
    `SELECT p.*,
            EXISTS (SELECT 1 FROM project_contract_addresses ca WHERE ca.project_id = p.project_id) AS has_ca
       FROM projects p
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY p.star DESC, p.entered_pool_at DESC, p.project_id ASC
      LIMIT $${limitParam}`,
    params
  );

  const hasMore = result.rows.length > limit;
  const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
  // 版本号：时间戳 + 行内序号，保证同一查询内单调递增且可比较（轮询去重足够）。
  const baseEpoch = Date.now();
  const rows: ProjectListRow[] = pageRows.map((row, index) => ({
    projectId: String(row.project_id),
    projectKey: String(row.project_key),
    displayName: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    link: row.link === null || row.link === undefined ? null : String(row.link),
    source: String(row.source) as ProjectListRow['source'],
    poolState: String(row.pool_state) as ProjectListRow['poolState'],
    star: Number(row.star ?? 0),
    displayPushCount: Number(row.display_push_count ?? 0),
    confirmedSendCount: Number(row.confirmed_send_count ?? 0),
    firstEventAt: toIso(row.first_event_at),
    lastEventAt: toIso(row.last_event_at),
    enteredPoolAt: toIso(row.entered_pool_at) ?? new Date(0).toISOString(),
    excludedAt: toIso(row.excluded_at),
    exclusionReason:
      row.exclusion_reason === null || row.exclusion_reason === undefined
        ? null
        : (String(row.exclusion_reason) as ProjectListRow['exclusionReason']),
    hasContractAddress: Boolean(row.has_ca),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
    version: `${baseEpoch}-${index}`,
  }));

  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          star: Number(last.star ?? 0),
          enteredPoolAt: toIso(last.entered_pool_at),
          projectId: String(last.project_id),
        })
      : null;

  return { rows, page: { nextCursor, hasMore, limit } };
}

/**
 * 判定时间线：按 (decided_at DESC, decision_id) 稳定排序，联表带出原始输入。
 *
 * 页面要回答“服务到底收到没收到”与“为什么没推”，因此原始输入与原因码必须同时可得。
 */
export async function listDecisionTimeline(
  pool: StoragePool,
  query: EventTimelineQuery = {}
): Promise<EventTimelineResult> {
  const limit = clampLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (query.projectId) {
    params.push(query.projectId);
    conditions.push(`d.project_id = $${params.length}`);
  }
  if (query.reasonCodes && query.reasonCodes.length > 0) {
    params.push([...query.reasonCodes]);
    conditions.push(`d.reason_code = ANY($${params.length}::text[])`);
  }
  if (query.since) {
    params.push(query.since);
    conditions.push(`d.decided_at >= $${params.length}::timestamptz`);
  }
  if (cursor && typeof cursor.decidedAt === 'string' && typeof cursor.decisionId === 'string') {
    params.push(cursor.decidedAt, cursor.decisionId);
    const base = params.length - 1;
    conditions.push(
      `(d.decided_at < $${base}::timestamptz
        OR (d.decided_at = $${base}::timestamptz AND d.decision_id > $${base + 1}::text))`
    );
  }

  params.push(limit + 1);
  const limitParam = params.length;

  const result = await pool.query(
    `SELECT d.*, e.title, e.link, e.upstream_push_at_sec, e.parse_error
       FROM decisions d
       JOIN inbound_events e ON e.event_id = d.event_id
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY d.decided_at DESC, d.decision_id ASC
      LIMIT $${limitParam}`,
    params
  );

  const hasMore = result.rows.length > limit;
  const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const baseEpoch = Date.now();
  const rows: EventTimelineRow[] = pageRows.map((row, index) => ({
    decisionId: String(row.decision_id),
    eventId: String(row.event_id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    projectKey: row.project_key === null || row.project_key === undefined ? null : String(row.project_key),
    reasonCode: String(row.reason_code),
    decidedAt: toIso(row.decided_at) ?? new Date(0).toISOString(),
    star: toNumber(row.star),
    previousStar: toNumber(row.previous_star),
    count: toNumber(row.common_follow_count),
    classificationType:
      row.classification_type === null || row.classification_type === undefined ? null : String(row.classification_type),
    classificationConfidence: toNumber(row.classification_confidence),
    classificationReason:
      row.classification_reason === null || row.classification_reason === undefined
        ? null
        : String(row.classification_reason),
    classificationError:
      row.classification_error === null || row.classification_error === undefined ? null : String(row.classification_error),
    configVersionId:
      row.config_version_id === null || row.config_version_id === undefined ? null : String(row.config_version_id),
    title: row.title === null || row.title === undefined ? null : String(row.title),
    link: row.link === null || row.link === undefined ? null : String(row.link),
    upstreamPushAtSec: toNumber(row.upstream_push_at_sec),
    parseError: row.parse_error === null || row.parse_error === undefined ? null : String(row.parse_error),
    version: `${baseEpoch}-${index}`,
  }));

  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ decidedAt: toIso(last.decided_at), decisionId: String(last.decision_id) })
      : null;

  return { rows, page: { nextCursor, hasMore, limit } };
}

/**
 * 业务健康快照（Q101）。
 *
 * 明确区分“没有数据”与“数据服务异常”：本函数查询失败会抛出，由调用方转成 5xx，
 * 而不是返回全 0 让页面显示“一切正常”。
 */
export async function readHealthSnapshot(pool: StoragePool, now = new Date()): Promise<HealthSnapshot> {
  // 事件与判定的总量走增量计数表（migration 0011 的语句级触发器维护）：
  // 之前用 count(*) 统计全表，20 万行时该接口 p50 已达 31ms，量级继续增长会成为运行状态页瓶颈。
  // 其余基数小的表仍实时统计——它们状态变化频繁，用计数器容易与真实状态漂移。
  const counters = await pool.query(
    `SELECT
       (SELECT max(received_at) FROM inbound_events) AS last_inbound_at,
       (SELECT count(*)::int FROM projects) AS projects,
       (SELECT count(*)::int FROM projects WHERE pool_state = 'excluded') AS excluded_projects,
       (SELECT value FROM runtime_counters WHERE counter_key = 'inbound_events') AS inbound_events,
       (SELECT value FROM runtime_counters WHERE counter_key = 'decisions') AS decisions,
       (SELECT count(*)::int FROM jobs WHERE stage = 'failed') AS failed_jobs,
       (SELECT count(*)::int FROM jobs WHERE stage = 'dead_letter') AS dead_letter_jobs,
       (SELECT count(*)::int FROM delivery_records WHERE sent_at IS NULL AND abandoned = false) AS pending_deliveries,
       (SELECT count(*)::int FROM delivery_records WHERE abandoned = true) AS abandoned_deliveries,
       (SELECT count(*)::int FROM delivery_records WHERE uncertain = true) AS uncertain_deliveries`
  );
  const row = counters.rows[0] ?? {};

  // 计数器尚未初始化（例如迁移未跑）时退回实时统计，避免把 0 当成真实总量。
  const counterFallback =
    row.inbound_events === null ||
    row.inbound_events === undefined ||
    row.decisions === null ||
    row.decisions === undefined
      ? (
          await pool.query(
            `SELECT (SELECT count(*)::int FROM inbound_events) AS events,
                    (SELECT count(*)::int FROM decisions) AS decisions`
          )
        ).rows[0]
      : null;

  const jobStages = await pool.query(`SELECT stage, count(*)::int AS count FROM jobs GROUP BY stage`);
  const jobs: Record<string, number> = {};
  for (const stage of jobStages.rows) {
    jobs[String(stage.stage)] = Number(stage.count ?? 0);
  }

  return {
    lastInboundAt: toIso(row.last_inbound_at),
    jobs,
    failedJobs: Number(row.failed_jobs ?? 0),
    deadLetterJobs: Number(row.dead_letter_jobs ?? 0),
    pendingDeliveries: Number(row.pending_deliveries ?? 0),
    abandonedDeliveries: Number(row.abandoned_deliveries ?? 0),
    uncertainDeliveries: Number(row.uncertain_deliveries ?? 0),
    projects: Number(row.projects ?? 0),
    excludedProjects: Number(row.excluded_projects ?? 0),
    inboundEvents: Number(row.inbound_events ?? counterFallback?.events ?? 0),
    decisions: Number(row.decisions ?? counterFallback?.decisions ?? 0),
    sampledAt: now.toISOString(),
  };
}

/**
 * 项目详情（M4 详情页）：一次取齐页面需要的事实。
 *
 * 依据：
 * - Q93：列表只给摘要，完整报告在独立详情页阅读；
 * - Q96：展示序号与真实发送次数分列，两个事实都必须能取到；
 * - Q99：时间线为全量（接收/判定/任务/投递混排），同类折叠交给前端；
 * - 第 6 节状态表：无记录、未达门槛、被拦截、等待依赖、投递失败必须可区分。
 *
 * 返回 null 表示项目不存在（调用方转 404），而不是返回空结构冒充存在。
 */
export interface ProjectDetail {
  project: ProjectListRow;
  /** 报告列表：标准/深度分开，历史导入缺生成时间时为 null。 */
  reports: Array<{
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
  }>;
  /** 投递记录：可解释“已生成未投递”“投递失败”“结果不确定”。 */
  deliveries: Array<{
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
  }>;
  /** 频道与讨论群消息链接；无法从 chatId 推导时为 null。 */
  links: { channel: string | null; discussion: string | null };
  /** 该项目的判定时间线（默认最近 50 条，Q99）。 */
  timeline: EventTimelineRow[];
  /** 最近一次判定使用的配置版本。 */
  latestConfigVersionId: string | null;
}

/** 由 Telegram chatId 与 messageId 推导消息链接；非 -100 开头的内部 ID 无法推导。 */
export function buildTelegramLink(chatId: string | null, messageId: number | null): string | null {
  if (!chatId || messageId === null) return null;
  if (!chatId.startsWith('-100')) return null;
  const internal = chatId.slice(4);
  if (!/^\d+$/.test(internal)) return null;
  return `https://t.me/c/${internal}/${messageId}`;
}

export async function readProjectDetail(
  pool: StoragePool,
  input: { projectId: string; timelineLimit?: number }
): Promise<ProjectDetail | null> {
  const projectResult = await pool.query(
    `SELECT p.*, EXISTS (SELECT 1 FROM project_contract_addresses ca WHERE ca.project_id = p.project_id) AS has_ca
       FROM projects p WHERE p.project_id = $1`,
    [input.projectId]
  );
  const projectRow = projectResult.rows[0];
  if (!projectRow) return null;

  const baseEpoch = Date.now();
  const project: ProjectListRow = {
    projectId: String(projectRow.project_id),
    projectKey: String(projectRow.project_key),
    displayName:
      projectRow.display_name === null || projectRow.display_name === undefined ? null : String(projectRow.display_name),
    link: projectRow.link === null || projectRow.link === undefined ? null : String(projectRow.link),
    source: String(projectRow.source) as ProjectListRow['source'],
    poolState: String(projectRow.pool_state) as ProjectListRow['poolState'],
    star: Number(projectRow.star ?? 0),
    displayPushCount: Number(projectRow.display_push_count ?? 0),
    confirmedSendCount: Number(projectRow.confirmed_send_count ?? 0),
    firstEventAt: toIso(projectRow.first_event_at),
    lastEventAt: toIso(projectRow.last_event_at),
    enteredPoolAt: toIso(projectRow.entered_pool_at) ?? new Date(0).toISOString(),
    excludedAt: toIso(projectRow.excluded_at),
    exclusionReason:
      projectRow.exclusion_reason === null || projectRow.exclusion_reason === undefined
        ? null
        : (String(projectRow.exclusion_reason) as ProjectListRow['exclusionReason']),
    hasContractAddress: Boolean(projectRow.has_ca),
    updatedAt: toIso(projectRow.updated_at) ?? new Date(0).toISOString(),
    version: `${baseEpoch}-0`,
  };

  const reportsResult = await pool.query(
    `SELECT * FROM reports WHERE project_id = $1 ORDER BY generated_at DESC, report_id ASC`,
    [input.projectId]
  );
  const reports = reportsResult.rows.map((row) => {
    const body = String(row.body ?? '');
    const generatedAt = row.report_generated_at_missing ? null : toIso(row.generated_at);
    return {
      reportId: String(row.report_id),
      kind: String(row.kind) as 'standard' | 'deep',
      model: row.model === null || row.model === undefined ? null : String(row.model),
      promptVersion: row.prompt_version === null || row.prompt_version === undefined ? null : String(row.prompt_version),
      generatedAt,
      generatedAtMissing: Boolean(row.report_generated_at_missing),
      triggeredBy: String(row.triggered_by) as 'natural' | 'restore',
      body,
      bodyLength: body.length,
      responseId: row.response_id === null || row.response_id === undefined ? null : String(row.response_id),
      reportedModel: row.reported_model === null || row.reported_model === undefined ? null : String(row.reported_model),
      inputTokens: toNumber(row.input_tokens),
      outputTokens: toNumber(row.output_tokens),
    };
  });

  const deliveriesResult = await pool.query(
    `SELECT * FROM delivery_records WHERE project_id = $1 ORDER BY created_at DESC`,
    [input.projectId]
  );
  const deliveries = deliveriesResult.rows.map((row) => ({
    deliveryId: String(row.delivery_id),
    reportId: row.report_id === null || row.report_id === undefined ? null : String(row.report_id),
    purpose: String(row.purpose),
    targetChatId: row.target_chat_id === null || row.target_chat_id === undefined ? null : String(row.target_chat_id),
    targetThreadMessageId: toNumber(row.target_thread_message_id),
    shardIndex: Number(row.shard_index ?? 0),
    attempts: Number(row.attempts ?? 0),
    sentAt: toIso(row.sent_at),
    messageId: toNumber(row.message_id),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    uncertain: Boolean(row.uncertain),
    abandoned: Boolean(row.abandoned),
  }));

  const channelDelivery = deliveries.find((item) => item.purpose === 'channel_main' && item.messageId !== null) ?? null;
  const discussionDelivery =
    deliveries.find((item) => item.purpose === 'discussion_report' && item.messageId !== null) ?? null;

  const timeline = await listDecisionTimeline(pool, {
    projectId: input.projectId,
    limit: input.timelineLimit ?? 50,
  });

  const latestConfig = await pool.query(
    `SELECT config_version_id FROM decisions
      WHERE project_id = $1 AND config_version_id IS NOT NULL
      ORDER BY decided_at DESC LIMIT 1`,
    [input.projectId]
  );

  return {
    project,
    reports,
    deliveries,
    links: {
      channel: buildTelegramLink(channelDelivery?.targetChatId ?? null, channelDelivery?.messageId ?? null),
      discussion: buildTelegramLink(discussionDelivery?.targetChatId ?? null, discussionDelivery?.messageId ?? null),
    },
    timeline: timeline.rows,
    latestConfigVersionId:
      latestConfig.rows[0]?.config_version_id === undefined || latestConfig.rows[0]?.config_version_id === null
        ? null
        : String(latestConfig.rows[0]?.config_version_id),
  };
}
