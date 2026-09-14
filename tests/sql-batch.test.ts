import { describe, expect, it } from 'vitest';
import {
  DECISION_COLUMNS,
  DECISION_PARAMS_PER_ROW,
  DECISION_ROW_SPECS,
  INBOUND_EVENT_COLUMNS,
  INBOUND_EVENT_PARAMS_PER_ROW,
  INBOUND_EVENT_ROW_SPECS,
  buildBatchInsert,
  buildValueRow,
  param
} from '../src/testing/sql-batch.js';

/**
 * 批量 INSERT 占位符生成。
 *
 * 这组测试的存在理由：占位符与参数数量错位只会在运行时报
 * “bind message supplies N parameters, but prepared statement requires M”，
 * 信息不直观且很难定位。纯函数化之后可以在这里直接断言。
 */

describe('占位符生成', () => {
  it('带类型转换的占位符格式正确', () => {
    expect(param(1)).toBe('$1');
    expect(param(7, 'int')).toBe('$7::int');
  });

  it('固定 SQL 片段不占用参数编号', () => {
    const row = buildValueRow(1, [{}, {}, 'now()', { cast: 'int' }]);
    expect(row.values).toBe('($1, $2, now(), $3::int)');
    expect(row.nextIndex).toBe(4);
  });

  it('起始编号从 1 开始，连续行不重复编号', () => {
    const first = buildValueRow(1, INBOUND_EVENT_ROW_SPECS);
    const second = buildValueRow(first.nextIndex, INBOUND_EVENT_ROW_SPECS);
    expect(first.nextIndex).toBe(INBOUND_EVENT_PARAMS_PER_ROW + 1);
    expect(first.values).toContain('$1');
    expect(second.values).toContain(`$${INBOUND_EVENT_PARAMS_PER_ROW + 1}`);
  });
});

describe('事件表语句：9 列 7 参数 + 2 个固定表达式', () => {
  it('每行占位符数量等于该行参数个数', () => {
    expect(INBOUND_EVENT_COLUMNS).toHaveLength(9);
    expect(INBOUND_EVENT_PARAMS_PER_ROW).toBe(7);
    expect(INBOUND_EVENT_ROW_SPECS).toHaveLength(9);
  });

  it('多行语句的占位符总数等于参数总数', () => {
    const rowCount = 3;
    const rows = Array.from({ length: rowCount }, (_, index) =>
      buildValueRow(index * INBOUND_EVENT_PARAMS_PER_ROW + 1, INBOUND_EVENT_ROW_SPECS).values
    );
    const statement = buildBatchInsert({
      table: 'inbound_events',
      columns: INBOUND_EVENT_COLUMNS,
      rows,
      suffix: 'ON CONFLICT DO NOTHING'
    });
    expect(statement.placeholderCount).toBe(rowCount * INBOUND_EVENT_PARAMS_PER_ROW);
    // 连续编号：最大编号必须等于总数
    const numbers = [...statement.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    expect(Math.max(...numbers)).toBe(statement.placeholderCount);
    expect(new Set(numbers).size).toBe(statement.placeholderCount);
  });

  it('列顺序与 schema 一致（parse_error 在最后、link 在关注数之前）', () => {
    expect(INBOUND_EVENT_COLUMNS).toEqual([
      'event_id',
      'collector_id',
      'ingest_seq',
      'received_at',
      'raw_payload',
      'link',
      'common_follow_count',
      'legacy_dedupe_key',
      'parse_error'
    ]);
  });
});

describe('判定表语句：8 列 6 参数', () => {
  it('固定列（project_id、decided_at）不占用参数', () => {
    expect(DECISION_COLUMNS).toHaveLength(8);
    expect(DECISION_PARAMS_PER_ROW).toBe(6);
    const row = buildValueRow(1, DECISION_ROW_SPECS);
    expect(row.values).toBe('($1, $2, NULL, $3, $4, now(), $5::int, $6::int)');
  });

  it('多行语句的占位符总数等于参数总数', () => {
    const rowCount = 4;
    const rows = Array.from({ length: rowCount }, (_, index) =>
      buildValueRow(index * DECISION_PARAMS_PER_ROW + 1, DECISION_ROW_SPECS).values
    );
    const statement = buildBatchInsert({ table: 'decisions', columns: DECISION_COLUMNS, rows });
    expect(statement.placeholderCount).toBe(rowCount * DECISION_PARAMS_PER_ROW);
  });
});

describe('边界情况', () => {
  it('没有任何行时明确报错，而不是生成非法 SQL', () => {
    expect(() => buildBatchInsert({ table: 'inbound_events', columns: INBOUND_EVENT_COLUMNS, rows: [] })).toThrow(
      /至少一行/
    );
  });

  it('忽略空白行', () => {
    const statement = buildBatchInsert({
      table: 't',
      columns: ['a'],
      rows: ['  ', '($1)']
    });
    expect(statement.placeholderCount).toBe(1);
  });
});
