import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import { buildApiServer } from '../src/api/server.js';
import { enqueueDelivery } from '../src/storage/delivery-repository.js';
import { syncCredentials } from '../src/storage/auth.js';

/**
 * HTTP 层（M3）集成测试：需要真实 PostgreSQL；不可用时全部跳过。
 * 用 fastify.inject() 直接打请求，不监听端口。
 *
 * 覆盖：认证与门禁（Q84）、来源校验与速率限制（Q54）、查询接口形状与分页（Q8、Q95）、
 * 管理写操作（排除/恢复/重放）、以及 F11（数据服务异常不伪装成空数据）。
 */

let pool: StoragePool | null = null;
let available = false;
let app: FastifyInstance | null = null;

const ACCESS_KEY = 'visitor-access-key-1234';
const ADMIN_PASSWORD = 'admin-password-5678';
const HOST = '127.0.0.1:3080';
const ORIGIN = `http://${HOST}`;

function itHttp(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available || !app) return;
    await fn();
  });
}

beforeAll(async () => {
  pool = await openTestDatabase();
  available = pool !== null;
  if (!available) return;
  await resetSchemaAndMigrate(pool!);
  app = await buildApiServer({
    pool: pool!,
    authConfig: { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD, recoveryPassword: 'recovery-password-0001' },
    cookieSecure: false,
    requireSecondConfirmation: true
  });
});

beforeEach(async () => {
  if (!available || !app) return;
  await pool!.query(
    'TRUNCATE projects, jobs, reports, delivery_records, decisions, inbound_events, audit_records, sessions, access_credentials RESTART IDENTITY CASCADE'
  );
  await syncCredentials(pool!, {
    accessKey: ACCESS_KEY,
    adminPassword: ADMIN_PASSWORD,
    recoveryPassword: 'recovery-password-0001'
  });
  app.apiContext.limiter.reset();
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.close();
});

/** 登录并返回 Cookie 头。 */
async function login(secret: string): Promise<string> {
  const response = await app!.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
    payload: { secret }
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const cookie = Array.isArray(raw) ? raw[0]! : (raw as string);
  return cookie.split(';')[0]!;
}

/** 管理员写请求：带 Cookie、来源与二次确认。 */
async function adminWrite(
  cookie: string,
  url: string,
  payload: Record<string, unknown> = {}
): Promise<{ statusCode: number; json: () => Record<string, unknown> }> {
  const response = await app!.inject({
    method: 'POST',
    url,
    headers: {
      host: HOST,
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-confirm': 'yes',
      cookie
    },
    payload
  });
  return response;
}

