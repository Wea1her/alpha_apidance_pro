/**
 * 批量 INSERT 的占位符生成（压测与批量导入共用）。
 *
 * 为什么单独成模块：占位符编号与参数个数的错位（例如“9 个参数、8 个占位符”）
 * 要跑起来才会被 PostgreSQL 发现，而且报错信息不直观。把这段逻辑变成纯函数后，
 * 可以直接用单元测试断言“占位符数量 == 参数数量”，避免同类错误再次出现。
 */

export interface BatchStatement {
  sql: string;
  placeholderCount: number;
}

/** 把列列表与每行的参数表达式拼成一条多行 VALUES 语句。 */
export function buildBatchInsert(input: {
  table: string;
  columns: readonly string[];
  /** 每行的 SQL 表达式，用 {@link param} 生成占位符。 */
  rows: readonly string[];
  suffix?: string;
}): BatchStatement {
  const rows = input.rows.filter((row) => row.trim().length > 0);
  if (rows.length === 0) {
    throw new Error('buildBatchInsert 需要至少一行');
  }
  const placeholders = rows.join(', ');
  const sql =
    `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES ${placeholders}` +
    (input.suffix ? ` ${input.suffix}` : '');
  return { sql, placeholderCount: (sql.match(/\$\d+/g) ?? []).length };
}

/** 生成带可选类型转换的占位符。 */
export function param(index: number, cast?: string): string {
  return cast ? `$${index}::${cast}` : `$${index}`;
}

/**
 * 生成一行占位符。
 *
 * @param startIndex 本行第一个参数的整体编号（从 1 开始）
 * @param specs 每列的表达式：字符串表示固定 SQL（如 now()），对象表示参数
 */
export function buildValueRow(
  startIndex: number,
  specs: ReadonlyArray<string | { cast?: string }>
): { values: string; nextIndex: number } {
  const parts: string[] = [];
  let index = startIndex;
  for (const spec of specs) {
    if (typeof spec === 'string') {
      parts.push(spec);
      continue;
    }
    parts.push(param(index, spec.cast));
    index += 1;
  }
  return { values: `(${parts.join(', ')})`, nextIndex: index };
}

/** `inbound_events` 的列顺序（与 schema 一致，压测与导入都按它生成）。 */
export const INBOUND_EVENT_COLUMNS = [
  'event_id',
  'collector_id',
  'ingest_seq',
  'received_at',
  'raw_payload',
  'link',
  'common_follow_count',
  'legacy_dedupe_key',
  'parse_error',
] as const;

/** `inbound_events` 每行的表达式模板：9 列 9 参数（含 link，可为 null 但仍是参数）。 */
export const INBOUND_EVENT_ROW_SPECS: ReadonlyArray<string | { cast?: string }> = [
  {}, // event_id
  {}, // collector_id
  { cast: 'bigint' }, // ingest_seq
  'now()', // received_at
  {}, // raw_payload
  'NULL', // link：压测样本不带链接，固定写 NULL
  { cast: 'int' }, // common_follow_count
  { cast: 'text' }, // legacy_dedupe_key
  { cast: 'text' }, // parse_error
];

/** `decisions` 的列顺序（project_id 固定写 NULL）。 */
export const DECISION_COLUMNS = [
  'decision_id',
  'event_id',
  'project_id',
  'project_key',
  'reason_code',
  'decided_at',
  'star',
  'common_follow_count',
] as const;

/** `decisions` 每行的表达式模板：8 列但只有 6 个参数（project_id 与 decided_at 是固定 SQL）。 */
export const DECISION_ROW_SPECS: ReadonlyArray<string | { cast?: string }> = [
  {},
  {},
  'NULL',
  {},
  {},
  'now()',
  { cast: 'int' },
  { cast: 'int' },
];

/** 每行 `inbound_events` 占用的参数个数。 */
export const INBOUND_EVENT_PARAMS_PER_ROW = INBOUND_EVENT_ROW_SPECS.filter((spec) => typeof spec !== 'string').length;
/** 每行 `decisions` 占用的参数个数。 */
export const DECISION_PARAMS_PER_ROW = DECISION_ROW_SPECS.filter((spec) => typeof spec !== 'string').length;
