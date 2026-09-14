import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { StoragePool } from './client.js';

/**
 * 历史导入：把现存 JSON/JSONL 事实迁入 PostgreSQL。
 *
 * 硬约束（第 10 节、Q15、实施计划 M1 出口条件）：
 * - 只迁移事实，不编造缺失的原始事件、分类理由、去重结论或生成时间。
 * - 历史事件的 push_at、原因码、配置版本一律留空，页面显示“历史数据缺失”。
 * - 导入不产生模型请求、不发送 Telegram、不创建任务。
 * - 可重复执行：以确定性历史 ID + ON CONFLICT DO NOTHING 保证幂等。
 *
 * 缺失事实与可迁移事实的对应关系见实施计划第 1 节与主规划第 5 节。
 */

export interface LegacyImportPaths {
  projectStatePath: string;
  analysisArchivePath: string;
  discussionMappingsPath: string;
  analysisQueuePath?: string;
}

export interface LegacyImportResult {
  projectsUpserted: number;
  reportsImported: number;
  deliveryRecordsImported: number;
  discussionMappingsImported: number;
  analysisJobsImported: number;
  /** 历史数据缺失或跳过的如实记录；页面据此显示“历史数据缺失”。 */
  warnings: string[];
}

interface LegacyProjectStateRecord {
  star?: unknown;
  pushCount?: unknown;
  firstChannelMessage?: { chatId?: unknown; messageId?: unknown } | null;
  updatedAt?: unknown;
}

interface LegacyProjectStateFile {
  version?: unknown;
  projects?: Record<string, LegacyProjectStateRecord>;
}

interface LegacyArchiveRecord {
  recordType?: unknown;
  projectKey?: unknown;
  title?: unknown;
  link?: unknown;
  count?: unknown;
  star?: unknown;
  analysisText?: unknown;
  analysisCreatedAt?: unknown;
  archivedAt?: unknown;
  mainPushedAt?: unknown;
  sourceTaskKey?: unknown;
  channelMessage?: { chatId?: unknown; messageId?: unknown } | null;
  discussionAnalysisMessage?: { chatId?: unknown; messageId?: unknown } | null;
  reminderMessage?: { chatId?: unknown; messageId?: unknown } | null;
}

interface LegacyDiscussionMapping {
  discussionChatId?: unknown;
  discussionMessageId?: unknown;
  channelChatId?: unknown;
  channelMessageId?: unknown;
}