async function seedProject(projectId = 'proj-api', star = 3): Promise<void> {
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, display_name, link, source, pool_state, star, display_pPush_count)
     VALUES ($1, $2, 'Api Project', 'https://x.com/apiproject', 'natural', 'monitored', $3, 1)`.replace(
      'display_pPush_count',
      'display_push_count'
    ),
    [projectId, projectId, star]
  );
}

describe('认证与会话', () => {
  itHttp('访问密钥登录成功并下发 HttpOnly Cookie', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: { secret: ACCESS_KEY }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ role: 'visitor' });
    const raw = response.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw[0]! : (raw as string);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  itHttp('错误口令返回 401，缺少口令返回 400', async () => {
    const wrong = await app!.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: { secret: 'definitely-wrong' }
    });
    expect(wrong.statusCode).toBe(401);
    expect((wrong.json() as { error: { code: string } }).error.code).toBe('invalid_credential');

    const empty = await app!.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: {}
    });
    expect(empty.statusCode).toBe(400);
  });

  itHttp('登录尝试受速率限制（Q54）', async () => {
    let limited = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await app!.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { secret: 'wrong-secret' }
      });
      if (response.statusCode === 429) {
        limited = true;
        expect(response.headers['retry-after']).toBeDefined();
        break;
      }
    }
    expect(limited).toBe(true);
  });

  itHttp('会话接口区分只读与管理员权限', async () => {
    const visitor = await login(ACCESS_KEY);
    const visitorSession = await app!.inject({ method: 'GET', url: '/api/auth/session', headers: { host: HOST, cookie: visitor } });
    expect(visitorSession.json()).toMatchObject({ authenticated: true, role: 'visitor', canWrite: false });

    const admin = await login(ADMIN_PASSWORD);
    const adminSession = await app!.inject({ method: 'GET', url: '/api/auth/session', headers: { host: HOST, cookie: admin } });
    expect(adminSession.json()).toMatchObject({ authenticated: true, role: 'admin', canWrite: true });

    const anonymous = await app!.inject({ method: 'GET', url: '/api/auth/session', headers: { host: HOST } });
    expect(anonymous.statusCode).toBe(401);
  });

  itHttp('登出后会话失效', async () => {
    const cookie = await login(ACCESS_KEY);
    await app!.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: HOST, cookie } });
    const after = await app!.inject({ method: 'GET', url: '/api/auth/session', headers: { host: HOST, cookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe('写操作门禁（Q84、Q54）', () => {
  itHttp('未登录的写请求返回 401', async () => {
    await seedProject();
    const response = await app!.inject({
      method: 'POST',
      url: '/api/projects/proj-api/exclude',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'x-confirm': 'yes' },
      payload: { reason: 'manual' }
    });
    expect(response.statusCode).toBe(401);
  });

  itHttp('只读会话的写请求返回 403（访客无法改数据）', async () => {
    await seedProject();
    const cookie = await login(ACCESS_KEY);
    const response = await adminWrite(cookie, '/api/projects/proj-api/exclude', { reason: 'manual' });
    expect(response.statusCode).toBe(403);
  });

  itHttp('缺少来源头的写请求被拒（CSRF 防线）', async () => {
    const cookie = await login(ADMIN_PASSWORD);
    const response = await app!.inject({
      method: 'POST',
      url: '/api/projects/proj-api/exclude',
      headers: { host: HOST, 'content-type': 'application/json', 'x-confirm': 'yes', cookie },
      payload: { reason: 'manual' }
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('origin_rejected');
  });

  itHttp('跨来源的写请求被拒', async () => {
    const cookie = await login(ADMIN_PASSWORD);
    const response = await app!.inject({
      method: 'POST',
      url: '/api/projects/proj-api/exclude',
      headers: {
        host: HOST,
        origin: 'http://evil.example',
        'content-type': 'application/json',
        'x-confirm': 'yes',
        cookie
      },
      payload: { reason: 'manual' }
    });
    expect(response.statusCode).toBe(403);
  });

  itHttp('启用二次确认时缺少确认标记返回 428', async () => {
    await seedProject();
    const cookie = await login(ADMIN_PASSWORD);
    const response = await app!.inject({
      method: 'POST',
      url: '/api/projects/proj-api/exclude',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', cookie },
      payload: { reason: 'manual' }
    });
    expect(response.statusCode).toBe(428);
    expect((response.json() as { error: { code: string } }).error.code).toBe('confirmation_required');
  });
});

describe('只读查询接口', () => {
  itHttp('项目列表返回游标分页与版本号', async () => {
    for (let index = 0; index < 5; index += 1) {
      await pool!.query(
        `INSERT INTO projects (project_id, project_key, source, pool_state, star, entered_pool_at)
         VALUES ($1, $2, 'natural', 'monitored', $3, now() - ($4 || ' minutes')::interval)`,
        [`proj-${index}`, `account${index}`, index % 3, index]
      );
    }
    const response = await app!.inject({ method: 'GET', url: '/api/projects?limit=2', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      rows: Array<{ version: string; projectId: string }>;
      page: { hasMore: boolean; nextCursor: string };
    };
    expect(body.rows).toHaveLength(2);
    expect(body.page.hasMore).toBe(true);
    expect(body.rows[0]?.version).toBeTruthy();

    const next = await app!.inject({
      method: 'GET',
      url: `/api/projects?limit=2&cursor=${encodeURIComponent(body.page.nextCursor)}`,
      headers: { host: HOST }
    });
    const nextBody = next.json() as { rows: Array<{ projectId: string }> };
    expect(nextBody.rows[0]?.projectId).not.toBe(body.rows[0]?.projectId);
  });

  itHttp('未登录也能读列表（只读密码是进门条件，不是每条请求的条件）', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/projects', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
  });

  itHttp('判定时间线支持原因码过滤', async () => {
    await seedProject();
    await pool!.query(
      `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload, title)
       VALUES ('evt-1', 'c', 1, now(), '{}', 'Title')`
    );
    await pool!.query(
      `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at)
       VALUES ('dec-1', 'evt-1', 'proj-api', 'proj-api', 'BELOW_THRESHOLD', now())`
    );
    const response = await app!.inject({
      method: 'GET',
      url: '/api/decisions?reasons=BELOW_THRESHOLD',
      headers: { host: HOST }
    });
    const body = response.json() as { rows: Array<{ reasonCode: string; title: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ reasonCode: 'BELOW_THRESHOLD', title: 'Title' });
  });

  itHttp('排除列表只返回已排除项目', async () => {
    await seedProject();
    const cookie = await login(ADMIN_PASSWORD);
    await adminWrite(cookie, '/api/projects/proj-api/exclude', { reason: 'manual' });
    const response = await app!.inject({ method: 'GET', url: '/api/excluded', headers: { host: HOST } });
    const body = response.json() as { rows: Array<{ projectId: string; exclusionReason: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ projectId: 'proj-api', exclusionReason: 'manual' });
  });

  itHttp('生效配置只返回白名单项，不含凭据', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/config/effective', headers: { host: HOST } });
    const text = response.body;
    expect(text).not.toContain(ACCESS_KEY);
    expect(text).not.toContain(ADMIN_PASSWORD);
    expect(response.json()).toMatchObject({ accessModel: { writeRequiresAdminPassword: true } });
  });

  itHttp('健康接口汇总业务指标', async () => {
    await seedProject();
    const response = await app!.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ projects: 1 });
    expect(body.queue).toBeDefined();
    expect(body.deliveryBacklog).toBeDefined();
    expect(body.sessions).toBeDefined();
  });
});

describe('管理写操作', () => {
  itHttp('排除 → 恢复：人工排除的恢复必须写理由（Q136）', async () => {
    await seedProject();
    const cookie = await login(ADMIN_PASSWORD);

    const excluded = await adminWrite(cookie, '/api/projects/proj-api/exclude', { reason: 'manual', note: '项目方跑路' });
    expect(excluded.statusCode).toBe(200);
    expect(excluded.json()).toMatchObject({ applied: true, excludedStar: 3 });

    const missingReason = await adminWrite(cookie, '/api/projects/proj-api/restore', {});
    expect(missingReason.statusCode).toBe(400);
    expect((missingReason.json() as { error: { code: string } }).error.code).toBe('reason_required');

    const restored = await adminWrite(cookie, '/api/projects/proj-api/restore', { reason: '项目方已澄清' });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ applied: true, jobCreated: true });
  });

  itHttp('投递预览与重放：必填原因、冷却幂等（Q59）', async () => {
    await seedProject();
    await enqueueDelivery(pool!, {
      projectId: 'proj-api',
      reportId: null,
      purpose: 'channel_main',
      targetChatId: '-100123'
    });
    // 把 updated_at 推到冷却窗口之外：重放冷却按最近一次操作时间计算（Q59）。
    await pool!.query(`UPDATE delivery_records SET updated_at = now() - interval '1 hour', created_at = now() - interval '1 hour'`);
    const delivery = await pool!.query(`SELECT delivery_id FROM delivery_records LIMIT 1`);
    const deliveryId = String(delivery.rows[0]?.delivery_id);

    const cookie = await login(ADMIN_PASSWORD);
    const preview = await app!.inject({
      method: 'GET',
      url: `/api/deliveries/${deliveryId}/preview`,
      headers: { host: HOST, origin: ORIGIN, cookie }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json() as Record<string, unknown>).toMatchObject({ replayable: true, targetChatId: '-100123' });

    const noReason = await adminWrite(cookie, `/api/deliveries/${deliveryId}/replay`, { reason: '  ' });
    expect(noReason.statusCode).toBe(400);

    const replayed = await adminWrite(cookie, `/api/deliveries/${deliveryId}/replay`, { reason: '映射已修复' });
    expect(replayed.statusCode).toBe(200);

    const again = await adminWrite(cookie, `/api/deliveries/${deliveryId}/replay`, { reason: '连点' });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe('cooldown');
  });

  itHttp('不存在的投递返回 404', async () => {
    const cookie = await login(ADMIN_PASSWORD);
    const response = await app!.inject({
      method: 'GET',
      url: '/api/deliveries/not-a-delivery/preview',
      headers: { host: HOST, origin: ORIGIN, cookie }
    });
    expect(response.statusCode).toBe(404);
  });

  itHttp('清除全部会话需要管理员权限（Q79）', async () => {
    const visitor = await login(ACCESS_KEY);
    const denied = await adminWrite(visitor, '/api/admin/revoke-sessions');
    expect(denied.statusCode).toBe(403);

    const admin = await login(ADMIN_PASSWORD);
    const allowed = await adminWrite(admin, '/api/admin/revoke-sessions');
    expect(allowed.statusCode).toBe(200);
    expect(Number((allowed.json() as { revoked: number }).revoked)).toBeGreaterThan(0);
  });

  itHttp('改管理员密码后当前会话保留、其它管理员会话失效（Q73）', async () => {
    const keepCookie = await login(ADMIN_PASSWORD);
    const otherCookie = await login(ADMIN_PASSWORD);

    const changed = await adminWrite(keepCookie, '/api/auth/password', { newPassword: 'brand-new-admin-pass-01' });
    expect(changed.statusCode).toBe(200);
    expect(Number((changed.json() as { invalidatedSessions: number }).invalidatedSessions)).toBe(1);

    const kept = await app!.inject({ method: 'GET', url: '/api/auth/session', headers: { host: HOST, cookie: keepCookie } });
    expect(kept.json()).toMatchObject({ authenticated: true, role: 'admin' });

    const revoked = await app!.inject({ method: 'GET', url: '/api/auth/session', headers: { host: HOST, cookie: otherCookie } });
    expect(revoked.statusCode).toBe(401);
  });
});

describe('项目详情接口（M4）', () => {
  itHttp('不存在的项目返回 404，而不是空结构', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/projects/nope', headers: { host: HOST } });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('not_found');
  });

  itHttp('返回项目、报告、投递、链接与时间线', async () => {
    await seedProject();
    await pool!.query(
      `INSERT INTO reports (report_id, project_id, kind, body, generated_at, triggered_by, model)
       VALUES ('rep-api', 'proj-api', 'standard', '正文内容', now(), 'natural', 'grok-4.3')`
    );
    await pool!.query(
      `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, message_id, sent_at, attempts)
       VALUES ('dlv-api', 'proj-api', 'rep-api', 'discussion_report', '-100777', 321, now(), 1)`
    );
    const response = await app!.inject({ method: 'GET', url: '/api/projects/proj-api', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      project: { projectId: string; displayPushCount: number; confirmedSendCount: number };
      reports: Array<{ model: string }>;
      deliveries: Array<{ purpose: string }>;
      links: { discussion: string | null };
    };
    expect(body.project).toMatchObject({ projectId: 'proj-api', displayPushCount: 1 });
    expect(body.reports[0]).toMatchObject({ model: 'grok-4.3' });
    expect(body.deliveries[0]).toMatchObject({ purpose: 'discussion_report' });
    expect(body.links.discussion).toBe('https://t.me/c/777/321');
  });
});

describe('判定排查与配置时间线（M4）', () => {
  itHttp('按账号查：查不到时返回 found=false，而不是 404', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/diagnose?account=ghostaccount', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ found: false, normalizedKey: 'ghostaccount' });
  });

  itHttp('按账号查：支持 handle 与主页链接两种输入', async () => {
    await seedProject();
    await pool!.query(
      `INSERT INTO decisions (decision_id, event_id, project_key, reason_code, decided_at)
       VALUES ('dec-diag', 'evt-diag', 'proj-api', 'BELOW_THRESHOLD', now())`
    ).catch(async () => {
      await pool!.query(
        `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload)
         VALUES ('evt-diag', 'c', 1, now(), '{}')`
      );
      await pool!.query(
        `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at)
         VALUES ('dec-diag', 'evt-diag', 'proj-api', 'proj-api', 'BELOW_THRESHOLD', now())`
      );
    });

    const byHandle = await app!.inject({ method: 'GET', url: '/api/diagnose?account=@proj-api', headers: { host: HOST } });
    expect(byHandle.json()).toMatchObject({ found: true, normalizedKey: 'proj-api' });

    const byLink = await app!.inject({
      method: 'GET',
      url: '/api/diagnose?account=' + encodeURIComponent('https://x.com/proj-api'),
      headers: { host: HOST }
    });
    expect(byLink.json()).toMatchObject({ found: true, normalizedKey: 'proj-api' });
  });

  itHttp('缺少账号参数返回 400', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/diagnose', headers: { host: HOST } });
    expect(response.statusCode).toBe(400);
  });

  itHttp('配置版本时间线返回当前生效版本', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/config/versions', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { versions: unknown[]; currentVersionId: string | null };
    expect(Array.isArray(body.versions)).toBe(true);
    expect(body).toHaveProperty('currentVersionId');
  });
});

describe('前端静态托管（M4）', () => {
  itHttp('未配置静态托管时接口仍可用', async () => {
    // 主测试服务未配置 webRoot：根路径可以是 404，但接口必须正常。
    expect(app!.apiContext.webRoot).toBeNull();
    const response = await app!.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect([404, 500]).toContain(response.statusCode);
    const api = await app!.inject({ method: 'GET', url: '/api/projects', headers: { host: HOST } });
    expect(api.statusCode).toBe(200);
  });

  itHttp('配置了静态目录时根路径返回前端入口', async () => {
    const distRoot = join(process.cwd(), 'web', 'dist');
    if (!existsSync(join(distRoot, 'index.html'))) return; // 未构建则跳过
    const staticApp = await buildApiServer({
      pool: pool!,
      authConfig: { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD },
      cookieSecure: false,
      webRoot: distRoot
    });
    try {
      const response = await staticApp.inject({ method: 'GET', url: '/', headers: { host: HOST } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('项目监控台');
    } finally {
      await staticApp.close();
    }
  });

  itHttp('目录穿越被拒绝', async () => {
    const built = existsSync(join(process.cwd(), 'web', 'dist', 'index.html'));
    const staticApp = await buildApiServer({
      pool: pool!,
      authConfig: { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD },
      cookieSecure: false,
      webRoot: built ? join(process.cwd(), 'web', 'dist') : join(process.cwd(), 'web')
    });
    try {
      const response = await staticApp.inject({
        method: 'GET',
        url: '/../../package.json',
        headers: { host: HOST }
      });
      // 归一化后要么落回 index.html（不存在则 500），要么被显式拒绝；绝不能读到仓库文件。
      expect(response.body.includes('name: daxinjiankong')).toBe(false);
    } finally {
      await staticApp.close();
    }
  });

  itHttp('未构建前端时接口路径返回 404 而不是 HTML', async () => {
    const fallbackApp = await buildApiServer({
      pool: pool!,
      authConfig: { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD },
      cookieSecure: false,
      webRoot: process.cwd()
    });
    try {
      const response = await fallbackApp.inject({ method: 'GET', url: '/api/does-not-exist', headers: { host: HOST } });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('<html');
    } finally {
      await fallbackApp.close();
    }
  });
});

describe('F11：数据服务异常不伪装成空数据', () => {
  itHttp('数据库不可用时健康接口返回 5xx 而不是全 0', async () => {
    const brokenPool = {
      query: async () => {
        throw new Error('connection terminated unexpectedly');
      },
      transaction: async () => {
        throw new Error('connection terminated unexpectedly');
      },
      close: async () => undefined
    } as unknown as StoragePool;

    const brokenApp = await buildApiServer({
      pool: brokenPool,
      authConfig: { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD },
      cookieSecure: false
    });
    try {
      const response = await brokenApp.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect((response.json() as { error: { code: string } }).error.code).toBe('internal_error');
    } finally {
      await brokenApp.close();
    }
  });

  itHttp('凭据配置无效时拒绝启动（Q86）', async () => {
    await expect(
      buildApiServer({
        pool: pool!,
        authConfig: { accessKey: 'same-value-123456', adminPassword: 'same-value-123456' },
        cookieSecure: false
      })
    ).rejects.toThrow(/访问凭据配置无效/);
  });
});

/**
 * 会话提权（Q106）、审计读取（Q50/Q62）与“立即查一次”喊单（Q116）的 HTTP 行为。
 *
 * 这些用例守的是**门禁与状态码**：提权不能仅凭已登录就通过，
 * 未配置数据源时必须返回 409 说明原因，而不是 200 + 空列表。
 */
describe('提权 / 审计 / 喊单检索', () => {
  async function post(url: string, body: unknown, cookie?: string) {
    return app!.inject({
      method: 'POST',
      url,
      headers: {
        host: HOST,
        origin: ORIGIN,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {})
      },
      payload: body as object
    });
  }

  itHttp('提权：未登录 401，密码错误 401，正确后具备写权限', async () => {
    const visitor = await login(ACCESS_KEY);

    expect((await post('/api/auth/elevate', { adminPassword: ADMIN_PASSWORD })).statusCode).toBe(401);
    expect((await post('/api/auth/elevate', { adminPassword: 'wrong' }, visitor)).statusCode).toBe(401);

    const elevated = await post('/api/auth/elevate', { adminPassword: ADMIN_PASSWORD }, visitor);
    expect(elevated.statusCode).toBe(200);
    expect(elevated.json()).toMatchObject({ ok: true, role: 'admin' });

    // 提权后同一个 Cookie 就能写：用一个真实写操作验证
    await pool!.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state, star)
       VALUES ('elevate-p1', 'elevateone', 'natural', 'monitored', 3)`
    );
    const excluded = await app!.inject({
      method: 'POST',
      url: '/api/projects/elevate-p1/exclude',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', cookie: visitor, 'x-confirm': 'yes' },
      payload: { reason: 'manual' }
    });
    expect(excluded.statusCode).toBe(200);
    expect(excluded.json()).toMatchObject({ applied: true });
  });

  itHttp('提权：缺少密码返回 400', async () => {
    const visitor = await login(ACCESS_KEY);
    const response = await post('/api/auth/elevate', {}, visitor);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'missing_password' } });
  });

  itHttp('审计：访客 403，管理员可读且按写入留痕', async () => {
    const visitor = await login(ACCESS_KEY);
    expect(
      (await app!.inject({ method: 'GET', url: '/api/audit', headers: { host: HOST, cookie: visitor } })).statusCode
    ).toBe(403);

    const admin = await login(ADMIN_PASSWORD);
    await pool!.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state, star)
       VALUES ('audit-p1', 'auditone', 'natural', 'monitored', 3)`
    );
    const excluded = await app!.inject({
      method: 'POST',
      url: '/api/projects/audit-p1/exclude',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', cookie: admin, 'x-confirm': 'yes' },
      payload: { reason: 'manual' }
    });
    expect(excluded.statusCode).toBe(200);

    const audit = await app!.inject({ method: 'GET', url: '/api/audit?limit=10', headers: { host: HOST, cookie: admin } });
    expect(audit.statusCode).toBe(200);
    const body = audit.json() as { rows: Array<{ action: string; targetId: string | null }> };
    expect(body.rows.some((row) => row.action === 'project.exclude' && row.targetId === 'audit-p1')).toBe(true);
    // Q75/Q85：审计不含身份
    expect(Object.keys(body.rows[0]!)).not.toContain('actor');
  });

  itHttp('喊单：访客 403；管理员在未配置数据源时得到 409 与明确原因', async () => {
    const visitor = await login(ACCESS_KEY);
    expect((await post('/api/tweets/refresh', {}, visitor)).statusCode).toBe(403);

    const admin = await login(ADMIN_PASSWORD);
    const response = await post('/api/tweets/refresh', {}, admin);
    // 关键：未配置数据源必须是 409 说明原因，不能是 200 + 空数组（Q113、Q129）
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('tweet_source_unconfigured');
    expect(body.error.message).toContain('未配置');
  });
});

/** 配置了适配器时，“立即查一次”应真正走完整链路。用注入的假适配器验证。 */
describe('喊单检索（已配置数据源）', () => {
  let fakeApp: FastifyInstance | null = null;
  const calls: Array<{ handles: readonly string[] }> = [];

  beforeAll(async () => {
    if (!available || !pool) return;
    fakeApp = await buildApiServer({
      pool,
      authConfig: { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD },
      cookieSecure: false,
      requireSecondConfirmation: true,
      tweetSource: {
        name: 'fake-vendor',
        isConfigured: () => true,
        fetchMentions: async (input) => {
          calls.push({ handles: input.handles });
          return {
            tweets: [
              {
                tweetId: 'http-tweet-1',
                authorHandle: 'shiller',
                authorName: 'Shiller',
                authorVerified: true,
                authorFollowers: 1000,
                body: '强烈看好 @coreone',
                postedAt: '2026-09-14T09:30:00.000Z',
                likeCount: 10,
                retweetCount: 2,
                replyCount: 1,
                viewCount: 100,
                url: null,
                mentions: ['coreone']
              }
            ],
            fetchedAt: new Date('2026-09-14T10:30:00.000Z')
          };
        }
      }
    });
  });

  afterAll(async () => {
    if (fakeApp) await fakeApp.close();
  });

  it('管理员触发检索后入库，并返回统计（Q116）', async () => {
    if (!available || !fakeApp || !pool) return;
    await pool.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state, star)
       VALUES ('tweet-core-1', 'coreone', 'natural', 'monitored', 5) ON CONFLICT DO NOTHING`
    );
    const loginResponse = await fakeApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: { secret: ADMIN_PASSWORD }
    });
    // 上一个 describe 的 beforeEach 清空了凭据表，这里补一次同步
    await syncCredentials(pool, { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD });
    const retry = await fakeApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: { secret: ADMIN_PASSWORD }
    });
    const raw = (retry.statusCode === 200 ? retry : loginResponse).headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0]! : (raw as string)).split(';')[0]!;

    const response = await fakeApp.inject({
      method: 'POST',
      url: '/api/tweets/refresh',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json', cookie, 'x-confirm': 'yes' },
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { created: number; newMentions: string[]; source: string };
    expect(body.source).toBe('fake-vendor');
    expect(body.created).toBe(1);
    expect(body.newMentions).toEqual(['coreone']);
    expect(calls.length).toBeGreaterThan(0);

    // 页面能查到这条喊单（双向可达的基础）
    const feed = await fakeApp.inject({
      method: 'GET',
      url: '/api/tweets?projectId=tweet-core-1',
      headers: { host: HOST, cookie }
    });
    expect(feed.statusCode).toBe(200);
    const feedBody = feed.json() as { rows: Array<{ tweetId: string; body: string; mentions: string[] }> };
    expect(feedBody.rows.map((row) => row.tweetId)).toContain('http-tweet-1');
  });
});
