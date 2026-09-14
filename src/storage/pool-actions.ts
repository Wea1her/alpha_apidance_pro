import { createHash } from 'node:crypto';
import type { StoragePool } from './client.js';
import type { ExclusionReason } from '../../shared/domain.js';

/**
 * 监控池动作：排除与恢复。
 *
 * 依据：Q132（项目只有“监控中/已排除”两态，“人工移除”并入排除）、
 * Q133（排除保留在途任务，只阻止后续）、Q134（记录排除时间、当时星级与事件数、进入原因）、
 * Q135（排除后仍记录接收事实，但不判定、不生成、不推送）、
 * Q136（恢复与拦截恢复一致：二次确认、新建一次标准分析、人工排除的恢复必填理由）、
 * Q50（审计不记身份、与业务同库长期保留）。
 *
 * 约束：本模块只改“监控范围”，不绕过推送阈值；恢复不会直接产生频道推送。
 */

export interface ExcludeProjectOptions {
  projectId: string;
  reason: ExclusionReason;
  /** 排除时刻；调用方传入以便测试与审计对齐。 */
  now?: Date;
  /** 人工排除时的备注（可空）。 */
  note?: string | null;
}

export interface ExcludeProjectResult {
  applied: boolean;
  /** 已在排除状态时为 true，不重复写入。 */
  alreadyExcluded: boolean;
  excludedStar: number | null;
  excludedEventCount: number | null;
  /** 因排除而终止的未执行任务数（在途运行中的任务不在此列，Q133）。 */
  cancelledJobs: number;
}

export interface RestoreProjectOptions {
  projectId: string;
  /** 人工排除的项目恢复时必须提供理由（Q136）。 */
  reason?: string | null;
  now?: Date;
}

