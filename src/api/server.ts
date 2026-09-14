import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { StoragePool } from '../storage/client.js';
import {
  assertWriteAccess,
  changeAdminPassword,
  countActiveSessions,
  elevateSession,
  loginWithSecret,
  resetAdminPasswordWithRecovery,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  syncCredentials,
  validateAuthConfig,
  type AuthConfig,
  type SessionLookup,
} from '../storage/auth.js';
import {
  listDecisionTimeline,
  listProjects,
  readHealthSnapshot,
  readProjectDetail,
  type ProjectListRow,
} from '../storage/query-repository.js';
import { listConfigVersions, readCurrentConfigVersion } from '../storage/config-repository.js';
import { listTweetFeed, readTweetFeedFreshness } from '../storage/tweet-repository.js';
import { listAuditRecords } from '../storage/audit-repository.js';
import { pollTweetMentions, resolveTweetSource } from '../tweets/poller.js';
import type { TweetSourceAdapter } from '../tweets/adapter.js';
import { excludeProject, listExcludedProjects, restoreProject } from '../storage/pool-actions.js';
import { previewDelivery, replayDelivery } from '../storage/delivery-replay.js';
import { readDeliveryBacklog } from '../storage/delivery-repository.js';
import { readJobQueueMetrics } from '../storage/job-queue.js';
import {
  InMemoryRateLimiter,
  SESSION_COOKIE_NAME,
  checkWriteOrigin,
  clientKeyOf,
  sessionCookieOptions,
} from './security.js';

/**
 * HTTP 服务：只读查询 + 受管理员门禁保护的写操作（M3）。
 *
 * 依据：
 * - Q84：写路由必须通过管理员密码建立的会话，只读会话返回 403；
 * - Q54：写接口做来源校验、登录与改密做速率限制、敏感操作二次确认由前端承担；
 * - Q82：会话走长期 HttpOnly Cookie；
 * - Q50/Q75：审计不记录操作者身份，因此 HTTP 层不把 IP/UA 写进审计；
 * - Q8：列表接口走游标分页，返回稳定排序与实体版本号；
 * - F11：数据服务异常时返回 5xx，绝不返回空列表冒充“没有数据”。
 *
 * 本模块不启动监听：由 src/api/main.ts 负责；测试用 app.inject() 直接打请求。
 */

export interface ApiServerOptions {
  pool: StoragePool;
  authConfig: AuthConfig;
  /** 会话 Cookie 是否要求 HTTPS；本地开发设为 false。 */
  cookieSecure?: boolean;
  /** 管理写操作是否要求二次确认标记（Q54、Q74）。 */
  requireSecondConfirmation?: boolean;
  /** 前端静态资源目录；未提供时不做静态托管。 */
  webRoot?: string | null;
  logger?: boolean;
  now?: () => Date;
  /** 推文数据源适配器（Q108）；未提供时按环境变量解析，未配置则明确失败。 */
  tweetSource?: TweetSourceAdapter;
}

export interface ApiContext {
  pool: StoragePool;
  authConfig: AuthConfig;
  cookieSecure: boolean;
  requireSecondConfirmation: boolean;
  webRoot: string | null;
  limiter: InMemoryRateLimiter;
  now: () => Date;
  tweetSource: TweetSourceAdapter;
}

const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const LOGIN_RULE = { max: 10, windowMs: 5 * 60_000 };
const PASSWORD_CHANGE_RULE = { max: 5, windowMs: 15 * 60_000 };
const WRITE_RULE = { max: 60, windowMs: 60_000 };

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ error: { code, message } });
}

async function readSession(context: ApiContext, request: FastifyRequest): Promise<SessionLookup | null> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  return resolveSession(context.pool, { token, now: context.now() });
}

