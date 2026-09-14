import {
  buildCommonFollowDecision,
  type CommonFollowDecision,
} from '../common-follow-rules.js';
import type { AccountClassificationRecord, ReasonCode } from '../../shared/domain.js';

/**
 * 判定规则引擎（纯函数部分）。
 *
 * 与旧实现 src/service.ts 的 processAlphaMessage 逐分支对齐，但把结果表达为
 * “原因码 + 需要写入的事实”，不再写 console 日志，也不再直接改内存 Map。
 *
 * 对齐关系（旧实现行号见提交时快照）：
 * - 无法解析消息 → PARSE_ERROR
 * - 心跳 → HEARTBEAT
 * - 未识别共同关注数 → COUNT_MISSING
 * - 未达门槛 → BELOW_THRESHOLD
 * - 重复事件 / 并发重复 → DEDUPE_REPEAT / IN_FLIGHT
 * - 星级未升高 → STAR_NOT_INCREASED
 * - 分类拦截 → CLASSIFY_BLOCKED；分类放行 → CLASSIFY_ALLOWED；分类异常 → CLASSIFY_ERROR_ALLOWED
 * - 推送成功 → PUSHED；推送失败 → SEND_FAILED
 *
 * 行为约束：本模块不修改任何业务规则；阈值语义、去重顺序、星级与 pushCount 计算
 * 必须与旧实现一致，差异只能体现为“多了一行可解释的记录”。
 */

/** 解析上游推送后的业务事实。 */
export interface ParsedAlphaEvent {
  channel: string | null;
  title: string | null;
  link: string | null;
  content: string | null;
  /** 上游事件时间（秒）；缺失为 null，不得用本地时间顶替。 */
  upstreamPushAtSec: number | null;
  commonFollowCount: number | null;
  /** 旧实现去重键原文，保留用于跨系统对比（Q31）。 */
  legacyDedupeKey: string | null;
  /** 归一化项目键（优先 handle）。 */
  projectKey: string | null;
  displayName: string | null;
}

/** 判定时已知的项目状态。 */
export interface ProjectSnapshot {
  projectId: string | null;
  star: number;
  /** 频道展示序号；与真实发送次数分离。 */
  displayPushCount: number;
  /** 项目是否已存在（不存在说明这是首次观察到）。 */
  exists: boolean;
}

export interface ClassificationOutcome {
  allowPush: boolean;
  type: string | null;
  confidence: number | null;
  reason: string | null;
  model: string | null;
  /** 分类调用失败时的错误信息；成功为 null。 */
  error: string | null;
}

export interface DecisionContext {
  eventId: string;
  parsed: ParsedAlphaEvent;
  project: ProjectSnapshot;
  /** 生效阈值；顺序即星级语义。 */
  starLevels: readonly number[];
  /** 该去重键此前是否已被处理过（重复事件）。 */
  isDuplicate: boolean;
  /** 同一去重键正在处理中（并发保护）。 */
  inFlight: boolean;
  /** 配置版本；缺失表示历史数据或未记录。 */
  configVersionId: string | null;
  decidedAt: string;
  /** 分类器；未配置表示不做账号分类。 */
  classify?: (parsed: ParsedAlphaEvent, count: number, star: number) => Promise<ClassificationOutcome>;
}

/** 判定需要落库的事实。 */
export interface DecisionOutcome {
  reasonCode: ReasonCode;
  /** 规则计算出的星级（未达门槛为 0）。 */
  star: number;
  previousStar: number;
  maxStar: number;
  count: number | null;
  isRepeat: boolean;
  inFlight: boolean;
  classification: AccountClassificationRecord | null;
  /** 是否需要创建/推进“分析任务”这一业务意图。 */
  shouldCreateAnalysisIntent: boolean;
  /** 是否为首次达到最高星（深度分析触发点）。 */
  isFirstMaxStar: boolean;
  /** 推送成功后应写入的频道展示序号；无需推送为 null。 */
  displayPushCountAfter: number | null;
  /** 推送成功后应写入的星级；未推送为 null。 */
  starAfter: number | null;
}

function shouldPushDecision(count: number, levels: readonly number[]): CommonFollowDecision {
  return buildCommonFollowDecision(count, levels);
}

/**
 * 旧实现的 pushCount 计算：未到最高星时等于星级；达到最高星时在上一值上累加且不低于最高星。
 */
export function calculateDisplayPushCount(previousPushCount: number, star: number, maxStar: number): number {
  if (star >= maxStar) {
    return Math.max(previousPushCount + 1, maxStar);
  }
  return star;
}

/** 未产生推送的判定结果骨架。 */
function skip(
  reasonCode: ReasonCode,
  context: DecisionContext,
  extra: Partial<DecisionOutcome> = {}
): DecisionOutcome {
  const maxStar = context.starLevels.length;
  return {
    reasonCode,
    star: extra.star ?? 0,
    previousStar: context.project.star,
    maxStar,
    count: extra.count ?? context.parsed.commonFollowCount,
    isRepeat: extra.isRepeat ?? false,
    inFlight: extra.inFlight ?? false,
    classification: extra.classification ?? null,
    shouldCreateAnalysisIntent: false,
    isFirstMaxStar: false,
    displayPushCountAfter: null,
    starAfter: null,
    ...extra,
  };
}