interface LegacyAnalysisTask {
  taskKey?: unknown;
  projectKey?: unknown;
  kind?: unknown;
  title?: unknown;
  link?: unknown;
  count?: unknown;
  star?: unknown;
  retryCount?: unknown;
  createdAt?: unknown;
  lastError?: unknown;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function asIsoTimestamp(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** 投递消息去重键：同一条消息只登记一次。 */
function messageKey(purpose: string, chatId: string, messageId: number, reportId: string): string {
  return [purpose, chatId, String(messageId), reportId].join('|');
}

/** 确定性历史 ID：同一份历史数据重复导入产生同一主键。 */
function historicalId(prefix: string, ...parts: Array<string | null>): string {
  const digest = createHash('sha256').update(parts.map((part) => part ?? '').join('\u0000')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

function projectKeyOf(record: { projectKey?: unknown; link?: unknown }): string | null {
  return asString(record.projectKey) ?? normalizeProjectKeyFromLink(asString(record.link));
}

async function readJsonLines<T>(path: string, log: (message: string) => void): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }

  const records: T[] = [];
  const lines = raw.split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch (error) {
      log(`跳过无法解析的第 ${index + 1} 行：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return records;
}

async function readJsonFile<T>(path: string, log: (message: string) => void): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    log(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 执行导入。调用方需保证数据库可用；任何事实缺失都保持 NULL，不猜测。
 */
export async function importLegacyFacts(
  pool: StoragePool,
  paths: LegacyImportPaths,
  options: { log?: (message: string) => void } = {}
): Promise<LegacyImportResult> {
  const log = options.log ?? (() => undefined);
  const warnings: string[] = [];
  const result: LegacyImportResult = {
    projectsUpserted: 0,
    reportsImported: 0,
    deliveryRecordsImported: 0,
    discussionMappingsImported: 0,
    analysisJobsImported: 0,
    warnings,
  };

  const state = await readJsonFile<LegacyProjectStateFile>(paths.projectStatePath, log);
  const archive = await readJsonLines<LegacyArchiveRecord>(paths.analysisArchivePath, log);
  const mappings = await readJsonLines<LegacyDiscussionMapping>(paths.discussionMappingsPath, log);
  const tasks = paths.analysisQueuePath ? await readJsonLines<LegacyAnalysisTask>(paths.analysisQueuePath, log) : [];

  // 归档与任务的 link 可用于补全项目链接；project-state 不含链接与展示名。
  const linkByProjectKey = new Map<string, string>();
  const titleByProjectKey = new Map<string, string>();
  for (const record of [...archive, ...tasks]) {
    const projectKey = asString(record.projectKey) ?? normalizeProjectKeyFromLink(asString(record.link));
    if (!projectKey) continue;
    const link = asString(record.link);
    const title = asString(record.title);
    if (link && !linkByProjectKey.has(projectKey)) linkByProjectKey.set(projectKey, link);
    if (title && !titleByProjectKey.has(projectKey)) titleByProjectKey.set(projectKey, title);
  }

  await pool.transaction(async (client) => {
    // 项目键 → 真实 project_id。历史 ID 可能因同日导入顺序与既有业务行冲突，因此写入后回查。
    const projectIdByKey = new Map<string, string>();
    const projectIdsByKey = new Map<string, string>();
    /** 已登记的投递消息，用于避免项目级引用与报告级引用重复。 */
    const recordedMessages = new Set<string>();

    // ---- 项目 ----
    const projects = state?.projects ?? {};
    for (const [projectKey, record] of Object.entries(projects)) {
      const star = asNumber(record?.star) ?? 0;
      const pushCount = asNumber(record?.pushCount) ?? 0;
      const firstChannelMessage = record?.firstChannelMessage ?? null;
      await client.query(
        `INSERT INTO projects (project_id, project_key, display_name, link, source, pool_state, star,
                               display_push_count, first_event_at, last_event_at, entered_pool_at)
         VALUES ($1, $2, $3, $4, 'history_import', 'monitored', $5, $6, NULL, NULL, now())
         ON CONFLICT (project_id) DO NOTHING`,
        [
          historicalId('proj', projectKey),
          projectKey,
          titleByProjectKey.get(projectKey) ?? null,
          linkByProjectKey.get(projectKey) ?? null,
          star,
          pushCount,
        ]
      );

      const identifier = linkByProjectKey.get(projectKey) ?? null;
      // 链接、展示名与账号标识分开保存：handle 始终登记，link 有则登记。
      await client.query(
        `INSERT INTO project_identifiers (project_id, kind, normalized_value, raw_value)
         VALUES ($1, 'handle', $2, $2)
         ON CONFLICT DO NOTHING`,
        [historicalId('proj', projectKey), projectKey]
      );
      if (identifier) {
        await client.query(
          `INSERT INTO project_identifiers (project_id, kind, normalized_value, raw_value)
           VALUES ($1, 'link', $2, $3)
           ON CONFLICT DO NOTHING`,
          [historicalId('proj', projectKey), identifier.toLowerCase(), identifier]
        );
      }

      // 非历史的业务行（服务运行后新建的项目）若占用了同一 project_key，历史 ID 可能被跳过；
      // 此时后续外键必须指向既有行，因此统一回查一次真实 project_id，而不是假定历史 ID 一定存在。
      const resolved = await client.query('SELECT project_id FROM projects WHERE project_key = $1', [projectKey]);
      const projectId = resolved.rows[0]?.project_id;
      if (typeof projectId !== 'string') {
        throw new Error(`历史导入失败：项目 ${projectKey} 写入后未找到记录`);
      }
      projectIdByKey.set(projectKey, projectId);
      projectIdsByKey.set(projectKey, projectId);
      result.projectsUpserted += 1;
    }

    // ---- 报告 ----
    for (const record of archive) {
      if (asString(record.recordType) !== 'analysis') continue;
      const projectKey = asString(record.projectKey) ?? normalizeProjectKeyFromLink(asString(record.link));
      const body = asString(record.analysisText);
      if (!projectKey || !body) continue;

      const generatedAt = asIsoTimestamp(record.analysisCreatedAt) ?? asIsoTimestamp(record.archivedAt);
      // 生成时间必须来自既有记录；缺失时保持 NULL 并如实标记，不编造。
      if (!generatedAt) {
        log(`项目 ${projectKey} 的归档缺少可解析的生成时间，生成的报告将标记为时间缺失`);
      }

      const projectId = projectIdByKey.get(projectKey) ?? historicalId('proj', projectKey);
      const reportId = historicalId('rep', projectKey, asString(record.sourceTaskKey), asString(record.archivedAt));
      await client.query(
        `INSERT INTO reports (report_id, project_id, kind, body, generated_at, triggered_by, report_generated_at_missing)
         VALUES ($1, $2, 'standard', $3, COALESCE($4::timestamptz, now()), 'natural', $5)
         ON CONFLICT DO NOTHING`,
        [reportId, projectId, body, generatedAt, generatedAt === null]
      );
      result.reportsImported += 1;

      const channelMessage = record.channelMessage ?? null;
      if (channelMessage) {
        const chatId = asString(channelMessage.chatId);
        const messageId = asNumber(channelMessage.messageId);
        if (chatId && messageId !== null) {
          recordedMessages.add(messageKey('channel_main', chatId, messageId, ''));
          await client.query(
            `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, shard_index,
                                           message_id, sent_at, attempts)
             VALUES ($1, $2, $3, 'channel_main', $4, 0, $5, NULL, 1)
             ON CONFLICT DO NOTHING`,
            [historicalId('dlv', projectKey, chatId, String(messageId)), projectId, reportId, chatId, messageId]
          );
        }
      }

      const discussionMessage = record.discussionAnalysisMessage ?? null;
      if (discussionMessage) {
        const chatId = asString(discussionMessage.chatId);
        const messageId = asNumber(discussionMessage.messageId);
        if (chatId && messageId !== null) {
          recordedMessages.add(messageKey('discussion_report', chatId, messageId, reportId));
          await client.query(
            `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, shard_index,
                                           message_id, sent_at, attempts)
             VALUES ($1, $2, $3, 'discussion_report', $4, 0, $5, NULL, 1)
             ON CONFLICT DO NOTHING`,
            [historicalId('dlv', projectKey, chatId, String(messageId)), projectId, reportId, chatId, messageId]
          );
        }
      }
    }

    // ---- 项目级频道消息引用 ----
    // 归档里已经出现的消息不再重复登记；只有“有首条频道消息但没有归档报告”的项目才单独记一条，
    // 报告关联留空（历史事实里确实没有对应报告）。
    for (const [projectKey, record] of Object.entries(state?.projects ?? {})) {
      const projectId = projectIdsByKey.get(projectKey);
      const firstChannelMessage = record?.firstChannelMessage ?? null;
      const chatId = asString(firstChannelMessage?.chatId);
      const messageId = asNumber(firstChannelMessage?.messageId);
      if (!projectId) continue;
      if (!chatId || messageId === null) {
        warnings.push(`项目 ${projectKey} 缺少首条频道消息引用，页面只能显示“历史数据缺失”`);
        continue;
      }
      if (recordedMessages.has(messageKey('channel_main', chatId, messageId, ''))) continue;
      await client.query(
        `INSERT INTO delivery_records (delivery_id, project_id, purpose, target_chat_id, shard_index,
                                       message_id, sent_at, attempts)
         VALUES ($1, $2, 'channel_main', $3, 0, $4, NULL, 1)
         ON CONFLICT DO NOTHING`,
        [historicalId('dlv', projectKey, chatId, String(messageId)), projectId, chatId, messageId]
      );
    }

    // ---- 讨论映射 ----
    for (const mapping of mappings) {
      const discussionChatId = asString(mapping.discussionChatId);
      const discussionMessageId = asNumber(mapping.discussionMessageId);
      const channelChatId = asString(mapping.channelChatId);
      const channelMessageId = asNumber(mapping.channelMessageId);
      if (!discussionChatId || discussionMessageId === null || !channelChatId || channelMessageId === null) continue;
      await client.query(
        `INSERT INTO discussion_mappings (mapping_id, channel_chat_id, channel_message_id, discussion_chat_id, discussion_message_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          historicalId('map', channelChatId, String(channelMessageId)),
          channelChatId,
          channelMessageId,
          discussionChatId,
          discussionMessageId,
        ]
      );
      result.discussionMappingsImported += 1;
    }