/** 写路由的统一门禁：来源校验 → 速率限制 → 管理员会话 → 可选二次确认。 */
async function requireAdmin(
  context: ApiContext,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { requireConfirmation?: boolean } = {}
): Promise<{ session: SessionLookup; token: string } | null> {
  const origin = checkWriteOrigin({
    method: request.method,
    origin: request.headers.origin,
    host: request.headers.host,
    contentType: request.headers['content-type'],
  });
  if (!origin.allowed) {
    sendError(reply, 403, 'origin_rejected', `写请求来源校验失败：${origin.reason}`);
    return null;
  }

  const key = clientKeyOf({ forwardedFor: request.headers['x-forwarded-for'] as string | undefined, remoteAddress: request.ip });
  const decision = context.limiter.check(`write:${key}`, WRITE_RULE);
  if (!decision.allowed) {
    reply.header('retry-after', Math.ceil(decision.retryAfterMs / 1000));
    sendError(reply, 429, 'rate_limited', '操作过于频繁，请稍后再试');
    return null;
  }

  const token = request.cookies[SESSION_COOKIE_NAME];
  const session = token ? await resolveSession(context.pool, { token, now: context.now() }) : null;
  const access = assertWriteAccess(session);
  if (!access.allowed) {
    sendError(reply, access.status ?? 403, access.status === 401 ? 'unauthenticated' : 'forbidden', '需要管理员权限');
    return null;
  }

  // 二次确认只针对会改变状态或产生外部副作用的写操作；只读的预览不要求。
  if (context.requireSecondConfirmation && options.requireConfirmation !== false) {
    const confirmed = request.headers['x-confirm'] === 'yes' || (request.body as { confirm?: unknown } | undefined)?.confirm === true;
    if (!confirmed) {
      sendError(reply, 428, 'confirmation_required', '该操作需要二次确认');
      return null;
    }
  }

  return { session: session!, token: token! };
}

