/**
 * 影子对比（M5，Q30-Q43）。
 *
 * 背景：影子期旧 worker 通过旁路 sink 写出结构化判定证据（Q32-B、Q38-D），
 * 本模块把它与新系统落库的判定逐事件对齐并产出对比报告。
 *
 * 对齐键（Q31）：**归一化账号 + 上游事件时间（秒）**；本地接收序号只作次序仲裁，不参与跨系统 join。
 * 之所以不能用事件 ID：上游 Alpha 事件没有消息 ID（已核实），两个系统各自生成的 ID 不可比。
 *
 * 对比口径（Q33、Q36、Q39）：
 * - **星级与去重**：确定性代码，要求 100% 匹配，任何差异都阻断；
 * - **分类**：模型调用不可复现（无固定 temperature），差异全部留证据，按差异率设阈值；
 *   差异率分母是**旧系统实际分类过的事件数**（交集），因为旧系统只在通过门槛+未去重后才分类；
 * - 合成/离线事件不得计入分类差异率（Q57）。
 *
 * 本模块只做计算与报告，不写数据库、不产生外部副作用。
 */

/** 旧 worker 旁路 sink 的一条记录（Q38-D：回调 + 重启标记 + reasonCode 全集）。 */
export interface LegacySinkRecord {
  /** 与 shared/domain.ts 的 REASON_CODES 对齐。 */
  reasonCode: string;
  receivedAt: string;
  projectKey: string | null;
  dedupeKey: string | null;
  star: number | null;
  previousStar: number | null;
  count: number | null;
  classification?: {
    type: string | null;
    confidence: number | null;
    reason: string | null;
    error: string | null;
  } | null;
  /** 旧 worker 本次启动是否发生过重启；重启窗口内去重集为空，会造成不可比样本。 */
  restartedInWindow?: boolean;
  /** 样本来源：真实流量或合成/回放（Q57 要求分开统计）。 */
  sampleSource?: 'live' | 'synthetic';
  detail?: Record<string, unknown>;
}

/** 新系统侧的判定（从 decisions 表读出）。 */
export interface NewSystemDecisionRecord {
  decisionId: string;
  projectKey: string | null;
  reasonCode: string;
  decidedAt: string;
  upstreamPushAtSec: number | null;
  star: number | null;
  previousStar: number | null;
  count: number | null;
  classificationType: string | null;
  classificationConfidence: number | null;
  classificationError: string | null;
  sampleSource?: 'live' | 'synthetic';
}

/** 对齐键：归一化账号 + 上游秒级时间。 */
export interface AlignmentKey {
  projectKey: string;
  pushAtSec: number;
}

/** 从旧 sink 记录推导对齐键：优先取去重键里的时间戳（与旧实现格式一致）。 */
export function legacyAlignmentKey(record: LegacySinkRecord): AlignmentKey | null {
  if (!record.projectKey) return null;
  const fromDedupe = dedupeKeyPushAt(record.dedupeKey);
  if (fromDedupe !== null) return { projectKey: record.projectKey, pushAtSec: fromDedupe };
  const parsed = Date.parse(record.receivedAt);
  if (Number.isNaN(parsed)) return null;
  // 没有去重键时退到接收时间（秒级）；调用方应把这类样本标记为弱对齐。
  return { projectKey: record.projectKey, pushAtSec: Math.floor(parsed / 1000) };
}

