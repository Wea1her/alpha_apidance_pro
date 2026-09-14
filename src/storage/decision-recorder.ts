import { createHash } from 'node:crypto';
import type { StoragePool, Queryable } from './client.js';
import type { AccountClassificationRecord, ReasonCode } from '../../shared/domain.js';
import type { DecisionOutcome, ParsedAlphaEvent } from '../domain/decision-rules.js';

/**
 * 判定落库：接收记录 → 判定记录 →（推送成功时）项目状态与投递记录。
 *
 * 设计要点：
 * - 接收记录先落库，解析失败也保留（第 5 节要求保留每次接收，不能只留成功的）。
 * - 判定记录对每条接收记录最多一条（数据库唯一索引兜底）。
 * - 项目状态更新与判定写入在同一事务内完成，并用行级锁串行化同一账号的处理，
 *   避免较晚事件抢先修改星级（第 4 节要求按接收顺序推进）。
 * - 投递记录与报告生成解耦（Q55）：推送成功只登记“频道主消息”这一投递意图。
 * - 未推送的分支一律不写投递记录，页面据此显示“为什么没推”。
 */

export interface RecordInboundEventInput {
  eventId: string;
  collectorId: string;
  /** 接收顺序；同一采集器内单调递增。 */
  ingestSeq: number;
  receivedAt: string;
  rawPayload: string;
  parsed: ParsedAlphaEvent;
  /** 解析失败时的错误信息；成功为 null。 */
  parseError?: string | null;
}

export interface DecisionPersistence {
  outcome: DecisionOutcome;
  configVersionId: string | null;
  decidedAt: string;
  /** 推送成功时返回的频道消息引用；未推送为 null。 */
  channelMessage?: { chatId: string | number; messageId: number } | null;
}

export interface PersistDecisionResult {
  /** 数据库里真实的 decision_id；重复判定被约束拒绝时为 null。 */
  decisionId: string | null;
  projectId: string | null;
  /** 重复判定（同一接收记录已有判定）时为 true。 */
  decisionAlreadyExisted: boolean;
}

/** 判定通过（应回写星级与序号、并登记投递意图）的原因码。 */
const PASSED_REASON_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'PUSHED',
  'CLASSIFY_ALLOWED',
  'CLASSIFY_ERROR_ALLOWED',
]);

