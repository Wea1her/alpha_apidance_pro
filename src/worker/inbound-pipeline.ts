import { isAlphaHeartbeat } from '../alpha-client.js';
import type { StoragePool } from '../storage/client.js';
import {
  findProjectKeyByDedupeKey,
  isDedupeKeyProcessed,
  persistDecision,
  persistEventLevelDecision,
  recordInboundEvent,
  resolveProject,
} from '../storage/decision-recorder.js';
import {
  decide,
  markSendFailed,
  type ClassificationOutcome,
  type DecisionContext,
  type DecisionOutcome,
  type ParsedAlphaEvent,
} from '../domain/decision-rules.js';
import { parseAlphaEvent } from '../domain/alpha-parser.js';

/**
 * 入站事件处理流水线（新栈）。
 *
 * 与旧实现 processAlphaMessage 的差异只在于“事实被持久化”：
 * 解析、心跳、门槛、去重、星级、分类、推送判定的顺序与语义完全一致。
 *
 * 本模块不做投递：推送由调用方在拿到 PUSHED 判定后执行，成功后调用
 * markPushSucceeded 回写项目状态与投递意图。这样生成、判定、投递三者互不阻塞。
 */

export interface HandleInboundEventOptions {
  pool: StoragePool;
  collectorId: string;
  ingestSeq: number;
  raw: string;
  receivedAt: string;
  starLevels: readonly number[];
  configVersionId?: string | null;
  /** 同一去重键是否正在处理中；由调用方的并发控制提供。 */
  isInFlight?: (dedupeKey: string) => boolean;
  classify?: (parsed: ParsedAlphaEvent, count: number, star: number) => Promise<ClassificationOutcome>;
  /** 推送实现；未提供表示只判定不推送（影子期即为此模式）。 */
  send?: (input: { parsed: ParsedAlphaEvent; outcome: DecisionOutcome }) => Promise<{
    chatId: string | number;
    messageId: number;
  }>;
  warn?: (message: string) => void;
}

export interface HandleInboundEventResult {
  eventId: string;
  decisionId: string | null;
  reasonCode: DecisionOutcome['reasonCode'] | 'PARSE_ERROR' | 'HEARTBEAT';
  projectId: string | null;
  /** 判定通过且推送成功时为 true。 */
  pushed: boolean;
  outcome: DecisionOutcome | null;
}

/** 事件 ID：同一采集器 + 接收序号唯一，重复投递得到同一 ID。 */
export function buildInboundEventId(collectorId: string, ingestSeq: number): string {
  return `${collectorId}:${ingestSeq}`;
}

export async function handleInboundEvent(options: HandleInboundEventOptions): Promise<HandleInboundEventResult> {
  const warn = options.warn ?? (() => undefined);
  const eventId = buildInboundEventId(options.collectorId, options.ingestSeq);

  // ---- 1. 解析：失败也要落库（原始 payload 是排查依据）----
  let parsed: ParsedAlphaEvent | null = null;
  let parseError: string | null = null;
  try {
    parsed = parseAlphaEvent(options.raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  if (!parsed) {
    await recordInboundEvent(options.pool, {
      eventId,
      collectorId: options.collectorId,
      ingestSeq: options.ingestSeq,
      receivedAt: options.receivedAt,
      rawPayload: options.raw,
      parsed: emptyParsed(),
      parseError,
    });
    await persistEventLevelDecision(options.pool, {
      eventId,
      reasonCode: 'PARSE_ERROR',
      decidedAt: options.receivedAt,
      configVersionId: options.configVersionId ?? null,
    });
    return { eventId, decisionId: null, reasonCode: 'PARSE_ERROR', projectId: null, pushed: false, outcome: null };
  }

  // 心跳不进入业务判定，但要留下接收记录（连接健康另有指标）。
  let heartbeat = false;
  try {
    heartbeat = isAlphaHeartbeat(JSON.parse(options.raw) as Record<string, unknown>);
  } catch {
    heartbeat = false;
  }

  await recordInboundEvent(options.pool, {
    eventId,
    collectorId: options.collectorId,
    ingestSeq: options.ingestSeq,
    receivedAt: options.receivedAt,
    rawPayload: options.raw,
    parsed,
    parseError: null,
  });

  if (heartbeat) {
    await persistEventLevelDecision(options.pool, {
      eventId,
      reasonCode: 'HEARTBEAT',
      decidedAt: options.receivedAt,
      configVersionId: options.configVersionId ?? null,
    });
    return { eventId, decisionId: null, reasonCode: 'HEARTBEAT', projectId: null, pushed: false, outcome: null };
  }

  // ---- 2. 找到或建立项目（未达门槛的账号也要留下跟踪记录）----
  const dedupeKey = parsed.legacyDedupeKey;
  // 项目键：同一账号的上一条事件可能已建立过项目，用它复用项目记录。
  const existingProjectKey = dedupeKey ? await findProjectKeyByDedupeKey(options.pool, dedupeKey) : null;
  const projectKey = existingProjectKey ?? parsed.projectKey ?? 'unknown';
  // 重复判断与项目复用是两件事：只有同一个去重键真的出现过，才算重复事件。
  const isDuplicate = dedupeKey ? await isDedupeKeyProcessed(options.pool, dedupeKey) : false;
  const project = await resolveProject(options.pool, { projectKey, parsed, source: 'natural' });

  // 未识别关注数：不建判定以外的副作用，但仍要记录“收到过”。
  const classificationEnabled = options.classify !== undefined;

  const context: DecisionContext = {
    eventId,
    parsed,
    project: {
      projectId: project.projectId,
      star: project.star,
      displayPushCount: project.displayPushCount,
      exists: project.exists,
    },
    starLevels: options.starLevels,
    isDuplicate,
    inFlight: dedupeKey ? options.isInFlight?.(dedupeKey) ?? false : false,
    configVersionId: options.configVersionId ?? null,
    decidedAt: options.receivedAt,
    ...(classificationEnabled ? { classify: options.classify } : {}),
  };

  const outcome = await decide(context);

  // ---- 3. 推送（可选）----
  let pushed = false;
  let channelMessage: { chatId: string | number; messageId: number } | null = null;
  let sendFailed = false;
  const wouldPush =
    outcome.reasonCode === 'CLASSIFY_ALLOWED' || outcome.reasonCode === 'CLASSIFY_ERROR_ALLOWED';
  if (wouldPush && options.send) {
    try {
      channelMessage = await options.send({ parsed, outcome });
      pushed = true;
    } catch (error) {
      sendFailed = true;
      warn(`推送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 原因码如实反映结果：成功记 PUSHED，失败记 SEND_FAILED（不得回写星级与展示序号）。
  const finalOutcome: DecisionOutcome = pushed
    ? { ...outcome, reasonCode: 'PUSHED' }
    : sendFailed
      ? markSendFailed(outcome)
      : outcome;

  const persisted = await persistDecision(options.pool, {
    eventId,
    projectId: project.projectId,
    projectKey,
    dedupeKey,
    persistence: {
      outcome: finalOutcome,
      configVersionId: options.configVersionId ?? null,
      decidedAt: options.receivedAt,
      channelMessage,
    },
  });

  return {
    eventId,
    decisionId: persisted.decisionId,
    reasonCode: finalOutcome.reasonCode,
    projectId: project.projectId,
    pushed,
    outcome: finalOutcome,
  };
}

function emptyParsed(): ParsedAlphaEvent {
  return {
    channel: null,
    title: null,
    link: null,
    content: null,
    upstreamPushAtSec: null,
    commonFollowCount: null,
    legacyDedupeKey: null,
    projectKey: null,
    displayName: null,
  };
}
