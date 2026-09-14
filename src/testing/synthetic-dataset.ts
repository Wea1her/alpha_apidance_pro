import type { StoragePool } from '../storage/client.js';

/**
 * 合成数据生成器（M5，验收方案第 3 节）。
 *
 * 依据：`docs/architecture/frontend-migration-validation.md` 第 3 节要求
 * “在隔离数据库生成 100 万条合成业务接收记录、10 万个账号，以及标准/深度报告、任务与投递历史。
 * 固定随机种子，混合普通账号和热点账号；保留重复、解析失败及分类失败后放行等边界样本”。
 *
 * 硬约束：
 * - **固定随机种子**：同一 seed + 同一参数产生完全相同的样本，压测可复现；
 * - **只写合成库**：调用方必须传测试/压测数据库；本模块不做连接串校验，因此禁止在生产环境调用；
 * - 不产生外部副作用：不调用模型、不发送 Telegram、不创建真实施工任务意图；
 * - 覆盖边界样本，否则压测结果会掩盖真实分布（热点账号、重复、解析失败、分类异常）。
 *
 * 生成量级参考（百万级）：accounts=100_000、events=1_000_000 在批处理下应保持内存平稳，
 * 因此本模块按批写入，不把全量数据留在内存里。
 */

/**
 * 单个 INSERT 语句的参数上限。
 *
 * PostgreSQL 的扩展查询协议用 Int16 表示参数个数，上限 32767；
 * 每行 `inbound_events` 占 10 个参数，所以批量必须小于约 3276 行。
 * 这个上限是实跑 1 万行批量时报出来的（“bind message has 34464 parameter formats but 0 parameters”），
 * 不是理论推演——因此在此显式收敛，避免调用方传入过大批量。
 */
export const POSTGRES_MAX_PARAMS_PER_STATEMENT = 32_767;
/** 每行 `inbound_events` 的参数个数（与 insertEventBatch 的实现保持一致）。 */
export const INBOUND_EVENT_PARAMS_PER_ROW = 10;

/** 把请求的批量收敛到协议允许的范围。 */
export function clampBatchSize(requested: number | undefined): number {
  const safe = Math.floor(POSTGRES_MAX_PARAMS_PER_STATEMENT / INBOUND_EVENT_PARAMS_PER_ROW);
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return safe;
  return Math.max(1, Math.min(Math.floor(requested), safe));
}

export interface SyntheticDatasetOptions {
  /** 随机种子；同一 seed 必须产生同一数据集。 */
  seed: number;
  /** 账号数量（验收目标：100_000）。 */
  accounts: number;
  /** 业务接收记录数量（验收目标：1_000_000）。 */
  events: number;
  /** 数据分布的天数（验收目标：90 天）。 */
  days?: number;
  /** 批大小；按批写入以保持内存平稳。 */
  batchSize?: number;
  /** 是否生成重复接收记录（同一去重键重复到达）。 */
  includeDuplicates?: boolean;
  /** 是否生成解析失败记录。 */
  includeParseErrors?: boolean;
  /** 是否生成分类异常后放行的记录。 */
  includeClassificationErrors?: boolean;
  /** 热点账号占比（0-1）；热点账号会接收远多于平均值的事件。 */
  hotAccountRatio?: number;
  /** 进度回调，便于长任务观察。 */
  onProgress?: (progress: { written: number; total: number }) => void;
}

export interface SyntheticDatasetSummary {
  accounts: number;
  events: number;
  duplicates: number;
  parseErrors: number;
  classificationErrors: number;
  decisions: number;
  projects: number;
  excludedProjects: number;
  hotAccounts: number;
}

/** mulberry32：小而确定的 PRNG，保证跨进程可复现。 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 合成账号：handle 与展示名可复现地由索引派生。 */
export function syntheticAccount(index: number): { projectKey: string; displayName: string; link: string } {
  const projectKey = `synth${String(index).padStart(6, '0')}`;
  return { projectKey, displayName: `Synth Project ${index}`, link: `https://x.com/${projectKey}` };
}