    // ---- 未完成任务（队列文件；保留原任务 ID 语义，不触发任何执行） ----
    for (const task of tasks) {
      const taskKey = asString(task.taskKey);
      if (!taskKey) continue;
      const projectKey = projectKeyOf(task);
      const kind = asString(task.kind) === 'deep' ? 'deep' : 'standard';
      const projectId = projectKey ? projectIdByKey.get(projectKey) ?? null : null;
      await client.query(
        `INSERT INTO jobs (job_id, kind, project_id, stage, attempts, triggered_by, last_error, created_at)
         VALUES ($1, $2, $3, 'queued', $4, 'natural', $5, COALESCE($6::timestamptz, now()))
         ON CONFLICT DO NOTHING`,
        [
          historicalId('job', taskKey),
          kind,
          projectId,
          Math.max(0, asNumber(task.retryCount) ?? 0),
          asString(task.lastError),
          asIsoTimestamp(task.createdAt),
        ]
      );
      result.analysisJobsImported += 1;
    }
  });

  // 计数以数据库实际行数为准，避免把被唯一约束跳过的尝试算成导入成功。
  const counts = await pool.query(
    `SELECT (SELECT count(*)::int FROM delivery_records) AS deliveries,
            (SELECT count(*)::int FROM reports) AS reports`
  );
  result.deliveryRecordsImported = Number(counts.rows[0]?.deliveries ?? 0);
  result.reportsImported = Number(counts.rows[0]?.reports ?? 0);

  for (const warning of warnings) log(`历史导入提醒：${warning}`);
  log(
    `历史导入完成：项目 ${result.projectsUpserted}、报告 ${result.reportsImported}、` +
      `投递引用 ${result.deliveryRecordsImported}、讨论映射 ${result.discussionMappingsImported}、任务 ${result.analysisJobsImported}`
  );
  return result;
}

/** 从归档链接提取项目键（与旧实现 buildProjectKey 的 handle 规则一致）。 */
export function normalizeProjectKeyFromLink(link: string | null): string | null {
  if (!link) return null;
  const matched = link.match(/^https:\/\/(?:x|twitter)\.com\/([^/?#]+)/i);
  if (matched?.[1]) return matched[1].toLowerCase();
  return link.trim().toLowerCase() || null;
}