/**
 * 同步判定的结果：
 * - skip：已有结论，直接落库；
 * - classify：需要调用分类器并推送；
 * - max_star：已处于最高星，跳过“星级未升高”检查，仍需分类与推送。
 *
 * 拆成同步段 + 异步段，是为了让“分类”这个唯一的外部调用有明确边界：
 * 分类之前的所有判定都不依赖网络，可被影子对比逐条复用。
 */
export type PreClassificationResult =
  | { kind: 'skip'; outcome: DecisionOutcome }
  | { kind: 'classify' }
  | { kind: 'max_star' };

export function decideBeforeClassification(context: DecisionContext): PreClassificationResult {
  const { parsed, project, starLevels } = context;
  const maxStar = starLevels.length;

  if (parsed.commonFollowCount === null) {
    return { kind: 'skip', outcome: skip('COUNT_MISSING', context) };
  }

  const decision = shouldPushDecision(parsed.commonFollowCount, starLevels);
  if (!decision.shouldPush) {
    return { kind: 'skip', outcome: skip('BELOW_THRESHOLD', context, { star: 0, count: parsed.commonFollowCount }) };
  }

  if (context.isDuplicate) {
    return {
      kind: 'skip',
      outcome: skip('DEDUPE_REPEAT', context, {
        star: decision.star,
        count: parsed.commonFollowCount,
        isRepeat: true,
      }),
    };
  }

  if (context.inFlight) {
    return {
      kind: 'skip',
      outcome: skip('IN_FLIGHT', context, {
        star: decision.star,
        count: parsed.commonFollowCount,
        inFlight: true,
      }),
    };
  }

  const isMaxStar = decision.star >= maxStar;
  if (!isMaxStar && project.star >= decision.star) {
    return {
      kind: 'skip',
      outcome: skip('STAR_NOT_INCREASED', context, { star: decision.star, count: parsed.commonFollowCount }),
    };
  }

  // 到达最高星：与旧实现一致，跳过“星级未升高”判定，继续分类与推送。
  if (isMaxStar) {
    return { kind: 'max_star' };
  }

  return { kind: 'classify' };
}

/**
 * 完整判定：包含分类调用。分类失败按既有策略保守放行，并记录 CLASSIFY_ERROR_ALLOWED。
 */
export async function decide(context: DecisionContext): Promise<DecisionOutcome> {
  const pre = decideBeforeClassification(context);
  if (pre.kind === 'skip') return pre.outcome;

  const { parsed, project, starLevels } = context;
  const count = parsed.commonFollowCount!;
  const decision = shouldPushDecision(count, starLevels);
  const maxStar = starLevels.length;
  const isMaxStar = decision.star >= maxStar;
  const previousDisplayPushCount = project.displayPushCount > 0 ? project.displayPushCount : project.star;
  const displayPushCountAfter = calculateDisplayPushCount(previousDisplayPushCount, decision.star, maxStar);

  let classification: AccountClassificationRecord | null = null;
  let reasonCode: ReasonCode = 'CLASSIFY_ALLOWED';

  if (context.classify) {
    try {
      const outcome = await context.classify(parsed, count, decision.star);
      classification = {
        type: (outcome.type as AccountClassificationRecord['type']) ?? null,
        confidence: outcome.confidence,
        reason: outcome.reason,
        model: outcome.model,
        error: outcome.error,
      };
      if (!outcome.allowPush) {
        // 分类拦截：不改星级、不占展示序号、标记为已处理（旧实现同样把去重键加入集合）。
        return {
          reasonCode: 'CLASSIFY_BLOCKED',
          star: decision.star,
          previousStar: project.star,
          maxStar,
          count,
          isRepeat: false,
          inFlight: false,
          classification,
          shouldCreateAnalysisIntent: false,
          isFirstMaxStar: false,
          displayPushCountAfter: null,
          starAfter: null,
        };
      }
    } catch (error) {
      // 保守放行：记录异常，但不把它伪装成模型确认（Q38）。
      classification = {
        type: null,
        confidence: null,
        reason: null,
        model: null,
        error: error instanceof Error ? error.message : String(error),
      };
      reasonCode = 'CLASSIFY_ERROR_ALLOWED';
    }
  } else {
    classification = null;
  }

  // 与旧实现一致：首次从 0 升到 N 不算“星级变化”，因此不触发后置分析意图。
  const starChange = project.star > 0 && project.star < decision.star;
  return {
    reasonCode,
    star: decision.star,
    previousStar: project.star,
    maxStar,
    count,
    isRepeat: false,
    inFlight: false,
    classification,
    shouldCreateAnalysisIntent: starChange,
    isFirstMaxStar: isMaxStar,
    displayPushCountAfter,
    starAfter: decision.star,
  };
}

/**
 * 推送失败后的判定：保留原判定的原因码为 SEND_FAILED，供页面区分“判定通过但发送失败”。
 */
export function markSendFailed(outcome: DecisionOutcome): DecisionOutcome {
  return {
    ...outcome,
    reasonCode: 'SEND_FAILED',
    shouldCreateAnalysisIntent: false,
    displayPushCountAfter: null,
    starAfter: null,
  };
}