/** 阈值档位（与本地生效配置一致：3/8/13/18/23）。 */
export const SYNTH_STAR_LEVELS = [3, 8, 13, 18, 23] as const;

/** 由共同关注数推导星级；与 src/common-follow-rules.ts 的语义一致（不修改业务规则）。 */
export function starForCount(count: number, levels: readonly number[] = SYNTH_STAR_LEVELS): number {
  let star = 0;
  for (const [index, threshold] of levels.entries()) {
    if (count >= threshold) star = index + 1;
  }
  return star;
}

/** 压测用的事件骨架：包含页面与判定需要的全部字段。 */
export interface SyntheticEvent {
  projectKey: string;
  count: number;
  star: number;
  pushAtSec: number;
  receivedAt: string;
  dedupeKey: string;
  rawPayload: string;
  parseError: string | null;
  classificationError: string | null;
  isDuplicate: boolean;
  reasonCode: string;
}

/**
 * 生成单条合成事件。纯函数：随机数由调用方提供，因此同一随机序列产生同一结果。
 */
export function buildSyntheticEvent(input: {
  random: () => number;
  accountIndex: number;
  sequence: number;
  baseTimeMs: number;
  windowMs: number;
  options: Required<Pick<SyntheticDatasetOptions, 'includeDuplicates' | 'includeParseErrors' | 'includeClassificationErrors'>>;
}): SyntheticEvent {
  const { random, accountIndex, sequence, baseTimeMs, windowMs, options } = input;
  const account = syntheticAccount(accountIndex);
  const pushAtSec = Math.floor((baseTimeMs + random() * windowMs) / 1000);
  const receivedAt = new Date(pushAtSec * 1000 + Math.floor(random() * 1000)).toISOString();

  // 共同关注数分布：多数在低位（未达门槛），少数冲高（覆盖各星级）。
  const roll = random();
  let count: number;
  if (roll < 0.55) count = Math.floor(random() * 3); // 0-2：未达门槛
  else if (roll < 0.8) count = 3 + Math.floor(random() * 5); // 3-7：一星
  else if (roll < 0.92) count = 8 + Math.floor(random() * 5); // 8-12：二星
  else if (roll < 0.98) count = 13 + Math.floor(random() * 5); // 13-17：三星
  else count = 18 + Math.floor(random() * 8); // 18+：四星及以上

  const star = starForCount(count);
  const parseError = options.includeParseErrors && random() < 0.01 ? 'Unexpected end of JSON input' : null;
  const classificationError =
    options.includeClassificationErrors && !parseError && random() < 0.02 ? 'classification timeout' : null;
  const isDuplicate = options.includeDuplicates && !parseError && random() < 0.05;

  // 去重键与旧实现一致：channel|link|title|push_at；重复样本沿用同一个键与时间戳。
  const title = `Follower${sequence % 97} 关注了 ${account.displayName}`;
  const dedupeKey = `follow|${account.link}|${title}|${pushAtSec}`;

  let reasonCode: string;
  if (parseError) reasonCode = 'PARSE_ERROR';
  else if (count === 0) reasonCode = 'COUNT_MISSING';
  else if (star === 0) reasonCode = 'BELOW_THRESHOLD';
  else if (isDuplicate) reasonCode = 'DEDUPE_REPEAT';
  else if (classificationError) reasonCode = 'CLASSIFY_ERROR_ALLOWED';
  else if (random() < 0.35) reasonCode = 'PUSHED';
  else reasonCode = 'CLASSIFY_ALLOWED';

  const rawPayload = parseError
    ? '{"channel":"follow","broken":'
    : JSON.stringify({
        channel: 'follow',
        title,
        link: account.link,
        content: `你关注的${count}个用户也关注了ta`,
        push_at: pushAtSec,
        commonFollowCount: count,
      });

  return {
    projectKey: account.projectKey,
    count,
    star,
    pushAtSec,
    receivedAt,
    dedupeKey,
    rawPayload,
    parseError,
    classificationError,
    isDuplicate,
    reasonCode,
  };
}

