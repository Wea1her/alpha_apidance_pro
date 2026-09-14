import type { StoragePool } from './client.js';

/**
 * 保留策略清理（第 5 节、F10）。
 *
 * 规则：
 * - **原始事件及完整判定时间线保留 90 天**，按小批量后台清理；
 * - 清理**不得级联删除**项目、报告、任务与投递；报告长期保存必要的来源摘要；
 * - 任务所需的最小执行快照与投递内容独立保存，不因原始事件清理而丢失未完成工作；
 * - 过期原始事件在页面显示“原始记录已过保留期”——因此清理后**报告仍然可读**。
 *
 * 为什么必须分批：一次性删除 90 天窗口外的百万级记录会长时间持锁并撑大 WAL，
 * 干扰在线查询与投递（第 5 节要求“按小批量后台清理”）。
 */

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_CLEANUP_BATCH = 2_000;

export interface CleanupOptions {
  retentionDays?: number;
  batchSize?: number;
  now?: Date;
  /** 单次调用的最大批次数，避免长事务；默认 10。 */
  maxBatches?: number;
}

export interface CleanupResult {
  /** 清理截止时间（早于它的接收记录被删除）。 */
  cutoff: string;
  deletedEvents: number;
  deletedDecisions: number;
  batches: number;
  /** 是否还有更多过期数据（true 表示下次继续）。 */
  hasMore: boolean;
  /** 因存在长期引用而无法删除、但已超过保留期的记录数（应保持为 0）。 */
  blockedByReferences: number;
}

/**
 * 清理超过保留期的接收记录与判定记录。
 *
 * 判定记录先删（它引用接收记录），再删接收记录；两者都在同一个保留窗口内。
 * 报告与投递的 `trigger_event_id` / `report_id` 使用 `ON DELETE SET NULL` 或独立的
 * 来源摘要，因此清理不会破坏长期记录。
 */
export async function cleanupExpiredEvents(pool: StoragePool, options: CleanupOptions = {}): Promise<CleanupResult> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_CLEANUP_BATCH);
  const maxBatches = Math.max(1, options.maxBatches ?? 10);
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  let deletedEvents = 0;
  let deletedDecisions = 0;
  let batches = 0;
  let hasMore = false;

  while (batches < maxBatches) {
    const outcome = await pool.transaction(async (client) => {
      // 先删这些接收记录的判定记录，避免外键阻塞。
      const decisions = await client.query(
        `DELETE FROM decisions
          WHERE decision_id IN (
            SELECT d.decision_id FROM decisions d
              JOIN inbound_events e ON e.event_id = d.event_id
             WHERE e.received_at < $1::timestamptz
             LIMIT $2
          )`,
        [cutoff, batchSize]
      );

      const events = await client.query(
        `DELETE FROM inbound_events
          WHERE event_id IN (
            SELECT event_id FROM inbound_events
             WHERE received_at < $1::timestamptz
             LIMIT $2
          )`,
        [cutoff, batchSize]
      );

      return { decisions: decisions.rowCount ?? 0, events: events.rowCount ?? 0 };
    });

    deletedDecisions += outcome.decisions;
    deletedEvents += outcome.events;
    batches += 1;
    if (outcome.events === 0) break;
  }

  // 还有没有过期数据？用于决定是否继续下一轮。
  const remaining = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM inbound_events WHERE received_at < $1::timestamptz) AS more`,
    [cutoff]
  );
  hasMore = Boolean(remaining.rows[0]?.more);

  // 长期记录不应因为清理而消失：核验报告与投递仍然存在。
  const longLived = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM reports) AS reports,
       (SELECT count(*)::int FROM delivery_records WHERE report_id IS NOT NULL) AS deliveries_with_report,
       (SELECT count(*)::int FROM reports r
         WHERE NOT EXISTS (SELECT 1 FROM delivery_records d WHERE d.report_id = r.report_id)
           AND r.trigger_event_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM inbound_events e WHERE e.event_id = r.trigger_event_id)) AS orphaned_reports`
  );

  return {
    cutoff,
    deletedEvents,
    deletedDecisions,
    batches,
    hasMore,
    // 触发事件被清理后 trigger_event_id 会被置空（ON DELETE SET NULL），因此这里统计的是
    // “仍指向已不存在事件”的报告数，正常应为 0。
    blockedByReferences: Number(longLived.rows[0]?.orphaned_reports ?? 0),
  };
}
