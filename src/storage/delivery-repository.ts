import type { StoragePool } from './client.js';

/**
 * 投递仓储：投递意图的登记、领取、结果与预算。
 *
 * 依据：
 * - Q55-D：投递是独立记录，报告生成与外部投递彻底分离；
 * - Q9：至少一次语义，允许偶发重复，但不得隐藏尝试历史；
 * - 第 8.1 节：单条可恢复故障最多 20 次自动尝试，之后告警并保留待处理记录；
 * - 第 4 节：投递以业务目的、目标与分片号保证唯一意图。
 */

export const MAX_DELIVERY_ATTEMPTS = 20;

export interface EnqueueDeliveryInput {
  projectId: string;
  reportId: string | null;
  purpose: 'channel_main' | 'discussion_report' | 'discussion_thread';
  targetChatId: string | null;
  targetThreadMessageId?: number | null;
  shardIndex?: number;
  /** 可投递时间；默认立即可投。 */
  notBefore?: string | null;
}

export interface DeliveryRow {
  deliveryId: string;
  projectId: string;
  reportId: string | null;
  purpose: string;
  targetChatId: string | null;
  targetThreadMessageId: number | null;
  shardIndex: number;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  messageId: number | null;
  sentAt: string | null;
  uncertain: boolean;
  abandoned: boolean;
}