export interface RestoreProjectResult {
  applied: boolean;
  alreadyMonitored: boolean;
  /** 恢复时新建（或复用）的标准分析任务 ID。 */
  jobId: string | null;
  /** 该任务是否本次新建。 */
  jobCreated: boolean;
  requiredReason: boolean;
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

/** 恢复触发的标准分析任务 ID：同一项目重复恢复复用同一任务。 */
export function buildRestoreJobId(projectId: string): string {
  return stableId('job-restore', projectId);
}

async function writeAudit(
  client: { query(sql: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> },
  input: {
    action: string;
    targetType: string;
    targetId: string;
    beforeSummary: string | null;
    afterSummary: string | null;
    occurredAt: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO audit_records (audit_id, action, target_type, target_id, before_summary, after_summary, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [
      stableId('audit', input.action, input.targetId, input.occurredAt),
      input.action,
      input.targetType,
      input.targetId,
      input.beforeSummary,
      input.afterSummary,
      input.occurredAt,
    ]
  );
}

/**
 * 把项目移入排除池。
 *
 * - 已是排除状态：幂等返回，不重复写审计；
 * - 未执行的自动任务（queued/failed/waiting_dependency）标记为死信并说明原因；
 *   已在运行的任务保留，允许自然完成（Q133）；
 * - 记录排除时的星级与累计事件数，供排除列表展示（Q134）。
 */
export async function excludeProject(pool: StoragePool, options: ExcludeProjectOptions): Promise<ExcludeProjectResult> {
  const now = options.now ?? new Date();
  const occurredAt = now.toISOString();

  return pool.transaction(async (client) => {
    const current = await client.query(
      `SELECT project_id, project_key, pool_state, star, exclusion_reason
         FROM projects WHERE project_id = $1 FOR UPDATE`,
      [options.projectId]
    );
    const project = current.rows[0];
    if (!project) {
      throw new Error(`排除失败：项目不存在（${options.projectId}）`);
    }

    if (String(project.pool_state) === 'excluded') {
      const counts = await client.query(`SELECT count(*)::int AS c FROM decisions WHERE project_id = $1`, [
        options.projectId,
      ]);
      return {
        applied: false,
        alreadyExcluded: true,
        excludedStar: Number(project.star ?? 0),
        excludedEventCount: Number(counts.rows[0]?.c ?? 0),
        cancelledJobs: 0,
      };
    }

    // 排除瞬间统计：星级与累计事件数如实记录，不推断。
    const eventCount = await client.query(`SELECT count(*)::int AS c FROM decisions WHERE project_id = $1`, [
      options.projectId,
    ]);
    const excludedEventCount = Number(eventCount.rows[0]?.c ?? 0);
    const excludedStar = Number(project.star ?? 0);

    await client.query(
      `UPDATE projects
          SET pool_state = 'excluded',
              excluded_at = $2::timestamptz,
              exclusion_reason = $3,
              excluded_star = $4,
              excluded_event_count = $5,
              restore_reason = NULL,
              updated_at = $2::timestamptz
        WHERE project_id = $1`,
      [options.projectId, occurredAt, options.reason, excludedStar, excludedEventCount]
    );

    // 未执行的任务不再执行；运行中的任务保留（Q133）。
    const cancelled = await client.query(
      `UPDATE jobs
          SET stage = 'dead_letter',
              last_error = $2,
              lease_owner = NULL,
              lease_expires_at = NULL,
              finished_at = $3::timestamptz,
              updated_at = $3::timestamptz
        WHERE project_id = $1 AND stage IN ('queued', 'failed', 'waiting_dependency')`,
      [options.projectId, `项目已移入排除池（${options.reason}）`, occurredAt]
    );

    await writeAudit(client, {
      action: 'project.exclude',
      targetType: 'project',
      targetId: options.projectId,
      beforeSummary: `monitored/star=${excludedStar}/events=${excludedEventCount}`,
      afterSummary: `excluded/${options.reason}${options.note ? `/${options.note}` : ''}`,
      occurredAt,
    });

    return {
      applied: true,
      alreadyExcluded: false,
      excludedStar,
      excludedEventCount,
      cancelledJobs: Number(cancelled.rowCount ?? 0),
    };
  });
}

/**
 * 从排除池恢复监控。
 *
 * - 恢复不绕过阈值：只把状态置回 monitored，是否推送仍由后续自然事件决定；
 * - 人工排除的项目必须给出恢复理由（Q136）；规则拦截的恢复不强制；
 * - 新建（或复用）一次标准分析任务，历史报告保留（Q126）。
 */
export async function restoreProject(pool: StoragePool, options: RestoreProjectOptions): Promise<RestoreProjectResult> {
  const now = options.now ?? new Date();
  const occurredAt = now.toISOString();
  const reason = options.reason?.trim() ? options.reason.trim() : null;

  return pool.transaction(async (client) => {
    const current = await client.query(
      `SELECT project_id, project_key, pool_state, exclusion_reason, excluded_star, excluded_event_count
         FROM projects WHERE project_id = $1 FOR UPDATE`,
      [options.projectId]
    );
    const project = current.rows[0];
    if (!project) {
      throw new Error(`恢复失败：项目不存在（${options.projectId}）`);
    }

    if (String(project.pool_state) === 'monitored') {
      return { applied: false, alreadyMonitored: true, jobId: null, jobCreated: false, requiredReason: false };
    }

    // 人工排除的恢复必须写理由：这是纠错线索，不能靠猜（Q136）。
    const exclusionReason = String(project.exclusion_reason ?? '');
    const requiredReason = exclusionReason === 'manual';
    if (requiredReason && !reason) {
      throw new Error('恢复失败：人工排除的项目必须填写恢复理由');
    }

    await client.query(
      `UPDATE projects
          SET pool_state = 'monitored',
              excluded_at = NULL,
              exclusion_reason = NULL,
              restore_reason = $2,
              source = CASE WHEN source = 'history_import' THEN source ELSE 'restored' END,
              updated_at = $3::timestamptz
        WHERE project_id = $1`,
      [options.projectId, reason, occurredAt]
    );

    // 恢复后立即排一次标准分析；重复恢复复用同一任务（幂等）。
    const jobId = buildRestoreJobId(options.projectId);
    const inserted = await client.query(
      `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by)
       VALUES ($1, 'standard', $2, 'queued', 'restore')
       ON CONFLICT DO NOTHING`,
      [jobId, options.projectId]
    );

    await writeAudit(client, {
      action: 'project.restore',
      targetType: 'project',
      targetId: options.projectId,
      beforeSummary: `excluded/${exclusionReason}/star=${project.excluded_star ?? 'null'}`,
      afterSummary: `monitored${reason ? `/${reason}` : ''}`,
      occurredAt,
    });

    return {
      applied: true,
      alreadyMonitored: false,
      jobId,
      jobCreated: (inserted.rowCount ?? 0) > 0,
      requiredReason,
    };
  });
}

/** 排除列表查询：区分规则拦截与人工排除，供页面展示进入原因。 */
export interface ExcludedProjectRow {
  projectId: string;
  projectKey: string;
  displayName: string | null;
  link: string | null;
  exclusionReason: ExclusionReason;
  excludedAt: string | null;
  excludedStar: number | null;
  excludedEventCount: number | null;
  restoreReason: string | null;
  /** 规则拦截时最近一次拦截原因码，供排查。 */
  latestReasonCode: string | null;
}

export async function listExcludedProjects(pool: StoragePool, limit = 100): Promise<ExcludedProjectRow[]> {
  const result = await pool.query(
    `SELECT p.project_id, p.project_key, p.display_name, p.link, p.exclusion_reason, p.excluded_at,
            p.excluded_star, p.excluded_event_count, p.restore_reason,
            (SELECT d.reason_code FROM decisions d
              WHERE d.project_id = p.project_id
              ORDER BY d.decided_at DESC LIMIT 1) AS latest_reason_code
       FROM projects p
      WHERE p.pool_state = 'excluded'
      ORDER BY p.excluded_at DESC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    projectId: String(row.project_id),
    projectKey: String(row.project_key),
    displayName: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    link: row.link === null || row.link === undefined ? null : String(row.link),
    exclusionReason: String(row.exclusion_reason) as ExclusionReason,
    excludedAt: row.excluded_at instanceof Date ? row.excluded_at.toISOString() : row.excluded_at ? String(row.excluded_at) : null,
    excludedStar: row.excluded_star === null || row.excluded_star === undefined ? null : Number(row.excluded_star),
    excludedEventCount:
      row.excluded_event_count === null || row.excluded_event_count === undefined
        ? null
        : Number(row.excluded_event_count),
    restoreReason: row.restore_reason === null || row.restore_reason === undefined ? null : String(row.restore_reason),
    latestReasonCode:
      row.latest_reason_code === null || row.latest_reason_code === undefined ? null : String(row.latest_reason_code),
  }));
}
