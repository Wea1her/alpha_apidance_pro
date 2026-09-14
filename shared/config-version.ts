/**
 * 配置版本：把生效的非敏感配置固化成快照并计算稳定哈希。
 *
 * 依据：第 5 节“配置版本”实体、第 7 节“生效配置接口只按白名单返回字段，
 * 不能直接序列化 ServiceConfig”、第 3 节指出的“本地阈值与代码默认不一致，只展示默认值会误导排查”。
 * 约束：本模块不读取环境变量、不接触凭证；调用方负责传入已解析的配置。
 */

import type { ConfigVersionRecord, ConfigVersionSnapshot } from './domain.js';

/** 白名单输入：只有这里列出的字段会进入快照，其余一律忽略。 */
export interface ConfigVersionInput {
  commonFollowStarLevels: readonly number[];
  xaiModel?: string | null;
  deepAnalysis?: { xaiModel?: string | null } | null;
  xaiSearchTools?: readonly string[];
  deepAnalysisSearchTools?: readonly string[];
  classificationConcurrency?: number | null;
  standardConcurrency?: number | null;
  deepConcurrency?: number | null;
  classificationTimeoutMs?: number | null;
  standardTimeoutMs?: number | null;
  deepTimeoutMs?: number | null;
  analysisQueueMaxAttempts?: number | null;
  deepAnalysisMaxAttempts?: number | null;
  telegramRetryAttempts?: number | null;
}

const DEFAULT_CLASSIFICATION_CONCURRENCY = 2;
const DEFAULT_STANDARD_CONCURRENCY = 2;
const DEFAULT_DEEP_CONCURRENCY = 1;
const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 60_000;
const DEFAULT_STANDARD_TIMEOUT_MS = 180_000;
const DEFAULT_DEEP_TIMEOUT_MS = 600_000;

function positiveIntegerOr(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function stringOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

/**
 * 构建配置版本快照。阈值顺序保留（顺序即星级语义），其余集合排序以保证哈希稳定。
 */
export function buildConfigVersionSnapshot(input: ConfigVersionInput): ConfigVersionSnapshot {
  const starLevels = input.commonFollowStarLevels.map((level) => Math.floor(level));
  return {
    starLevels,
    maxStar: starLevels.length,
    classificationModel: stringOrNull(input.xaiModel),
    standardModel: stringOrNull(input.xaiModel),
    deepModel: stringOrNull(input.deepAnalysis?.xaiModel),
    searchTools: sortedUnique(input.xaiSearchTools),
    deepSearchTools: sortedUnique(input.deepAnalysisSearchTools),
    classificationConcurrency: positiveIntegerOr(input.classificationConcurrency, DEFAULT_CLASSIFICATION_CONCURRENCY),
    standardConcurrency: positiveIntegerOr(input.standardConcurrency, DEFAULT_STANDARD_CONCURRENCY),
    deepConcurrency: positiveIntegerOr(input.deepConcurrency, DEFAULT_DEEP_CONCURRENCY),
    requestTimeoutMs: {
      classification: positiveIntegerOr(input.classificationTimeoutMs, DEFAULT_CLASSIFICATION_TIMEOUT_MS),
      standard: positiveIntegerOr(input.standardTimeoutMs, DEFAULT_STANDARD_TIMEOUT_MS),
      deep: positiveIntegerOr(input.deepTimeoutMs, DEFAULT_DEEP_TIMEOUT_MS),
    },
    analysisMaxAttempts: positiveIntegerOr(input.analysisQueueMaxAttempts, 5),
    deepAnalysisMaxAttempts: positiveIntegerOr(input.deepAnalysisMaxAttempts, 5),
    telegramRetryAttempts: positiveIntegerOr(input.telegramRetryAttempts, 20),
  };
}

/** 规范化 JSON：对象键排序、数组保持顺序，确保同一配置的哈希稳定。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** FNV-1a 64 位；仅用于检测配置变化，不用于安全用途。 */
export function hashConfigSnapshot(snapshot: ConfigVersionSnapshot): string {
  const text = canonicalJson(snapshot);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = (hash ^ BigInt(byte)) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function configSnapshotsEqual(a: ConfigVersionSnapshot, b: ConfigVersionSnapshot): boolean {
  return hashConfigSnapshot(a) === hashConfigSnapshot(b);
}

/**
 * 生成配置版本记录。仅当哈希与上一个版本不同才产生新版本；
 * 相同则返回 null，调用方沿用既有 configVersionId。
 */
export function planConfigVersion(
  snapshot: ConfigVersionSnapshot,
  options: { previous?: Pick<ConfigVersionRecord, 'hash' | 'configVersionId'> | null; effectiveAt: string; newId: () => string }
): { record: ConfigVersionRecord } | { unchanged: true; configVersionId: string } | { unchanged: false; configVersionId: string } {
  const hash = hashConfigSnapshot(snapshot);
  const previous = options.previous ?? null;
  if (previous && previous.hash === hash) {
    return { unchanged: true, configVersionId: previous.configVersionId };
  }
  const record: ConfigVersionRecord = {
    configVersionId: options.newId(),
    hash,
    effectiveAt: options.effectiveAt,
    snapshot,
  };
  return { record, unchanged: false, configVersionId: record.configVersionId };
}