/**
 * 写入合成数据集。
 *
 * 实现要点：
 * - 账号先建（含星级分布），事件与判定按批写入，批间不保留状态；
 * - 解析失败与重复样本也建立接收记录（真实系统同样保留它们）；
 * - 报告/任务/投递历史只建少量代表性样本，用于验证列表与详情页在数据量下的表现。
 */
export async function generateSyntheticDataset(
  pool: StoragePool,
  options: SyntheticDatasetOptions
): Promise<SyntheticDatasetSummary> {
  const days = options.days ?? 90;
  // 批量必须收敛到协议上限以内（见 clampBatchSize 的说明）。
  const batchSize = clampBatchSize(options.batchSize);
  const hotAccountRatio = options.hotAccountRatio ?? 0.01;
  const random = createSeededRandom(options.seed);
  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const baseTimeMs = now - windowMs;

  const summary: SyntheticDatasetSummary = {
    accounts: options.accounts,
    events: 0,
    duplicates: 0,
    parseErrors: 0,
    classificationErrors: 0,
    decisions: 0,
    projects: 0,
    excludedProjects: 0,
    hotAccounts: Math.floor(options.accounts * hotAccountRatio),
  };

  // ---- 1. 账号与项目 ----
  const hotAccountCount = summary.hotAccounts;
  for (let offset = 0; offset < options.accounts; offset += batchSize) {
    const rows: Array<[string, string, string, number, string]> = [];
    const end = Math.min(offset + batchSize, options.accounts);
    for (let index = offset; index < end; index += 1) {
      const account = syntheticAccount(index);
      // 星级分布：多数低星，少量高星；热点账号更可能高星。
      const isHot = index < hotAccountCount;
      const star = isHot ? 3 + Math.floor(random() * 3) : Math.floor(random() * 5);
      const source = random() < 0.05 ? 'restored' : 'natural';
      rows.push([`proj_synth_${index}`, account.projectKey, account.displayName, star, source]);
    }
    await insertProjectBatch(pool, rows);
    summary.projects += rows.length;
  }

  // 少量已排除项目：覆盖排除列表与“已排除不再检索”的分支。
  const excludedCount = Math.max(1, Math.floor(options.accounts * 0.002));
  await pool.query(
    `INSERT INTO projects (project_id, project_key, source, pool_state, star, excluded_at, exclusion_reason, excluded_star)
     SELECT 'proj_excluded_' || g, 'excluded' || g, 'natural', 'excluded', 0, now(), 
            CASE WHEN g % 2 = 0 THEN 'manual' ELSE 'classification' END, 1
       FROM generate_series(1, $1) AS g
     ON CONFLICT DO NOTHING`,
    [excludedCount]
  );
  summary.excludedProjects = excludedCount;

  // ---- 2. 接收记录与判定 ----
  let sequence = 0;
  for (let offset = 0; offset < options.events; offset += batchSize) {
    const end = Math.min(offset + batchSize, options.events);
    const eventRows: Array<[string, string, number, string, string, string, string | null, number | null, string | null, number | null]> = [];
    const decisionRows: Array<[string, string, string | null, string, string, number | null, number | null, string | null]> = [];

    for (let index = offset; index < end; index += 1) {
      sequence += 1;
      // 热点账号获得更多事件：让列表筛选与详情页面对真实偏斜分布。
      const accountIndex =
        sequence % 10 === 0 && hotAccountCount > 0
          ? Math.floor(random() * hotAccountCount)
          : Math.floor(random() * options.accounts);

      const event = buildSyntheticEvent({
        random,
        accountIndex,
        sequence,
        baseTimeMs,
        windowMs,
        options: {
          includeDuplicates: options.includeDuplicates ?? true,
          includeParseErrors: options.includeParseErrors ?? true,
          includeClassificationErrors: options.includeClassificationErrors ?? true,
        },
      });

      const eventId = `synth_evt_${sequence}`;
      // 元组顺序：[eventId, collectorId, seq, receivedAt, rawPayload, link, parseError, count, dedupeKey, pushAtSec]
      // link 必须写入：页面依赖它回填/展示项目的首次与最近事件时间（此前漏写导致全部显示“无记录”）。
      // 必须在插入前把 pushAtSec 一并写入：影子对比的对齐键依赖它（Q31），
      // 缺了它新系统侧一条样本都无法对齐（这正是端到端验证暴露的问题）。
      eventRows.push([
        eventId,
        'synth-collector',
        sequence,
        event.receivedAt,
        event.rawPayload,
        `https://x.com/${syntheticAccount(accountIndex).projectKey}`,
        event.parseError,
        event.count,
        event.dedupeKey,
        event.pushAtSec,
      ]);

      const projectId = event.parseError ? null : `proj_synth_${accountIndex}`;
      decisionRows.push([
        `synth_dec_${sequence}`,
        eventId,
        projectId,
        event.projectKey,
        event.reasonCode,
        event.star,
        event.count,
        event.classificationError,
      ]);

      summary.decisions += 1;
      if (event.parseError) summary.parseErrors += 1;
      if (event.classificationError) summary.classificationErrors += 1;
      if (event.isDuplicate) summary.duplicates += 1;
    }

    await insertEventBatch(pool, eventRows, decisionRows);
    summary.events += eventRows.length;
    options.onProgress?.({ written: summary.events, total: options.events });
  }

  // ---- 2.5 回填项目的首次/最近事件时间 ----
  // 合成数据是按批直接写库的，绕过了真实流水线；若不回填，页面上每个项目都会显示“最近事件：无记录”，
  // 演示时会掩盖“展示真实事件时间”的能力。真实流水线在 decision-recorder 里维护这两个字段。
  // 项目键取 link 里的 handle，与 alpha-parser 的 buildProjectKey 规则一致。
  await pool.query(
    `UPDATE projects p
        SET first_event_at = agg.first_at,
            last_event_at = agg.last_at
       FROM (
         SELECT substring(e.link from 'x\\.com/([^/?#]+)') AS project_key,
                min(e.received_at) AS first_at,
                max(e.received_at) AS last_at
           FROM inbound_events e
          WHERE e.link LIKE '%x.com/%'
          GROUP BY 1
       ) AS agg
      WHERE p.project_key = agg.project_key`
  );

  // ---- 3. 代表性报告、任务与投递历史 ----
  // 只建少量样本：用于验证列表/详情在数据量下的表现，不追求覆盖全部账号。
  const sampleSize = Math.min(500, options.accounts);
  await pool.query(
    `INSERT INTO reports (report_id, project_id, kind, body, generated_at, triggered_by, model)
     SELECT 'synth_rep_' || g, 'proj_synth_' || (g - 1), 'standard',
            repeat('合成报告正文。', 40), now() - (g || ' hours')::interval, 'natural', 'grok-4.3'
       FROM generate_series(1, $1) AS g
     ON CONFLICT DO NOTHING`,
    [sampleSize]
  );
  await pool.query(
    `INSERT INTO reports (report_id, project_id, kind, body, generated_at, triggered_by, model)
     SELECT 'synth_deep_' || g, 'proj_synth_' || (g - 1), 'deep',
            repeat('合成深度报告正文。', 80), now() - (g || ' hours')::interval, 'natural', 'grok-4.20-multi-agent-0309'
       FROM generate_series(1, $1) AS g
     ON CONFLICT DO NOTHING`,
    [sampleSize]
  );
  await pool.query(
    `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by, created_at)
     SELECT 'synth_job_' || g, 'standard', 'proj_synth_' || (g - 1),
            CASE WHEN g % 10 = 0 THEN 'queued' WHEN g % 10 = 1 THEN 'failed' ELSE 'succeeded' END,
            'natural', now() - (g || ' minutes')::interval
       FROM generate_series(1, $1) AS g
     ON CONFLICT DO NOTHING`,
    [sampleSize]
  );
  await pool.query(
    `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by, created_at)
     SELECT 'synth_restore_job_' || g, 'standard', 'proj_synth_' || (g - 1), 'queued', 'restore',
            now() - (g || ' minutes')::interval
       FROM generate_series(1, $1) AS g
     ON CONFLICT DO NOTHING`,
    [Math.min(50, sampleSize)]
  );
  await pool.query(
    `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, shard_index,
                                   attempts, sent_at, message_id, abandoned, uncertain)
     SELECT 'synth_dlv_' || g, 'proj_synth_' || (g - 1), 'synth_rep_' || g, 'discussion_report', '-100999', 0,
            CASE WHEN g % 7 = 0 THEN 0 ELSE 1 END,
            CASE WHEN g % 7 = 0 THEN NULL ELSE now() END,
            CASE WHEN g % 7 = 0 THEN NULL ELSE 900000 + g END,
            CASE WHEN g % 23 = 0 THEN true ELSE false END,
            CASE WHEN g % 11 = 0 THEN true ELSE false END
       FROM generate_series(1, $1) AS g
     ON CONFLICT DO NOTHING`,
    [sampleSize]
  );

  return summary;
}

