import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import { elevateSession, loginWithSecret, syncCredentials } from '../src/storage/auth.js';
import { listAuditRecords } from '../src/storage/audit-repository.js';

/**
 * 会话提权（Q106）与审计读取（Q50、Q62）集成测试：需要真实 PostgreSQL；不可用时跳过。
 *
 * 提权的安全要求：**不能仅凭"已经登录"就拿到写权限**，必须校验管理员密码本身；
 * 审计的要求：可查"发生了什么"，但按 Q75/Q85 **不含身份**。
 */

let pool: StoragePool | null = null;
let available = false;

const ACCESS_KEY = 'visitor-key-for-test-1';
const ADMIN_PASSWORD = 'admin-pass-for-test-1';

function itDb(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available) return;
    await fn();
  });
}

beforeAll(async () => {
  pool = await openTestDatabase();
  available = pool !== null;
  if (available) {
    await resetSchemaAndMigrate(pool!);
    await syncCredentials(pool!, { accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD });
  }
});

beforeEach(async () => {
  if (!available) return;
  await pool!.query('TRUNCATE sessions, audit_records RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  if (pool) await pool.close();
});

async function visitorToken(): Promise<string> {
  const login = await loginWithSecret(pool!, { secret: ACCESS_KEY });
  expect(login.ok).toBe(true);
  return login.token!;
}

async function roleOf(token: string): Promise<string> {
  const result = await pool!.query(`SELECT role FROM sessions WHERE session_id = $1`, [
    (
      await import('node:crypto')
    ).createHash('sha256').update(token).digest('hex')
  ]);
  return String(result.rows[0]?.role ?? '(none)');
}

describe('会话提权（Q106）', () => {
  itDb('访客会话用管理员密码可提权为 admin，且不新建会话', async () => {
    const token = await visitorToken();
    const before = await pool!.query('SELECT count(*)::int AS c FROM sessions');

    const result = await elevateSession(pool!, { token, adminPassword: ADMIN_PASSWORD });
    expect(result).toMatchObject({ ok: true, role: 'admin', rejection: null });

    const after = await pool!.query('SELECT count(*)::int AS c FROM sessions');
    // 仍然只有一个会话：提权只改角色，不产生第二个 Cookie
    expect(after.rows[0]?.c).toBe(before.rows[0]?.c);
  });

  itDb('管理员密码错误时拒绝提权，角色保持不变', async () => {
    const token = await visitorToken();
    const result = await elevateSession(pool!, { token, adminPassword: 'wrong-password' });
    expect(result).toMatchObject({ ok: false, role: null, rejection: 'invalid_credential' });
    expect(await roleOf(token)).toBe('visitor');
  });

  itDb('已撤销的会话不能提权', async () => {
    const token = await visitorToken();
    const { revokeSession } = await import('../src/storage/auth.js');
    await revokeSession(pool!, token);
    const result = await elevateSession(pool!, { token, adminPassword: ADMIN_PASSWORD });
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe('session_not_found');
  });

  itDb('提权后该会话可用于写操作判定', async () => {
    const token = await visitorToken();
    const before = await resolveRole(token);
    expect(before).toBe('visitor');
    await elevateSession(pool!, { token, adminPassword: ADMIN_PASSWORD });
    expect(await resolveRole(token)).toBe('admin');
  });
});

async function resolveRole(token: string): Promise<string | null> {
  const { resolveSession } = await import('../src/storage/auth.js');
  const session = await resolveSession(pool!, { token });
  return session?.role ?? null;
}

describe('审计读取（Q50、Q62、Q75）', () => {
  async function insertAudit(input: {
    auditId: string;
    action: string;
    occurredAt: string;
    targetId?: string | null;
    before?: string | null;
    after?: string | null;
  }): Promise<void> {
    await pool!.query(
      `INSERT INTO audit_records (audit_id, action, target_type, target_id, before_summary, after_summary, occurred_at)
       VALUES ($1, $2, 'project', $3, $4, $5, $6::timestamptz)`,
      [input.auditId, input.action, input.targetId ?? null, input.before ?? null, input.after ?? null, input.occurredAt]
    );
  }

  itDb('按时间倒序返回，并如实给出前后摘要', async () => {
    await insertAudit({
      auditId: 'a1',
      action: 'project.exclude',
      occurredAt: '2026-09-14T09:00:00.000Z',
      targetId: 'p1',
      before: 'monitored',
      after: 'excluded'
    });
    await insertAudit({
      auditId: 'a2',
      action: 'project.restore',
      occurredAt: '2026-09-14T10:00:00.000Z',
      targetId: 'p2',
      before: 'excluded',
      after: 'monitored'
    });

    const result = await listAuditRecords(pool!, { limit: 10 });
    expect(result.rows.map((row) => row.auditId)).toEqual(['a2', 'a1']);
    expect(result.rows[0]).toMatchObject({
      action: 'project.restore',
      targetType: 'project',
      targetId: 'p2',
      beforeSummary: 'excluded',
      afterSummary: 'monitored'
    });
    expect(result.page.hasMore).toBe(false);
  });

  itDb('审计记录不含身份信息（Q75/Q85）', async () => {
    await insertAudit({ auditId: 'a1', action: 'project.exclude', occurredAt: '2026-09-14T09:00:00.000Z' });
    const result = await listAuditRecords(pool!, {});
    const keys = Object.keys(result.rows[0]!);
    // 结构上就没有"谁做的"这类字段
    expect(keys).not.toContain('actor');
    expect(keys).not.toContain('sessionId');
    expect(keys).not.toContain('userAgent');
  });

  itDb('keyset 分页可连续读取且不重复', async () => {
    for (let index = 0; index < 5; index += 1) {
      await insertAudit({
        auditId: `a${index}`,
        action: 'delivery.replay',
        occurredAt: `2026-09-14T0${index}:00:00.000Z`
      });
    }
    const first = await listAuditRecords(pool!, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.page.hasMore).toBe(true);

    const second = await listAuditRecords(pool!, { limit: 2, cursor: first.page.nextCursor });
    expect(second.rows).toHaveLength(2);
    const ids = new Set([...first.rows, ...second.rows].map((row) => row.auditId));
    expect(ids.size).toBe(4);
    // 时间严格倒序，没有重叠
    expect(second.rows[0]!.occurredAt <= first.rows[1]!.occurredAt).toBe(true);
  });

  itDb('可按动作过滤', async () => {
    await insertAudit({ auditId: 'a1', action: 'project.exclude', occurredAt: '2026-09-14T09:00:00.000Z' });
    await insertAudit({ auditId: 'a2', action: 'delivery.replay', occurredAt: '2026-09-14T10:00:00.000Z' });
    const result = await listAuditRecords(pool!, { action: 'delivery.replay' });
    expect(result.rows.map((row) => row.auditId)).toEqual(['a2']);
  });

  itDb('损坏的游标按从头开始处理，不抛错', async () => {
    await insertAudit({ auditId: 'a1', action: 'project.exclude', occurredAt: '2026-09-14T09:00:00.000Z' });
    const result = await listAuditRecords(pool!, { cursor: 'not-a-valid-cursor' });
    expect(result.rows).toHaveLength(1);
  });

  itDb('空库返回空列表而不是报错', async () => {
    const result = await listAuditRecords(pool!, {});
    expect(result.rows).toEqual([]);
    expect(result.page).toMatchObject({ nextCursor: null, hasMore: false });
  });
});