/** 稳定的业务 ID：同一输入重复执行得到同一 ID。 */
function stableId(prefix: string, ...parts: Array<string | null | undefined>): string {
  const digest = createHash('sha256').update(parts.map((part) => part ?? '').join('\u0000')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

export function buildDecisionId(eventId: string): string {
  return stableId('dec', eventId);
}

/** 落库接收记录；event_id 冲突时视为重复投递，不覆盖原始事实。 */
export async function recordInboundEvent(pool: StoragePool, input: RecordInboundEventInput): Promise<{ inserted: boolean }> {
  const result = await pool.query(
    `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload, channel, title, link,
                                content, common_follow_count, legacy_dedupe_key, parse_error, upstream_push_at_sec)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      input.eventId,
      input.collectorId,
      input.ingestSeq,
      input.receivedAt,
      input.rawPayload,
      input.parsed.channel,
      input.parsed.title,
      input.parsed.link,
      input.parsed.content,
      input.parsed.commonFollowCount,
      input.parsed.legacyDedupeKey,
      input.parseError ?? null,
      input.parsed.upstreamPushAtSec,
    ]
  );
  return { inserted: (result.rowCount ?? 0) > 0 };
}

export interface ResolveProjectInput {
  projectKey: string;
  parsed: ParsedAlphaEvent;
  /** 首次观察到的项目来源。 */
  source: 'natural' | 'restored' | 'history_import';
}

export interface ResolvedProject {
  projectId: string;
  star: number;
  displayPushCount: number;
  exists: boolean;
}

/**
 * 按归一化账号找到或创建项目。
 *
 * 未达推送门槛的账号也会建立记录（第 5 节：所有收到的目标账号都可建立跟踪记录），
 * 这样页面才能回答“这个账号到底收到过没有”。
 */
export async function resolveProject(
  client: Queryable,
  input: ResolveProjectInput
): Promise<ResolvedProject> {
  const existing = await client.query(
    `SELECT project_id, star, display_push_count, pool_state FROM projects WHERE project_key = $1`,
    [input.projectKey]
  );
  const row = existing.rows[0];
  if (row) {
    return {
      projectId: String(row.project_id),
      star: Number(row.star ?? 0),
      displayPushCount: Number(row.display_push_count ?? 0),
      exists: true,
    };
  }

  const projectId = stableId('proj', input.projectKey);
  await client.query(
    `INSERT INTO projects (project_id, project_key, display_name, link, source, pool_state, star,
                           display_push_count, first_event_at, last_event_at, entered_pool_at, legacy_dedupe_key)
     VALUES ($1, $2, $3, $4, $5, 'monitored', 0, 0,
             CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6) END,
             CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6) END,
             now(), $7)
     ON CONFLICT (project_key) DO NOTHING`,
    [
      projectId,
      input.projectKey,
      input.parsed.displayName,
      input.parsed.link,
      input.source,
      input.parsed.upstreamPushAtSec,
      input.parsed.legacyDedupeKey,
    ]
  );

  const resolved = await client.query(`SELECT project_id, star, display_push_count FROM projects WHERE project_key = $1`, [
    input.projectKey,
  ]);
  const created = resolved.rows[0];
  return {
    projectId: String(created?.project_id ?? projectId),
    star: Number(created?.star ?? 0),
    displayPushCount: Number(created?.display_push_count ?? 0),
    exists: false,
  };
}

/**
 * 该去重键此前是否已经处理过（真正的重复事件）。
 *
 * 注意：不能拿“项目最近一次的去重键”当重复判断——同一账号的下一条事件
 * 去重键不同，但项目键相同，那属于新事件而不是重复。
 */
export async function isDedupeKeyProcessed(client: Queryable, dedupeKey: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM inbound_events e
       JOIN decisions d ON d.event_id = e.event_id
      WHERE e.legacy_dedupe_key = $1
      LIMIT 1`,
    [dedupeKey]
  );
  return result.rows.length > 0;
}

/** 该去重键此前是否已经处理过（重复事件）。 */
export async function findProjectKeyByDedupeKey(client: Queryable, dedupeKey: string): Promise<string | null> {
  const result = await client.query(
    `SELECT project_key FROM projects WHERE legacy_dedupe_key = $1 LIMIT 1`,
    [dedupeKey]
  );
  return typeof result.rows[0]?.project_key === 'string' ? result.rows[0].project_key : null;
}

/**
 * 写入判定记录，并在推送成功时更新项目状态、登记投递意图。
 *
 * 返回 decisionId 为 null 表示该接收记录已有判定（数据库唯一索引拒绝），调用方据此跳过重复处理。
 */