async function insertProjectBatch(
  pool: StoragePool,
  rows: Array<[string, string, string, number, string]>
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const placeholders = rows
    .map((row, index) => {
      const base = index * 5;
      values.push(row[0], row[1], row[2], row[3], row[4]);
      return `($${base + 1}, $${base + 2}, 'monitored', $${base + 4}, $${base + 5}, $${base + 3})`;
    })
    .join(',');
  await pool.query(
    `INSERT INTO projects (project_id, project_key, pool_state, star, source, display_name)
     VALUES ${placeholders}
     ON CONFLICT (project_id) DO NOTHING`,
    values
  );
}

async function insertEventBatch(
  pool: StoragePool,
  events: Array<[string, string, number, string, string, string, string | null, number | null, string | null, number | null]>,
  decisions: Array<[string, string, string | null, string, string, number | null, number | null, string | null]>
): Promise<void> {
  if (events.length === 0) return;

  const eventValues: unknown[] = [];
  const eventPlaceholders = events
    .map((row, index) => {
      // 每行 10 个参数：占位符基数必须与压入的值数量一致（错位会导致类型推断失败）。
      const base = index * 10;
      // 与 INSERT 的列顺序严格一致：event_id, collector_id, ingest_seq, received_at, raw_payload,
      //         common_follow_count, legacy_dedupe_key, parse_error, upstream_push_at_sec
      // row 元组顺序是 [eventId, collectorId, seq, receivedAt, rawPayload, parseError, count, dedupeKey, pushAtSec]。
      eventValues.push(row[0], row[1], row[2], row[3], row[4], row[5], row[7], row[8], row[6], row[9]);
      // 可空列显式转型：整批可能全为 null，Postgres 无法推断参数类型。
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::timestamptz, $${base + 5}, $${base + 6}::text, $${base + 7}::int, $${base + 8}::text, $${base + 9}::text, $${base + 10}::bigint)`;
    })
    .join(',');
  await pool.query(
    `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload, link,
                                 common_follow_count, legacy_dedupe_key, parse_error, upstream_push_at_sec)
     VALUES ${eventPlaceholders}
     ON CONFLICT (event_id) DO NOTHING`,
    eventValues
  );

  const decisionValues: unknown[] = [];
  const decisionPlaceholders = decisions
    .map((row, index) => {
      const base = index * 8;
      decisionValues.push(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]);
      return `($${base + 1}, $${base + 2}, $${base + 3}::text, $${base + 4}, $${base + 5}, now(), $${base + 6}::int, $${base + 7}::int, $${base + 8}::text)`;
    })
    .join(',');
  await pool.query(
    `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at,
                            star, common_follow_count, classification_error)
     VALUES ${decisionPlaceholders}
     ON CONFLICT (decision_id) DO NOTHING`,
    decisionValues
  );
}
