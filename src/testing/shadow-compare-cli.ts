import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createStoragePool, resolveDatabaseUrl, type StoragePool } from '../storage/client.js';
import {
  compareShadowSamples,
  evaluateShadowAcceptance,
  formatShadowReport,
  type LegacySinkRecord,
  type NewSystemDecisionRecord
} from './shadow-comparison.js';

/**
 * 影子对比入口：
 *   npm run shadow:compare -- --sink=/var/log/djk-shadow/decisions.jsonl --since=2026-09-14T00:00:00Z
 *
 * 数据来源：
 * - 旧系统侧：`--sink` 指定的 JSONL（由 src/service.ts 的决策回调写出）；
 * - 新系统侧：`--database-url`（或 DATABASE_URL）指向的库里的 decisions 表。
 *
 * 输出：Markdown 报告（stdout）。可用 `--json` 输出机器可读结果。
 * 本命令只读：不写数据库、不产生外部副作用。
 */

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const sinkPath = arg('sink');
if (!sinkPath) {
  console.error('缺少 --sink=<旧系统结构化证据 JSONL 路径>');
  process.exit(1);
}

const since = arg('since');
const threshold = Number(arg('threshold', '0.02'));
const minMatched = arg('min-matched');
const includeSynthetic = arg('include-synthetic', 'false') === 'true';
const asJson = process.argv.includes('--json');

/** 逐行读取 sink；坏行跳过并计数，不因为一行损坏就放弃整份证据。 */
async function readSink(path: string): Promise<{ records: LegacySinkRecord[]; badLines: number }> {
  const records: LegacySinkRecord[] = [];
  let badLines = 0;
  const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of reader) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as LegacySinkRecord;
      if (typeof parsed.reasonCode === 'string') records.push(parsed);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { records, badLines };
}

/** 读新系统的判定记录；可按时间过滤以对齐影子窗口。 */
async function readNewDecisions(pool: StoragePool, sinceIso?: string): Promise<NewSystemDecisionRecord[]> {
  const result = await pool.query(
    `SELECT d.decision_id, d.project_key, d.reason_code, d.decided_at, e.upstream_push_at_sec,
            d.star, d.previous_star, d.common_follow_count,
            d.classification_type, d.classification_confidence, d.classification_error
       FROM decisions d
       JOIN inbound_events e ON e.event_id = d.event_id
      WHERE ($1::timestamptz IS NULL OR d.decided_at >= $1::timestamptz)
      ORDER BY d.decided_at ASC`,
    [sinceIso ?? null]
  );
  return result.rows.map((row) => ({
    decisionId: String(row.decision_id),
    projectKey: row.project_key === null || row.project_key === undefined ? null : String(row.project_key),
    reasonCode: String(row.reason_code),
    decidedAt: row.decided_at instanceof Date ? row.decided_at.toISOString() : String(row.decided_at),
    upstreamPushAtSec:
      row.upstream_push_at_sec === null || row.upstream_push_at_sec === undefined
        ? null
        : Number(row.upstream_push_at_sec),
    star: row.star === null || row.star === undefined ? null : Number(row.star),
    previousStar: row.previous_star === null || row.previous_star === undefined ? null : Number(row.previous_star),
    count: row.common_follow_count === null || row.common_follow_count === undefined ? null : Number(row.common_follow_count),
    classificationType:
      row.classification_type === null || row.classification_type === undefined ? null : String(row.classification_type),
    classificationConfidence:
      row.classification_confidence === null || row.classification_confidence === undefined
        ? null
        : Number(row.classification_confidence),
    classificationError:
      row.classification_error === null || row.classification_error === undefined ? null : String(row.classification_error),
    sampleSource: 'live' as const
  }));
}

const databaseUrl = arg('database-url') ?? resolveDatabaseUrl();
if (!databaseUrl) {
  console.error('缺少数据库连接串（--database-url 或 DATABASE_URL）');
  process.exit(1);
}

const pool = createStoragePool({ connectionString: databaseUrl, max: 4, applicationName: 'djk-shadow-compare' });
try {
  const { records: legacyRecords, badLines } = await readSink(sinkPath);
  const newRecords = await readNewDecisions(pool, since);

  const report = compareShadowSamples(legacyRecords, newRecords, { includeSynthetic });
  const acceptance = evaluateShadowAcceptance(report, {
    threshold,
    ...(minMatched ? { minMatched: Number(minMatched) } : {})
  });

  if (asJson) {
    console.info(JSON.stringify({ report, acceptance, badLines }, null, 2));
  } else {
    if (badLines > 0) {
      console.info(`注意：sink 中有 ${badLines} 行无法解析，已跳过（不影响其余对比）。`);
    }
    console.info(formatShadowReport(report, acceptance));
  }
  // 未通过时以非零退出码结束，便于放进 M5 的自动化验收。
  if (!acceptance.passed) process.exitCode = 2;
} catch (error) {
  console.error(`影子对比失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.close();
}
