import { createHash } from 'node:crypto';
import type { StoragePool } from './client.js';

/**
 * 投递重放（Q53、Q59）。
 *
 * 依据：
 * - Q59：网页重放必须带预览、二次确认、必填原因、同投递冷却/幂等键与审计；
 * - Q53：投递重放是唯一能制造“频道里重复消息”的动作，必须留痕；
 * - Q9：允许偶发重复，但不得隐藏尝试历史；
 * - 第 8.1 节：单条可恢复故障最多 20 次自动尝试，之后告警并保留待处理记录。
 *
 * 约束：重放不重新生成报告，只重新投递已保存正文（F4）；报告正文与投递记录分离（Q55）。
 */

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
  /** 是否已确认送达；已送达的重放会产生重复消息，必须在预览里提示。 */
  alreadySent: boolean;
  sentAt: string | null;
  messageId: number | null;
  /** 正文摘要（长报告只取前若干字符，避免预览把整篇报告塞进页面）。 */
  bodyExcerpt: string | null;
  bodyLength: number | null;
  /** 可重放性：终态或冷却中的原因。 */
  replayable: boolean;
  blockedBy: 'already_sent' | 'cooldown' | 'not_found' | null;
  cooldownEndsAt: string | null;
  historyCount: number;
}

export interface PreviewDeliveryOptions {
  deliveryId: string;
  now?: Date;
  /** 同一投递的重放冷却（毫秒）；默认 5 分钟。 */
  cooldownMs?: number;
}

export interface ReplayDeliveryOptions {
  deliveryId: string;
  /** 必填：修复了什么、为什么现在重放（Q59）。 */
  reason: string;
  now?: Date;
  cooldownMs?: number;
}

export interface ReplayDeliveryResult {
  applied: boolean;
  rejection: 'not_found' | 'already_sent' | 'cooldown' | 'reason_required' | null;
  /** 冷却或已送达时给出可重放时间，便于页面提示。 */
  cooldownEndsAt: string | null;
  attempts: number;
  auditId: string | null;
}

const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const BODY_EXCERPT_LENGTH = 300;

export const MAX_DELIVERY_ATTEMPTS = 20;

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** 读取投递预览；冷却期内或已确认送达时 replayable=false 并给出原因。 */
export async function previewDelivery(
  pool: StoragePool,
  options: PreviewDeliveryOptions
): Promise<DeliveryPreview | null> {
  const now = options.now ?? new Date();
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  const result = await pool.query(
    `SELECT d.*, r.body AS report_body, r.kind AS report_kind
       FROM delivery_records d
       LEFT JOIN reports r ON r.report_id = d.report_id
      WHERE d.delivery_id = $1`,
    [options.deliveryId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const sentAt = toIso(row.sent_at);
  const alreadySent = sentAt !== null && Number(row.message_id ?? 0) !== 0;
  const updatedAt = toIso(row.updated_at) ?? toIso(row.created_at);
  const cooldownEndsAt = updatedAt ? new Date(new Date(updatedAt).getTime() + cooldownMs).toISOString() : null;
  const inCooldown = cooldownEndsAt !== null && new Date(cooldownEndsAt).getTime() > now.getTime();

  const history = await pool.query(
    `SELECT count(*)::int AS c FROM audit_records WHERE action = 'delivery.replay' AND target_id = $1`,
    [options.deliveryId]
  );

  const body = row.report_body === null || row.report_body === undefined ? null : String(row.report_body);
  const replayable = !alreadySent && !inCooldown;

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
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    uncertain: Boolean(row.uncertain),
    alreadySent,
    sentAt,
    messageId: row.message_id === null || row.message_id === undefined ? null : Number(row.message_id),
    bodyExcerpt: body === null ? null : body.slice(0, BODY_EXCERPT_LENGTH),
    bodyLength: body === null ? null : body.length,
    replayable,
    blockedBy: alreadySent ? 'already_sent' : inCooldown ? 'cooldown' : null,
    cooldownEndsAt: alreadySent ? null : cooldownEndsAt,
    historyCount: Number(history.rows[0]?.c ?? 0)
  };
}

/**
 * 执行重放：把投递放回待处理状态，保留原意图、正文与分片信息。
 *
 * - 必填原因，否则拒绝（Q59）；
 * - 已确认送达：拒绝重放，避免无意义的重复消息；
 * - 冷却期内：拒绝，防止连点造成多条重复（Q59 的幂等键要求）；
 * - 不重新生成报告，投递端只读取已保存正文（F4）。
 */
export async function replayDelivery(
  pool: StoragePool,
  options: ReplayDeliveryOptions
): Promise<ReplayDeliveryResult> {
  const now = options.now ?? new Date();
  const occurredAt = now.toISOString();
  const reason = options.reason?.trim() ?? '';
  if (reason.length === 0) {
    return { applied: false, rejection: 'reason_required', cooldownEndsAt: null, attempts: 0, auditId: null };
  }

  const preview = await previewDelivery(pool, { deliveryId: options.deliveryId, now, cooldownMs: options.cooldownMs });
  if (!preview) {
    return { applied: false, rejection: 'not_found', cooldownEndsAt: null, attempts: 0, auditId: null };
  }
  if (preview.alreadySent) {
    return { applied: false, rejection: 'already_sent', cooldownEndsAt: null, attempts: preview.attempts, auditId: null };
  }
  if (!preview.replayable) {
    return {
      applied: false,
      rejection: 'cooldown',
      cooldownEndsAt: preview.cooldownEndsAt,
      attempts: preview.attempts,
      auditId: null
    };
  }

  return pool.transaction(async (client) => {
    // 冷却校验放进事务，避免两个并发请求同时通过预览检查。
    const current = await client.query(`SELECT attempts, updated_at, sent_at FROM delivery_records WHERE delivery_id = $1 FOR UPDATE`, [
      options.deliveryId
    ]);
    const row = current.rows[0];
    if (!row) {
      return { applied: false, rejection: 'not_found' as const, cooldownEndsAt: null, attempts: 0, auditId: null };
    }
    const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const updatedAt = toIso(row.updated_at);
    if (updatedAt && new Date(updatedAt).getTime() + cooldownMs > now.getTime()) {
      return {
        applied: false,
        rejection: 'cooldown' as const,
        cooldownEndsAt: new Date(new Date(updatedAt).getTime() + cooldownMs).toISOString(),
        attempts: Number(row.attempts ?? 0),
        auditId: null
      };
    }

    const attempts = Number(row.attempts ?? 0);
    await client.query(
      `UPDATE delivery_records
          SET next_attempt_at = $2::timestamptz, uncertain = true, last_error = NULL, updated_at = $2::timestamptz
        WHERE delivery_id = $1`,
      [options.deliveryId, occurredAt]
    );

    const auditId = stableId('audit', 'delivery.replay', options.deliveryId, occurredAt);
    await client.query(
      `INSERT INTO audit_records (audit_id, action, target_type, target_id, before_summary, after_summary, occurred_at)
       VALUES ($1, 'delivery.replay', 'delivery', $2, $3, $4, $5::timestamptz)`,
      [
        auditId,
        options.deliveryId,
        `attempts=${attempts}/lastError=${preview.lastError ?? 'none'}`,
        `replay_requested/reason=${reason}`,
        occurredAt
      ]
    );

    return { applied: true, rejection: null, cooldownEndsAt: null, attempts, auditId };
  });
}
