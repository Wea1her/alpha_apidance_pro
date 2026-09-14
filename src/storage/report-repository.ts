import type { StoragePool } from './client.js';
import type { ModelUsage } from '../../shared/domain.js';

/**
 * 报告仓储：报告一旦保存，投递与重试都只读取已保存正文（F4、第 8.1 节）。
 *
 * 约束：
 * - 每项目每类型只有一份**自然触发**的报告（数据库部分唯一索引兜底）；
 * - 恢复触发的新报告可与原报告并存（Q126）；
 * - 模型用量缺失时字段保持 NULL，不得填 0 冒充（第 8 节）。
 */

export interface SaveReportInput {
  projectId: string;
  kind: 'standard' | 'deep';
  triggerEventId: string | null;
  model: string | null;
  promptVersion: string | null;
  body: string;
  generatedAt: string;
  triggeredBy: 'natural' | 'restore';
  usage?: ModelUsage | null;
  /** 历史导入且无法解析生成时间时为 true（Q15）。 */
  generatedAtMissing?: boolean;
}

export interface ReportRow {
  reportId: string;
  projectId: string;
  kind: 'standard' | 'deep';
  triggerEventId: string | null;
  model: string | null;
  body: string;
  generatedAt: string;
  triggeredBy: 'natural' | 'restore';
  usage: ModelUsage | null;
}

function stableReportId(projectId: string, kind: string, triggeredBy: string): string {
  return `rep_${triggeredBy}_${kind}_${projectId}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function mapReport(row: Record<string, unknown>): ReportRow {
  return {
    reportId: String(row.report_id),
    projectId: String(row.project_id),
    kind: String(row.kind) as 'standard' | 'deep',
    triggerEventId:
      row.trigger_event_id === null || row.trigger_event_id === undefined ? null : String(row.trigger_event_id),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    body: String(row.body),
    generatedAt: row.generated_at instanceof Date ? row.generated_at.toISOString() : String(row.generated_at),
    triggeredBy: String(row.triggered_by) as 'natural' | 'restore',
    usage: {
      responseId: row.response_id === null || row.response_id === undefined ? null : String(row.response_id),
      reportedModel: row.reported_model === null || row.reported_model === undefined ? null : String(row.reported_model),
      inputTokens: row.input_tokens === null || row.input_tokens === undefined ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : Number(row.output_tokens),
      serverSideToolCalls:
        row.server_side_tool_calls === null || row.server_side_tool_calls === undefined
          ? null
          : Number(row.server_side_tool_calls),
    },
  };
}

/**
 * 保存报告。已存在同项目同类型同触发来源的报告时不覆盖：
 * 模型正文成功保存后，重试只读已保存正文，不得再次调用模型（F4）。
 */
export async function saveReport(
  pool: StoragePool,
  input: SaveReportInput
): Promise<{ reportId: string; created: boolean }> {
  const reportId = stableReportId(input.projectId, input.kind, input.triggeredBy);
  const usage = input.usage ?? null;
  const inserted = await pool.query(
    `INSERT INTO reports (report_id, project_id, kind, trigger_event_id, model, prompt_version, body, generated_at,
                          triggered_by, report_generated_at_missing, response_id, reported_model, input_tokens,
                          output_tokens, server_side_tool_calls)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT DO NOTHING`,
    [
      reportId,
      input.projectId,
      input.kind,
      input.triggerEventId,
      input.model,
      input.promptVersion,
      input.body,
      input.generatedAt,
      input.triggeredBy,
      input.generatedAtMissing ?? false,
      usage?.responseId ?? null,
      usage?.reportedModel ?? null,
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.serverSideToolCalls ?? null,
    ]
  );
  return { reportId, created: (inserted.rowCount ?? 0) > 0 };
}

/** 查找报告；重试路径先查再决定是否调用模型。 */
export async function findReport(
  pool: StoragePool,
  input: { projectId: string; kind: 'standard' | 'deep'; triggeredBy?: 'natural' | 'restore' }
): Promise<ReportRow | null> {
  const result = await pool.query(
    `SELECT * FROM reports
      WHERE project_id = $1 AND kind = $2 AND ($3::text IS NULL OR triggered_by = $3)
      ORDER BY generated_at DESC
      LIMIT 1`,
    [input.projectId, input.kind, input.triggeredBy ?? null]
  );
  const row = result.rows[0];
  return row ? mapReport(row) : null;
}

/** 项目在某类报告上是否已有自然触发的报告（首次任务唯一性的读取侧校验）。 */
export async function hasNaturalReport(pool: StoragePool, projectId: string, kind: 'standard' | 'deep'): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM reports WHERE project_id = $1 AND kind = $2 AND triggered_by = 'natural' LIMIT 1`,
    [projectId, kind]
  );
  return result.rows.length > 0;
}
