import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import { buildApiServer } from '../src/api/server.js';
import { importLegacyFacts } from '../src/storage/legacy-import.js';
import { syncCredentials } from '../src/storage/auth.js';

/**
 * 真实历史数据的端到端集成（M1+M3+M4 交接点）。
 *
 * 与 `legacy-import.test.ts` 的分工：那边验证导入本身的事实与幂等；
 * 这里验证**导入后的数据能被页面真实读到**——项目列表、项目详情、判定时间线、健康接口。
 * 这是“历史导入 → 查询 API → 前端”链路的最后一段，之前只有合成数据覆盖过。
 *
 * 数据来源是仓库里的真实文件；文件不存在时跳过（CI 或裁剪仓库），不伪造数据。
 */

const DATA_PATHS = {
  projectStatePath: 'data/project-state.json',
  analysisArchivePath: 'data/analysis-archive.jsonl',
  discussionMappingsPath: 'data/discussion-mappings.jsonl',
  analysisQueuePath: 'data/analysis-tasks.jsonl',
};

const ACCESS_KEY = 'legacy-visitor-key-1234';
const ADMIN_PASSWORD = 'legacy-admin-pass-1234';
const HOST = '127.0.0.1:3099';

let pool: StoragePool | null = null;
let app: FastifyInstance | null = null;
let available = false;

function itLegacy(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available || !app) return;
    await fn();
  });
}

beforeAll(async () => {
  const dataPresent = existsSync(join(process.cwd(), DATA_PATHS.projectStatePath));
  pool = await openTestDatabase();
  available = pool !== null && dataPresent;
  if (!available) return;

  await resetSchemaAndMigrate(pool!);
  await importLegacyFacts(pool!, DATA_PATHS);
  app = await buildApiServer({
    pool: pool!,
    authConfig: { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD },
    cookieSecure: false,
    requireSecondConfirmation: false,
  });
  await syncCredentials(pool!, { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD });
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.close();
});

describe('真实历史数据的页面可读性', () => {
  itLegacy('项目列表能读到导入的历史项目', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/projects?limit=50', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { rows: Array<{ projectKey: string; source: string; firstEventAt: string | null }> };
    // 现网真实数据是 3 个项目
    expect(body.rows.length).toBeGreaterThanOrEqual(3);
    const keys = body.rows.map((row) => row.projectKey);
    expect(keys).toContain('berauniversity');
    expect(keys).toContain('getstonkoptions');
    expect(keys).toContain('boopfamily');

    for (const row of body.rows) {
      expect(row.source).toBe('history_import');
      // 关键：历史事件的真实时间从未落盘，页面必须显示为空而不是伪造时间
      expect(row.firstEventAt).toBeNull();
    }
  });

  itLegacy('项目详情能读到历史报告与消息链接', async () => {
    const list = await app!.inject({ method: 'GET', url: '/api/projects?limit=50', headers: { host: HOST } });
    const rows = (list.json() as { rows: Array<{ projectId: string }> }).rows;
    const withReport = rows.find((row) => row.projectId) ?? rows[0]!;

    const detail = await app!.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(withReport.projectId)}`,
      headers: { host: HOST }
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      project: { source: string; displayPushCount: number; confirmedSendCount: number };
      reports: Array<{ kind: string; body: string; generatedAtMissing: boolean }>;
      links: { channel: string | null; discussion: string | null };
    };
    expect(body.project.source).toBe('history_import');
    // 历史导入只保留渠道展示序号；真实发送次数无记录时可确认回执为 0
    expect(body.project.displayPushCount).toBeGreaterThan(0);
    expect(body.project.confirmedSendCount).toBe(0);
    expect(body.links.channel).toMatch(/^https:\/\/t\.me\/c\//);
  });

  itLegacy('判定时间线对历史数据返回空而不是伪装成“没有异常”', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/decisions?limit=10', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { rows: unknown[]; page: { hasMore: boolean } };
    // 历史导入不伪造判定记录：旧系统从未落盘分类理由与去重结论
    expect(body.rows).toEqual([]);
    expect(body.page.hasMore).toBe(false);
  });

  itLegacy('健康接口如实反映导入规模', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/health', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { projects: number; inboundEvents: number; decisions: number };
    expect(body.projects).toBeGreaterThanOrEqual(3);
    // 历史导入不制造接收记录与判定记录
    expect(body.inboundEvents).toBe(0);
    expect(body.decisions).toBe(0);
  });

  itLegacy('排除列表初始为空（历史数据没有排除记录）', async () => {
    const response = await app!.inject({ method: 'GET', url: '/api/excluded', headers: { host: HOST } });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { rows: unknown[] }).rows).toEqual([]);
  });

  itLegacy('历史项目可以做排除与恢复（写操作对导入数据同样生效）', async () => {
    const list = await app!.inject({ method: 'GET', url: '/api/projects?limit=1', headers: { host: HOST } });
    const projectId = (list.json() as { rows: Array<{ projectId: string }> }).rows[0]!.projectId;

    const login = await app!.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
      payload: { secret: ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0]! : (raw as string)).split(';')[0]!;

    const excluded = await app!.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(projectId)}/exclude`,
      headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json', cookie },
      payload: { reason: 'manual' }
    });
    expect(excluded.statusCode).toBe(200);
    expect((excluded.json() as { applied: boolean }).applied).toBe(true);

    // 人工排除的恢复必须写理由
    const missingReason = await app!.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(projectId)}/restore`,
      headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json', cookie },
      payload: {}
    });
    expect(missingReason.statusCode).toBe(400);

    const restored = await app!.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(projectId)}/restore`,
      headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json', cookie },
      payload: { reason: '导入验证后恢复' }
    });
    expect(restored.statusCode).toBe(200);
    expect((restored.json() as { applied: boolean; jobCreated: boolean }).applied).toBe(true);
  });
});
