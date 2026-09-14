import type { StoragePool } from './client.js';

/**
 * 审计记录读取（Q50、Q62）。
 *
 * 已确认边界：
 * - 审计只记录**写操作与导出**，**不记录身份**（Q75、Q85）——
 *   因此这里只有动作、目标与前后摘要，没有"谁做的"。
 * - 目标是把"发生了什么"变成可查的事实，而不是追责工具。
 */

export interface AuditRecordRow {
  auditId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  beforeSummary: string | null;
  afterSummary: string | null;
  occurredAt: string;
}

export interface AuditListResult {
  rows: AuditRecordRow[];
  page: { nextCursor: string | null; hasMore: boolean; limit: number };
}

function encodeCursor(cursor: { occurredAt: string; auditId: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | null | undefined): { occurredAt: string; auditId: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.occurredAt === 'string' && typeof parsed.auditId === 'string') {
      return { occurredAt: parsed.occurredAt, auditId: parsed.auditId };
    }
  } catch {
    // 游标损坏时按"从头开始"处理，不抛错打断页面。
  }
  return null;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(Math.floor(limit), 200);
}

/**
 * 按时间倒序列出审计记录（keyset 分页，与项目列表同一套思路：
 * 用 (occurred_at, audit_id) 作稳定游标，避免 OFFSET 在并发写入时漂移）。
 */
export async function listAuditRecords(
  pool: StoragePool,
  query: { limit?: number; cursor?: string | null; action?: string | null } = {}
): Promise<AuditListResult> {
  const limit = clampLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (query.action && query.action.trim().length > 0) {
    params.push(query.action.trim());
    conditions.push(`action = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.occurredAt, cursor.auditId);
    const base = params.length - 1;
    conditions.push(
      `(occurred_at < $${base}::timestamptz OR (occurred_at = $${base}::timestamptz AND audit_id > $${base + 1}::text))`
    );
  }

  params.push(limit + 1);
  const limitParam = params.length;
  const result = await pool.query(
    `SELECT audit_id, action, target_type, target_id, before_summary, after_summary, occurred_at
       FROM audit_records
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, audit_id ASC
      LIMIT $${limitParam}`,
    params
  );

  const rows = result.rows.slice(0, limit).map((row) => ({
    auditId: String(row.audit_id),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: row.target_id === null || row.target_id === undefined ? null : String(row.target_id),
    beforeSummary: row.before_summary === null || row.before_summary === undefined ? null : String(row.before_summary),
    afterSummary: row.after_summary === null || row.after_summary === undefined ? null : String(row.after_summary),
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
  }));

  const hasMore = result.rows.length > limit;
  const last = rows[rows.length - 1];
  return {
    rows,
    page: {
      nextCursor: hasMore && last ? encodeCursor({ occurredAt: last.occurredAt, auditId: last.auditId }) : null,
      hasMore,
      limit,
    },
  };
}

/** 审计动作的中文说明；未收录的动作原样显示，不猜测含义。 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'project.exclude': '项目移入排除池',
  'project.restore': '项目恢复监控',
  'delivery.replay': '投递重放',
};