export async function buildApiServer(options: ApiServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: true });
  await app.register(cookie);

  const context: ApiContext = {
    pool: options.pool,
    authConfig: options.authConfig,
    cookieSecure: options.cookieSecure ?? false,
    requireSecondConfirmation: options.requireSecondConfirmation ?? false,
    webRoot: options.webRoot ? resolve(options.webRoot) : null,
    limiter: new InMemoryRateLimiter(() => (options.now?.() ?? new Date()).getTime()),
    now: options.now ?? (() => new Date()),
    tweetSource: options.tweetSource ?? resolveTweetSource(process.env),
  };
  app.decorate('apiContext', context);

  // 启动即校验凭据（Q86），并同步哈希。
  const validation = validateAuthConfig(context.authConfig);
  if (!validation.ok) {
    throw new Error(`访问凭据配置无效：${validation.errors.join('；')}`);
  }
  // 数据库暂时不可用时不应让进程起不来：登录请求会再次同步，健康接口则如实暴露异常（F11）。
  try {
    await syncCredentials(context.pool, context.authConfig);
  } catch (error) {
    app.log.error(`启动时同步访问凭据失败（服务继续启动，登录时会重试）：${error instanceof Error ? error.message : String(error)}`);
  }

  // 未预期错误统一转成 5xx，避免把数据库异常伪装成空数据（F11）。
  app.setErrorHandler((error: unknown, request, reply) => {
    request.log.error(error);
    const message = error instanceof Error ? error.message : String(error);
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : NaN;
    const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 500;
    sendError(reply, status, status >= 500 ? 'internal_error' : 'bad_request', status >= 500 ? '服务内部错误' : message);
  });

  // ---------- 认证 ----------
  app.post('/api/auth/login', async (request, reply) => {
    const key = clientKeyOf({
      forwardedFor: request.headers['x-forwarded-for'] as string | undefined,
      remoteAddress: request.ip,
    });
    const decision = context.limiter.check(`login:${key}`, LOGIN_RULE);
    if (!decision.allowed) {
      reply.header('retry-after', Math.ceil(decision.retryAfterMs / 1000));
      return sendError(reply, 429, 'rate_limited', '登录尝试过于频繁，请稍后再试');
    }

    const body = (request.body ?? {}) as { secret?: unknown };
    const secret = typeof body.secret === 'string' ? body.secret : '';
    if (secret.length === 0) return sendError(reply, 400, 'missing_secret', '缺少访问密钥');

    // 凭据在启动时可能因数据库不可用而未同步，这里补一次（幂等）。
    await syncCredentials(context.pool, context.authConfig);
    const result = await loginWithSecret(context.pool, {
      secret,
      userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
      now: context.now(),
    });
    if (!result.ok || !result.token) {
      return sendError(reply, 401, 'invalid_credential', '访问密钥或管理员密码不正确');
    }

    reply.setCookie(
      SESSION_COOKIE_NAME,
      result.token,
      sessionCookieOptions({ secure: context.cookieSecure, maxAgeMs: SESSION_TTL_MS })
    );
    return reply.send({ role: result.role, expiresAt: result.expiresAt });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) await revokeSession(context.pool, token, context.now());
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.send({ ok: true });
  });

  /** 当前会话与写权限：前端据此决定是否渲染管理入口（Q106）。 */
  app.get('/api/auth/session', async (request, reply) => {
    const session = await readSession(context, request);
    if (!session) return reply.status(401).send({ authenticated: false });
    return reply.send({
      authenticated: true,
      role: session.role,
      canWrite: session.role === 'admin',
      expiresAt: session.expiresAt,
    });
  });

  app.post('/api/auth/password', async (request, reply) => {
    const key = clientKeyOf({
      forwardedFor: request.headers['x-forwarded-for'] as string | undefined,
      remoteAddress: request.ip,
    });
    const decision = context.limiter.check(`password:${key}`, PASSWORD_CHANGE_RULE);
    if (!decision.allowed) {
      reply.header('retry-after', Math.ceil(decision.retryAfterMs / 1000));
      return sendError(reply, 429, 'rate_limited', '操作过于频繁，请稍后再试');
    }

    const guard = await requireAdmin(context, request, reply);
    if (!guard) return reply;

    const body = (request.body ?? {}) as { newPassword?: unknown };
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const result = await changeAdminPassword(context.pool, {
      newPassword,
      keepToken: guard.token,
      now: context.now(),
    });
    if (!result.updated) {
      return sendError(reply, 400, 'weak_password', '新密码至少 12 个字符');
    }
    return reply.send({ ok: true, invalidatedSessions: result.invalidatedSessions });
  });

  app.post('/api/auth/recover', async (request, reply) => {
    const key = clientKeyOf({
      forwardedFor: request.headers['x-forwarded-for'] as string | undefined,
      remoteAddress: request.ip,
    });
    const decision = context.limiter.check(`recover:${key}`, PASSWORD_CHANGE_RULE);
    if (!decision.allowed) {
      reply.header('retry-after', Math.ceil(decision.retryAfterMs / 1000));
      return sendError(reply, 429, 'rate_limited', '操作过于频繁，请稍后再试');
    }

    const body = (request.body ?? {}) as { recoverySecret?: unknown; newPassword?: unknown };
    const result = await resetAdminPasswordWithRecovery(context.pool, {
      recoverySecret: typeof body.recoverySecret === 'string' ? body.recoverySecret : '',
      newPassword: typeof body.newPassword === 'string' ? body.newPassword : '',
      configuredRecoveryPassword: context.authConfig.recoveryPassword ?? null,
      now: context.now(),
    });
    if (!result.updated) {
      const status = result.error === 'not_configured' ? 501 : 400;
      return sendError(reply, status, result.error ?? 'recover_failed', '恢复密码重置失败');
    }
    return reply.send({ ok: true, invalidatedSessions: result.invalidatedSessions });
  });

  // ---------- 只读查询 ----------
  app.get('/api/health', async (_request, reply) => {
    // 查询失败会抛错并被统一转成 5xx：不允许把数据库异常显示成“一切正常”。
    const [health, jobs, deliveries, sessions] = await Promise.all([
      readHealthSnapshot(context.pool, context.now()),
      readJobQueueMetrics(context.pool, context.now()),
      readDeliveryBacklog(context.pool),
      countActiveSessions(context.pool, context.now()),
    ]);
    return reply.send({ ...health, queue: jobs, deliveryBacklog: deliveries, sessions });
  });

  /** 配置版本时间线：显示生效时间与相对上一版变化的字段（Q102）。 */
  app.get('/api/config/versions', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit ? Math.min(Number(query.limit) || 50, 200) : 50;
    const [versions, current] = await Promise.all([
      listConfigVersions(context.pool, limit),
      readCurrentConfigVersion(context.pool),
    ]);
    return reply.send({ versions, currentVersionId: current?.configVersionId ?? null });
  });

  app.get('/api/projects', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const result = await listProjects(context.pool, {
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor ?? null,
      search: query.search ?? null,
      stars: query.stars ? query.stars.split(',').map((value) => Number(value.trim())).filter(Number.isFinite) : undefined,
      poolState: query.state === 'monitored' || query.state === 'excluded' ? query.state : null,
      source:
        query.source === 'natural' || query.source === 'restored' || query.source === 'history_import'
          ? query.source
          : null,
      hasContractAddress: query.hasCa === 'true' ? true : query.hasCa === 'false' ? false : null,
      joinedAfter: query.joinedAfter ?? null,
    });
    return reply.send(result);
  });

  /** 项目详情：报告、投递、消息链接与时间线一次取齐（M4 详情页）。 */
  app.get('/api/projects/:projectId', async (request, reply) => {
    const params = request.params as { projectId: string };
    const detail = await readProjectDetail(context.pool, { projectId: params.projectId });
    // 项目不存在返回 404，而不是返回空结构冒充存在（第 6 节状态表）。
    if (!detail) return sendError(reply, 404, 'not_found', '项目不存在');
    return reply.send(detail);
  });

  app.get('/api/decisions', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const result = await listDecisionTimeline(context.pool, {
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor ?? null,
      projectId: query.projectId ?? null,
      reasonCodes: query.reasons ? query.reasons.split(',').map((value) => value.trim()).filter(Boolean) : undefined,
      since: query.since ?? null,
    });
    return reply.send(result);
  });

  /**
   * 判定排查（Q100）：以“按账号查”为主入口。
   *
   * 返回该账号的项目事实 + 完整判定链，页面据此回答“为什么推/为什么没推”。
   * 查不到项目时返回 found=false 而不是 404：账搜不到本身就是有价值的排查结论。
   */
  app.get('/api/diagnose', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const raw = (query.account ?? '').trim();
    if (raw.length === 0) return sendError(reply, 400, 'missing_account', '请输入账号或链接');

    // 与旧实现一致：优先按 X handle 归一化，其次整条链接小写。
    const normalized = normalizeAccountKey(raw);
    const projects = await listProjects(context.pool, { search: normalized, limit: 5 });
    const project = projects.rows.find((row) => row.projectKey === normalized) ?? projects.rows[0] ?? null;
    if (!project) {
      return reply.send({ found: false, query: raw, normalizedKey: normalized, timeline: [] });
    }

    const timeline = await listDecisionTimeline(context.pool, { projectId: project.projectId, limit: 100 });
    return reply.send({
      found: true,
      query: raw,
      normalizedKey: project.projectKey,
      project,
      timeline: timeline.rows,
    });
  });

  /**
   * 推特喊单（Q112、Q113、Q116）。
   *
   * 只读接口，页面读库展示：
   * - rows 为空表示“当前没有检测到提及”，页面不显示该栏内容（Q113）；
   * - freshness 暴露每个账号的最后成功检索时间与失败账号数，
   *   让“没检索到”与“检索失败/配额耗尽”可区分，而不是都显示成空。
   */
  app.get('/api/tweets', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const [rows, freshness] = await Promise.all([
      listTweetFeed(context.pool, {
        projectId: query.projectId ?? null,
        limit: query.limit ? Number(query.limit) : 50,
      }),
      readTweetFeedFreshness(context.pool),
    ]);
    return reply.send({ rows, freshness });
  });

  app.get('/api/excluded', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const rows = await listExcludedProjects(context.pool, query.limit ? Number(query.limit) : 100);
    return reply.send({ rows });
  });

  /** 生效配置：只返回白名单里的非敏感项（第 7 节）。 */
  app.get('/api/config/effective', async (_request, reply) => {
    return reply.send({
      accessModel: {
        visitorRequiresAccessKey: true,
        writeRequiresAdminPassword: true,
        keyRotationSupported: false,
        auditRecordsIdentity: false,
      },
      jobDefaults: {
        leaseMs: 30_000,
        heartbeatMs: 10_000,
        deliveryMaxAttempts: 20,
      },
      sampledAt: context.now().toISOString(),
    });
  });

  // ---------- 写操作（管理员门禁） ----------
  app.post('/api/projects/:projectId/exclude', async (request, reply) => {
    const guard = await requireAdmin(context, request, reply);
    if (!guard) return reply;

    const params = request.params as { projectId: string };
    const body = (request.body ?? {}) as { reason?: unknown; note?: unknown };
    const reason = body.reason === 'classification' ? 'classification' : 'manual';
    const result = await excludeProject(context.pool, {
      projectId: params.projectId,
      reason,
      note: typeof body.note === 'string' ? body.note : null,
      now: context.now(),
    });
    return reply.send(result);
  });

  app.post('/api/projects/:projectId/restore', async (request, reply) => {
    const guard = await requireAdmin(context, request, reply);
    if (!guard) return reply;

    const params = request.params as { projectId: string };
    const body = (request.body ?? {}) as { reason?: unknown };
    try {
      const result = await restoreProject(context.pool, {
        projectId: params.projectId,
        reason: typeof body.reason === 'string' ? body.reason : null,
        now: context.now(),
      });
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('必须填写恢复理由')) {
        return sendError(reply, 400, 'reason_required', '人工排除的项目必须填写恢复理由');
      }
      throw error;
    }
  });

  app.get('/api/deliveries/:deliveryId/preview', async (request, reply) => {
    // 预览是只读操作：仍要求管理员权限，但不要求二次确认。
    const guard = await requireAdmin(context, request, reply, { requireConfirmation: false });
    if (!guard) return reply;
    const params = request.params as { deliveryId: string };
    const preview = await previewDelivery(context.pool, { deliveryId: params.deliveryId, now: context.now() });
    if (!preview) return sendError(reply, 404, 'not_found', '投递记录不存在');
    return reply.send(preview);
  });

  app.post('/api/deliveries/:deliveryId/replay', async (request, reply) => {
    const guard = await requireAdmin(context, request, reply);
    if (!guard) return reply;
    const params = request.params as { deliveryId: string };
    const body = (request.body ?? {}) as { reason?: unknown };
    const result = await replayDelivery(context.pool, {
      deliveryId: params.deliveryId,
      reason: typeof body.reason === 'string' ? body.reason : '',
      now: context.now(),
    });
    if (!result.applied) {
      const status = result.rejection === 'not_found' ? 404 : result.rejection === 'reason_required' ? 400 : 409;
      return sendError(reply, status, result.rejection ?? 'replay_failed', '重放未执行');
    }
    return reply.send(result);
  });

  /**
   * 提权：把当前只读会话升级为管理员（Q106 顶部管理入口）。
   * 只改角色、不新建会话；仍必须校验管理员密码本身。
   */
  app.post('/api/auth/elevate', async (request, reply) => {
    const origin = checkWriteOrigin({
      method: request.method,
      origin: request.headers.origin,
      host: request.headers.host,
      contentType: request.headers['content-type'],
    });
    if (!origin.allowed) {
      return sendError(reply, 403, 'origin_rejected', `写请求来源校验失败：${origin.reason}`);
    }
    const key = clientKeyOf({
      forwardedFor: request.headers['x-forwarded-for'] as string | undefined,
      remoteAddress: request.ip,
    });
    const decision = context.limiter.check(`elevate:${key}`, LOGIN_RULE);
    if (!decision.allowed) {
      reply.header('retry-after', Math.ceil(decision.retryAfterMs / 1000));
      return sendError(reply, 429, 'rate_limited', '尝试过于频繁，请稍后再试');
    }

    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token) return sendError(reply, 401, 'unauthenticated', '需要先进入页面');
    const body = (request.body ?? {}) as { adminPassword?: unknown };
    const adminPassword = typeof body.adminPassword === 'string' ? body.adminPassword : '';
    if (adminPassword.length === 0) return sendError(reply, 400, 'missing_password', '请输入管理员密码');

    const result = await elevateSession(context.pool, { token, adminPassword, now: context.now() });
    if (!result.ok) {
      const status = result.rejection === 'invalid_credential' ? 401 : result.rejection === 'session_not_found' ? 401 : 503;
      const code = result.rejection === 'invalid_credential' ? 'invalid_credential' : 'elevate_failed';
      return sendError(reply, status, code, '管理员密码不正确');
    }
    return reply.send({ ok: true, role: result.role });
  });

  /** 审计记录：写操作与导出的可查事实（Q50、Q62；按 Q75 不含身份）。 */
  app.get('/api/audit', async (request, reply) => {
    const guard = await requireAdmin(context, request, reply, { requireConfirmation: false });
    if (!guard) return reply;
    const query = request.query as Record<string, string | undefined>;
    const result = await listAuditRecords(context.pool, {
      limit: query.limit ? Number(query.limit) : 50,
      cursor: query.cursor ?? null,
      action: query.action ?? null,
    });
    return reply.send(result);
  });

  /**
   * 立即检索一次喊单（Q116）。
   * 数据源未配置时明确返回 409 与原因，绝不返回"0 条"冒充"没有提及"（Q113、Q129）。
   */
  app.post('/api/tweets/refresh', async (request, reply) => {
    // 不要求二次确认：它不改变业务状态、不产生外部可见副作用，且按推文 ID 幂等
    // （重复触发只是重复检索，会命中本地去重）。与"投递重放会真的再发一条消息"不同类。
    // 成本风险由 poller 的 handlesPerRequest / maxHandles 上限约束（Q118 未做运行门控）。
    const guard = await requireAdmin(context, request, reply, { requireConfirmation: false });
    if (!guard) return reply;
    const body = (request.body ?? {}) as { projectId?: unknown };
    const adapter = context.tweetSource;
    if (!adapter.isConfigured()) {
      return sendError(
        reply,
        409,
        'tweet_source_unconfigured',
        '尚未配置喊单数据源：请在部署环境选择并配置第三方聚合服务（Q108），当前不会检索，也不代表"没有提及"'
      );
    }
    const result = await pollTweetMentions(context.pool, adapter, {
      ...(typeof body.projectId === 'string' ? { projectIds: [body.projectId] } : {}),
      now: context.now(),
    });
    return reply.send(result);
  });

  app.post('/api/admin/revoke-sessions', async (request, reply) => {
    const guard = await requireAdmin(context, request, reply);
    if (!guard) return reply;
    const revoked = await revokeAllSessions(context.pool, context.now());
    return reply.send({ ok: true, revoked });
  });

  // ---------- 前端静态资源（M4） ----------
  if (context.webRoot) {
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) return sendError(reply, 404, 'not_found', '接口不存在');
      const webRoot = context.webRoot!;
      const requested = normalize(request.url.split('?')[0] ?? '/').replace(/^(\.\.[/\\])+/, '');
      const candidate = resolve(join(webRoot, requested));
      // 防目录穿越：只允许访问 webRoot 内的文件。
      if (!candidate.startsWith(webRoot)) return sendError(reply, 403, 'forbidden', '非法路径');

      try {
        const info = await stat(candidate);
        if (info.isFile()) {
          reply.header('content-type', contentTypeOf(candidate));
          return reply.send(createReadStream(candidate));
        }
      } catch {
        // 落到 index.html，交给前端路由。
      }
      return reply.header('content-type', 'text/html; charset=utf-8').send(createReadStream(join(webRoot, 'index.html')));
    });
  }

  return app;
}

/** 账号归一化：与旧实现 buildProjectKey 的 handle 规则一致（Q31 的关联键基础）。 */
export function normalizeAccountKey(raw: string): string {
  const trimmed = raw.trim();
  const matched = trimmed.match(/^https?:\/\/(?:x|twitter)\.com\/([^/?#]+)/i);
  if (matched?.[1]) return matched[1].toLowerCase();
  return trimmed.replace(/^@/, '').toLowerCase();
}

function contentTypeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    apiContext: ApiContext;
  }
}