function stableId(prefix: string, ...parts: Array<string | number | null | undefined>): string {
  const text = parts.map((part) => (part === null || part === undefined ? '' : String(part))).join('\u0000');
  return `${prefix}_${Buffer.from(text).toString('base64url').slice(0, 32)}`;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function mapDelivery(row: Record<string, unknown>): DeliveryRow {
  return {
    deliveryId: String(row.delivery_id),
    projectId: String(row.project_id),
    reportId: row.report_id === null || row.report_id === undefined ? null : String(row.report_id),
    purpose: String(row.purpose),
    targetChatId: row.target_chat_id === null || row.target_chat_id === undefined ? null : String(row.target_chat_id),
    targetThreadMessageId:
      row.target_thread_message_id === null || row.target_thread_message_id === undefined
        ? null
        : Number(row.target_thread_message_id),
    shardIndex: Number(row.shard_index ?? 0),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: toIso(row.next_attempt_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    messageId: row.message_id === null || row.message_id === undefined ? null : Number(row.message_id),
    sentAt: toIso(row.sent_at),
    uncertain: Boolean(row.uncertain),
    abandoned: Boolean(row.abandoned),
  };
}

/**
 * 登记投递意图。同一业务目的 + 报告 + 目标 + 分片重复登记是幂等的：
 * 返回既有记录，不产生第二条意图（第 5 节唯一约约束）。
 */
export async function enqueueDelivery(
  pool: StoragePool,
  input: EnqueueDeliveryInput
): Promise<{ deliveryId: string; created: boolean }> {
  const shardIndex = input.shardIndex ?? 0;
  const deliveryId = stableId('dlv', input.purpose, input.reportId, input.targetChatId, input.targetThreadMessageId, shardIndex);
  const inserted = await pool.query(
    `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, target_thread_message_id,
                                   shard_index, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
     ON CONFLICT DO NOTHING`,
    [
      deliveryId,
      input.projectId,
      input.reportId,
      input.purpose,
      input.targetChatId,
      input.targetThreadMessageId ?? null,
      shardIndex,
      input.notBefore ?? null,
    ]
  );
  if ((inserted.rowCount ?? 0) > 0) return { deliveryId, created: true };

  // 已存在同一意图：回查真实 ID（可能由历史导入或其他路径写入）。
  const existing = await pool.query(
    `SELECT delivery_id FROM delivery_records
      WHERE purpose = $1 AND coalesce(report_id, '') = coalesce($2, '')
        AND coalesce(target_chat_id, '') = coalesce($3, '')
        AND coalesce(target_thread_message_id, 0) = coalesce($4, 0)
        AND shard_index = $5
      LIMIT 1`,
    [input.purpose, input.reportId, input.targetChatId, input.targetThreadMessageId ?? null, shardIndex]
  );
  return { deliveryId: String(existing.rows[0]?.delivery_id ?? deliveryId), created: false };
}

export interface ClaimDeliveriesOptions {
  owner?: string;
  limit?: number;
  now?: Date;
}

/**
 * 领取待投递记录：未送达、未放弃、退避到点。
 * 领取即计一次物理尝试（与模型重试预算分开）。
 */
export async function claimPendingDeliveries(
  pool: StoragePool,
  options: ClaimDeliveriesOptions = {}
): Promise<DeliveryRow[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 10;
  return pool.transaction(async (client) => {
    const candidates = await client.query(
      `SELECT delivery_id FROM delivery_records
        WHERE sent_at IS NULL AND abandoned = false
          AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz)
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), limit]
    );
    const claimed: DeliveryRow[] = [];
    for (const row of candidates.rows) {
      const updated = await client.query(
        `UPDATE delivery_records
            SET attempts = attempts + 1, updated_at = $1::timestamptz
          WHERE delivery_id = $2
          RETURNING *`,
        [now.toISOString(), String(row.delivery_id)]
      );
      const mapped = updated.rows[0];
      if (mapped) claimed.push(mapDelivery(mapped));
    }
    return claimed;
  });
}

/** 标记已发送：记录频道/讨论群消息 ID，并累计真实发送次数（Q96）。 */
export async function markDeliverySent(
  pool: StoragePool,
  input: { deliveryId: string; chatId: string | number; messageId: number; sentAt?: Date }
): Promise<void> {
  const sentAt = (input.sentAt ?? new Date()).toISOString();
  await pool.transaction(async (client) => {
    const updated = await client.query(
      `UPDATE delivery_records
          SET message_id = $2, sent_at = $3::timestamptz, last_error = NULL, uncertain = false,
              next_attempt_at = NULL, updated_at = $3::timestamptz
        WHERE delivery_id = $1
        RETURNING project_id, purpose`,
      [input.deliveryId, input.messageId, sentAt]
    );
    const row = updated.rows[0];
    if (!row) return;
    // 真实发送次数只统计已确认回执，与频道展示序号分离（Q96）。
    await client.query(`UPDATE projects SET confirmed_send_count = confirmed_send_count + 1, updated_at = $2::timestamptz WHERE project_id = $1`, [
      String(row.project_id),
      sentAt,
    ]);
  });
}

export interface DeliveryFailureInput {
  deliveryId: string;
  error: string;
  /** 是否为永久错误（配置错误、目标不存在等）；永久错误直接进入待处理而不继续重试。 */
  permanent?: boolean;
  /** 远端可能已收到但本地未确认（Q9）。 */
  uncertain?: boolean;
  nextAttemptAt?: string | null;
  now?: Date;
}

export interface DeliveryFailureResult {
  attempts: number;
  abandoned: boolean;
  /** 是否应当告警（预算耗尽或永久错误）。 */
  shouldAlert: boolean;
}

/**
 * 记录投递失败：
 * - 可恢复失败：安排退避重试；达到尝试上限则放弃并告警；
 * - 永久失败：不再自动重试，保留待处理记录供人工修复后重放（F7）。
 */
export async function recordDeliveryFailure(
  pool: StoragePool,
  input: DeliveryFailureInput
): Promise<DeliveryFailureResult> {
  const now = (input.now ?? new Date()).toISOString();
  return pool.transaction(async (client) => {
    const current = await client.query(`SELECT attempts FROM delivery_records WHERE delivery_id = $1 FOR UPDATE`, [
      input.deliveryId,
    ]);
    const attempts = Number(current.rows[0]?.attempts ?? 0);
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    const abandoned = exhausted || input.permanent === true;

    await client.query(
      `UPDATE delivery_records
          SET last_error = $2,
              uncertain = $3,
              abandoned = $4,
              next_attempt_at = CASE WHEN $4::boolean THEN NULL ELSE $5::timestamptz END,
              updated_at = $1::timestamptz
        WHERE delivery_id = $6`,
      [now, input.error, input.uncertain ?? false, abandoned, input.nextAttemptAt ?? now, input.deliveryId]
    );

    return { attempts, abandoned, shouldAlert: abandoned };
  });
}

/** 等待依赖（如讨论映射未就绪）：不算失败、不消耗预算，条件满足后重新领取。 */
export async function deferDeliveryForDependency(
  pool: StoragePool,
  input: { deliveryId: string; reason: string; nextAttemptAt?: string | null; now?: Date }
): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  await pool.query(
    `UPDATE delivery_records
        SET last_error = $2, next_attempt_at = $3::timestamptz, updated_at = $1::timestamptz
      WHERE delivery_id = $4`,
    [now, input.reason, input.nextAttemptAt ?? null, input.deliveryId]
  );
}

/** 远端可能已收到但本地未确认（Q9）：记录不确定状态并继续补发。 */
export async function markDeliveryUncertain(
  pool: StoragePool,
  input: { deliveryId: string; error: string; nextAttemptAt?: string | null; now?: Date }
): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  await pool.query(
    `UPDATE delivery_records
        SET uncertain = true, last_error = $2, next_attempt_at = $3::timestamptz, updated_at = $1::timestamptz
      WHERE delivery_id = $4`,
    [now, input.error, input.nextAttemptAt ?? now, input.deliveryId]
  );
}

export interface DeliveryBacklogMetrics {
  pending: number;
  abandoned: number;
  uncertain: number;
  oldestPendingAt: string | null;
}

/** 运行状态页需要的投递积压指标（Q101）。 */
export async function readDeliveryBacklog(pool: StoragePool): Promise<DeliveryBacklogMetrics> {
  const result = await pool.query(
    `SELECT
       count(*) FILTER (WHERE sent_at IS NULL AND abandoned = false)::int AS pending,
       count(*) FILTER (WHERE abandoned = true)::int AS abandoned,
       count(*) FILTER (WHERE uncertain = true)::int AS uncertain,
       min(created_at) FILTER (WHERE sent_at IS NULL AND abandoned = false) AS oldest
     FROM delivery_records`
  );
  const row = result.rows[0] ?? {};
  return {
    pending: Number(row.pending ?? 0),
    abandoned: Number(row.abandoned ?? 0),
    uncertain: Number(row.uncertain ?? 0),
    oldestPendingAt: toIso(row.oldest),
  };
}