export async function persistDecision(
  pool: StoragePool,
  input: {
    eventId: string;
    projectId: string | null;
    projectKey: string;
    persistence: DecisionPersistence;
    /** 本次事件的旧去重键原文；用于重复事件回查与跨系统对比。 */
    dedupeKey: string | null;
    /** 是否已在事务外串行化；默认由本函数自行加锁。 */
    lockProject?: boolean;
  }
): Promise<PersistDecisionResult> {
  const { outcome, configVersionId, decidedAt } = input.persistence;
  const decisionId = buildDecisionId(input.eventId);
  const classification: AccountClassificationRecord | null = outcome.classification;

  return pool.transaction(async (client) => {
    if (input.projectId && input.lockProject !== false) {
      // 行级锁：同一账号的判定按接收顺序串行推进，避免较晚事件抢先改星级。
      await client.query('SELECT project_id FROM projects WHERE project_id = $1 FOR UPDATE', [input.projectId]);
    }

    const inserted = await client.query(
      `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at, config_version_id,
                              star, previous_star, max_star, common_follow_count, star_levels, is_repeat, in_flight,
                              classification_type, classification_confidence, classification_reason, classification_model,
                              classification_error)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        decisionId,
        input.eventId,
        input.projectId,
        input.projectKey,
        outcome.reasonCode,
        decidedAt,
        configVersionId,
        outcome.star,
        outcome.previousStar,
        outcome.maxStar,
        outcome.count,
        null,
        outcome.isRepeat,
        outcome.inFlight,
        classification?.type ?? null,
        classification?.confidence ?? null,
        classification?.reason ?? null,
        classification?.model ?? null,
        classification?.error ?? null,
      ]
    );

    if ((inserted.rowCount ?? 0) === 0) {
      return { decisionId: null, projectId: input.projectId, decisionAlreadyExisted: true };
    }

    await client.query(`UPDATE inbound_events SET processed_at = $2::timestamptz WHERE event_id = $1`, [
      input.eventId,
      decidedAt,
    ]);

    if (!input.projectId) {
      return { decisionId, projectId: null, decisionAlreadyExisted: false };
    }

    // 判定通过（含分类异常保守放行）：更新星级与展示序号，并登记频道主消息投递意图。
    // SEND_FAILED 不在其中——推送失败不回写星级与序号。
    const passed = PASSED_REASON_CODES.has(outcome.reasonCode);
    if (passed && outcome.starAfter !== null) {
      await client.query(
        `UPDATE projects SET star = $2, display_push_count = COALESCE($3, display_push_count),
                             last_event_at = COALESCE(last_event_at, now()), updated_at = now()
         WHERE project_id = $1`,
        [input.projectId, outcome.starAfter, outcome.displayPushCountAfter]
      );

      const channelMessage = input.persistence.channelMessage ?? null;
      if (channelMessage) {
        await client.query(
          `INSERT INTO delivery_records (delivery_id, project_id, purpose, target_chat_id, shard_index,
                                         message_id, sent_at, attempts)
           VALUES ($1, $2, 'channel_main', $3, 0, $4, $5::timestamptz, 1)
           ON CONFLICT DO NOTHING`,
          [
            stableId('dlv', input.projectKey, String(channelMessage.chatId), String(channelMessage.messageId)),
            input.projectId,
            String(channelMessage.chatId),
            channelMessage.messageId,
            decidedAt,
          ]
        );
        // 真实发送次数只统计已确认回执，与展示序号分离（Q96）。
        await client.query(
          `UPDATE projects SET confirmed_send_count = confirmed_send_count + 1 WHERE project_id = $1`,
          [input.projectId]
        );
      }
    } else {
      // 未推送也要推进“最近事件时间”，但不得改动星级与展示序号。
      await client.query(
        `UPDATE projects SET last_event_at = COALESCE(last_event_at, now()), updated_at = now() WHERE project_id = $1`,
        [input.projectId]
      );
    }

    // 记录该项目的最近去重键，供重复事件回查（与判定同事务）。
    if (input.dedupeKey) {
      await client.query(`UPDATE projects SET legacy_dedupe_key = $2, updated_at = now() WHERE project_id = $1`, [
        input.projectId,
        input.dedupeKey,
      ]);
    }
    return { decisionId, projectId: input.projectId, decisionAlreadyExisted: false };
  });
}

/** 写入无项目的判定（解析失败、心跳、未识别关注数等）。 */
export async function persistEventLevelDecision(
  pool: StoragePool,
  input: { eventId: string; reasonCode: ReasonCode; decidedAt: string; configVersionId?: string | null }
): Promise<{ decisionId: string | null }> {
  const decisionId = buildDecisionId(input.eventId);
  const inserted = await pool.query(
    `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at, config_version_id,
                            is_repeat, in_flight)
     VALUES ($1, $2, NULL, NULL, $3, $4::timestamptz, $5, false, false)
     ON CONFLICT (event_id) DO NOTHING`,
    [decisionId, input.eventId, input.reasonCode, input.decidedAt, input.configVersionId ?? null]
  );
  if ((inserted.rowCount ?? 0) > 0) {
    await pool.query(`UPDATE inbound_events SET processed_at = $2::timestamptz WHERE event_id = $1`, [
      input.eventId,
      input.decidedAt,
    ]);
    return { decisionId };
  }
  return { decisionId: null };
}