/** 从 `channel|link|title|push_at` 形态的去重键里取出 push_at（秒）。 */
export function dedupeKeyPushAt(dedupeKey: string | null): number | null {
  if (!dedupeKey) return null;
  const parts = dedupeKey.split('|');
  const last = parts[parts.length - 1];
  if (!last || !/^\d+$/.test(last)) return null;
  const value = Number.parseInt(last, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function newSystemAlignmentKey(record: NewSystemDecisionRecord): AlignmentKey | null {
  if (!record.projectKey || record.upstreamPushAtSec === null) return null;
  return { projectKey: record.projectKey, pushAtSec: record.upstreamPushAtSec };
}

export function alignmentKeyToString(key: AlignmentKey): string {
  return `${key.projectKey}@${key.pushAtSec}`;
}

/** 是否需要排除该样本（重启窗口造成的不可比差异，Q39）。 */
export function isExcludedSample(input: {
  restartedInWindow?: boolean;
  sampleSource?: 'live' | 'synthetic';
  includeSynthetic?: boolean;
}): { excluded: boolean; reason: 'restart_window' | 'synthetic' | null } {
  if (input.restartedInWindow) return { excluded: true, reason: 'restart_window' };
  if (input.sampleSource === 'synthetic' && !input.includeSynthetic) return { excluded: true, reason: 'synthetic' };
  return { excluded: false, reason: null };
}

export interface MismatchRecord {
  alignmentKey: string;
  projectKey: string;
  pushAtSec: number;
  dimension: 'star' | 'dedupe' | 'classification' | 'reason_code';
  legacy: string | null;
  next: string | null;
}

export interface ShadowComparisonReport {
  /** 两侧样本量。 */
  legacyTotal: number;
  newTotal: number;
  /** 成功对齐的事件数。 */
  matched: number;
  /** 仅旧系统有 / 仅新系统有（对齐失败，按自然键 join 的固有限制）。 */
  legacyOnly: number;
  newOnly: number;
  /** 被排除的样本数（重启窗口 / 合成）。 */
  excludedLegacy: number;
  excludedNew: number;
  /** 确定性维度：星级与去重。 */
  starMismatches: MismatchRecord[];
  dedupeMismatches: MismatchRecord[];
  /** 分类差异率的分母 = 旧系统实际分类过的事件数（交集，Q36）。 */
  classificationDenominator: number;
  classificationMismatches: MismatchRecord[];
  classificationMismatchRate: number;
  /** 报告生成时间。 */
  generatedAt: string;
}

export interface ShadowComparisonOptions {
  /** 是否把合成样本计入对比（Q57：默认不计入分类差异率）。 */
  includeSynthetic?: boolean;
  /** 分类差异率阈值，超过则建议阻断（Q33-D，默认 2%）。 */
  classificationThreshold?: number;
}

export const DEFAULT_CLASSIFICATION_THRESHOLD = 0.02;

/** 去重结论：把原因码归一到“是否被去重跳过”，因为两个系统可能用不同码表达同一件事。 */
function dedupeOutcome(reasonCode: string): 'repeated' | 'passed' {
  return reasonCode === 'DEDUPE_REPEAT' || reasonCode === 'IN_FLIGHT' || reasonCode === 'STAR_NOT_INCREASED'
    ? 'repeated'
    : 'passed';
}

/** 星级口径：双方都按“达到的星数”比较；未达门槛统一记为 0。 */
function starOutcome(star: number | null): number {
  return typeof star === 'number' && Number.isFinite(star) ? star : 0;
}

/** 分类结论：只看 type；调用异常单独记为 classify_error，不算类型不一致。 */
function classificationOutcome(input: {
  type: string | null;
  error?: string | null;
}): string {
  if (input.error) return 'classify_error';
  return input.type ?? 'none';
}

/**
 * 执行对比。纯函数：两侧数据由调用方读入。
 */
export function compareShadowSamples(
  legacyRecords: readonly LegacySinkRecord[],
  newRecords: readonly NewSystemDecisionRecord[],
  options: ShadowComparisonOptions = {}
): ShadowComparisonReport {
  const includeSynthetic = options.includeSynthetic ?? false;

  const legacyByKey = new Map<string, LegacySinkRecord>();
  let excludedLegacy = 0;
  for (const record of legacyRecords) {
    const exclusion = isExcludedSample({
      ...(record.restartedInWindow !== undefined ? { restartedInWindow: record.restartedInWindow } : {}),
      ...(record.sampleSource !== undefined ? { sampleSource: record.sampleSource } : {}),
      includeSynthetic,
    });
    if (exclusion.excluded) {
      excludedLegacy += 1;
      continue;
    }
    const key = legacyAlignmentKey(record);
    if (!key) continue;
    // 同一键重复出现时保留第一条：重复样本本身就是“去重”语义的一部分。
    const encoded = alignmentKeyToString(key);
    if (!legacyByKey.has(encoded)) legacyByKey.set(encoded, record);
  }

  const newByKey = new Map<string, NewSystemDecisionRecord>();
  let excludedNew = 0;
  for (const record of newRecords) {
    const exclusion = isExcludedSample({
      ...(record.sampleSource !== undefined ? { sampleSource: record.sampleSource } : {}),
      includeSynthetic,
    });
    if (exclusion.excluded) {
      excludedNew += 1;
      continue;
    }
    const key = newSystemAlignmentKey(record);
    if (!key) continue;
    const encoded = alignmentKeyToString(key);
    if (!newByKey.has(encoded)) newByKey.set(encoded, record);
  }

  const starMismatches: MismatchRecord[] = [];
  const dedupeMismatches: MismatchRecord[] = [];
  const classificationMismatches: MismatchRecord[] = [];
  let matched = 0;
  let classificationDenominator = 0;

  for (const [encoded, legacy] of legacyByKey) {
    const next = newByKey.get(encoded);
    if (!next) continue;
    matched += 1;
    const key = legacyAlignmentKey(legacy)!;

    // —— 确定性维度：星级 ——
    if (starOutcome(legacy.star) !== starOutcome(next.star)) {
      starMismatches.push({
        alignmentKey: encoded,
        projectKey: key.projectKey,
        pushAtSec: key.pushAtSec,
        dimension: 'star',
        legacy: String(starOutcome(legacy.star)),
        next: String(starOutcome(next.star)),
      });
    }

    // —— 确定性维度：去重结论 ——
    if (dedupeOutcome(legacy.reasonCode) !== dedupeOutcome(next.reasonCode)) {
      dedupeMismatches.push({
        alignmentKey: encoded,
        projectKey: key.projectKey,
        pushAtSec: key.pushAtSec,
        dimension: 'dedupe',
        legacy: dedupeOutcome(legacy.reasonCode),
        next: dedupeOutcome(next.reasonCode),
      });
    }

    // —— 模型维度：分类 —— 分母只算旧系统实际分类过的样本（Q36）
    const legacyClassified = legacy.classification !== null && legacy.classification !== undefined;
    if (legacyClassified) {
      classificationDenominator += 1;
      const legacyOutcome = classificationOutcome({
        type: legacy.classification?.type ?? null,
        ...(legacy.classification?.error !== undefined ? { error: legacy.classification.error } : {}),
      });
      const nextOutcome = classificationOutcome({
        type: next.classificationType,
        error: next.classificationError,
      });
      if (legacyOutcome !== nextOutcome) {
        classificationMismatches.push({
          alignmentKey: encoded,
          projectKey: key.projectKey,
          pushAtSec: key.pushAtSec,
          dimension: 'classification',
          legacy: legacyOutcome,
          next: nextOutcome,
        });
      }
    }
  }

  const legacyOnly = [...legacyByKey.keys()].filter((encoded) => !newByKey.has(encoded)).length;
  const newOnly = [...newByKey.keys()].filter((encoded) => !legacyByKey.has(encoded)).length;

  return {
    legacyTotal: legacyByKey.size,
    newTotal: newByKey.size,
    matched,
    legacyOnly,
    newOnly,
    excludedLegacy,
    excludedNew,
    starMismatches,
    dedupeMismatches,
    classificationDenominator,
    classificationMismatches,
    classificationMismatchRate:
      classificationDenominator === 0 ? 0 : classificationMismatches.length / classificationDenominator,
    generatedAt: new Date().toISOString(),
  };
}

/** 判定是否通过（Q16/Q33-D）：确定性维度必须 100%，分类差异率不超过阈值。 */
export function evaluateShadowAcceptance(
  report: ShadowComparisonReport,
  options: { threshold?: number; minMatched?: number; maxUnmatchedRatio?: number } = {}
): { passed: boolean; blockers: string[]; warnings: string[]; threshold: number } {
  const threshold = options.threshold ?? DEFAULT_CLASSIFICATION_THRESHOLD;
  const blockers: string[] = [];
  const warnings: string[] = [];

  // 没有对齐样本就没有对比证据。此时任何“无差异”都是假通过（端到端验证曾出现过
  // “仅旧 34 / 仅新 0”却判定通过的情况），必须先修好对齐再谈门槛。
  if (report.matched === 0) {
    blockers.push(
      `没有任何对齐样本（旧 ${report.legacyTotal}、新 ${report.newTotal}）：缺少对比证据，不能判定通过`
    );
  }

  if (report.starMismatches.length > 0) {
    blockers.push(`星级判定存在 ${report.starMismatches.length} 条差异（确定性维度要求 100% 匹配）`);
  }
  if (report.dedupeMismatches.length > 0) {
    blockers.push(`去重判定存在 ${report.dedupeMismatches.length} 条差异（确定性维度要求 100% 匹配）`);
  }
  if (report.classificationMismatchRate > threshold) {
    blockers.push(
      `分类差异率 ${(report.classificationMismatchRate * 100).toFixed(2)}% 超过阈值 ${(threshold * 100).toFixed(2)}%`
    );
  }

  if (options.minMatched !== undefined && report.matched < options.minMatched) {
    warnings.push(`对齐样本量 ${report.matched} 少于最小样本量 ${options.minMatched}（样本不足，结论不充分）`);
  }
  const maxUnmatchedRatio = options.maxUnmatchedRatio ?? 0.05;
  // 未对齐比例以“旧系统样本”为分母：影子期旧系统是权威执行者，它的样本才是应被覆盖的总体。
  const unmatchedRatio = report.legacyTotal === 0 ? 0 : report.legacyOnly / report.legacyTotal;
  if (unmatchedRatio > maxUnmatchedRatio) {
    warnings.push(
      `旧系统样本中有 ${(unmatchedRatio * 100).toFixed(1)}% 未在新系统找到对应判定（仅旧 ${report.legacyOnly}、仅新 ${report.newOnly}），需先解释对齐缺口`
    );
  }

  return { passed: blockers.length === 0, blockers, warnings, threshold };
}

/** 报告格式化成可放进 M5 证据包的 Markdown。 */
export function formatShadowReport(
  report: ShadowComparisonReport,
  acceptance: ReturnType<typeof evaluateShadowAcceptance>
): string {
  const lines: string[] = [];
  lines.push('## 影子对比报告');
  lines.push('');
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---:|');
  lines.push(`| 旧系统样本（去重后） | ${report.legacyTotal} |`);
  lines.push(`| 新系统样本（去重后） | ${report.newTotal} |`);
  lines.push(`| 成功对齐 | ${report.matched} |`);
  lines.push(`| 仅旧系统有 | ${report.legacyOnly} |`);
  lines.push(`| 仅新系统有 | ${report.newOnly} |`);
  lines.push(`| 排除：重启窗口/合成（旧） | ${report.excludedLegacy} |`);
  lines.push(`| 排除：合成（新） | ${report.excludedNew} |`);
  lines.push('');
  lines.push('### 确定性维度（要求 100% 匹配）');
  lines.push('');
  lines.push(`- 星级差异：${report.starMismatches.length} 条`);
  lines.push(`- 去重差异：${report.dedupeMismatches.length} 条`);
  lines.push('');
  lines.push('### 模型维度（留证 + 阈值）');
  lines.push('');
  lines.push(
    `- 分类差异：${report.classificationMismatches.length} / ${report.classificationDenominator}` +
      `（分母 = 旧系统实际分类过的样本数）`
  );
  lines.push(`- 分类差异率：${(report.classificationMismatchRate * 100).toFixed(2)}%（阈值 ${(acceptance.threshold * 100).toFixed(2)}%）`);
  lines.push('');
  lines.push('### 结论');
  lines.push('');
  lines.push(acceptance.passed ? '- 通过：确定性维度无差异，分类差异率未超阈值' : '- **未通过**');
  for (const blocker of acceptance.blockers) lines.push(`  - 阻断：${blocker}`);
  for (const warning of acceptance.warnings) lines.push(`  - 提示：${warning}`);
  return lines.join('\n');
}
