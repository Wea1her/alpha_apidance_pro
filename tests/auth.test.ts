import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import {
  assertWriteAccess,
  changeAdminPassword,
  countActiveSessions,
  loginWithSecret,
  readAuthConfig,
  resetAdminPasswordWithRecovery,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  syncCredentials,
  validateAuthConfig
} from '../src/storage/auth.js';

/**
 * 访问层（Q78-Q86）集成测试：需要真实 PostgreSQL；不可用时跳过。
 */

let pool: StoragePool | null = null;
let available = false;

const ACCESS_KEY = 'visitor-access-key-1234';
const ADMIN_PASSWORD = 'admin-password-5678';
const RECOVERY_PASSWORD = 'recovery-password-9999';

function itDb(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available) return;
    await fn();
  });
}

beforeAll(async () => {
  pool = await openTestDatabase();
  available = pool !== null;
  if (available) await resetSchemaAndMigrate(pool!);
});

beforeEach(async () => {
  if (!available) return;
  await pool!.query('TRUNCATE sessions, access_credentials RESTART IDENTITY CASCADE');
  await syncCredentials(pool!, {
    accessKey: ACCESS_KEY,
    adminPassword: ADMIN_PASSWORD,
    recoveryPassword: RECOVERY_PASSWORD
  });
});

afterAll(async () => {
  if (pool) await pool.close();
});

describe('启动校验（Q86）', () => {
  it('缺少凭据或长度不足时拒绝', () => {
    expect(validateAuthConfig({ accessKey: '', adminPassword: ADMIN_PASSWORD }).ok).toBe(false);
    expect(validateAuthConfig({ accessKey: 'short', adminPassword: ADMIN_PASSWORD }).ok).toBe(false);
    expect(validateAuthConfig({ accessKey: ACCESS_KEY, adminPassword: '' }).ok).toBe(false);
  });

  it('访问密钥与管理员密码相同必须拒绝（否则只读隔离静默失效）', () => {
    const result = validateAuthConfig({ accessKey: 'same-value-123456', adminPassword: 'same-value-123456' });
    expect(result.ok).toBe(false);
    expect(result.errors.join('')).toContain('不能是同一个值');
  });

  it('合法配置通过，并提示恢复密码与管理员密码相同的风险', () => {
    const ok = validateAuthConfig({ accessKey: ACCESS_KEY, adminPassword: ADMIN_PASSWORD });
    expect(ok.ok).toBe(true);
    expect(ok.errors).toEqual([]);

    const warned = validateAuthConfig({
      accessKey: ACCESS_KEY,
      adminPassword: ADMIN_PASSWORD,
      recoveryPassword: ADMIN_PASSWORD
    });
    expect(warned.ok).toBe(true);
    expect(warned.warnings.join('')).toContain('恢复密码');
  });

  it('从环境变量读取配置', () => {
    const config = readAuthConfig({ ACCESS_KEY: ' a-key-1234567890 ', ADMIN_PASSWORD: 'admin-1234567890' });
    expect(config).toMatchObject({ accessKey: 'a-key-1234567890', adminPassword: 'admin-1234567890' });
  });
});

describe('登录与会话', () => {
  itDb('访问密钥建立只读会话，管理员密码建立管理员会话', async () => {
    const visitor = await loginWithSecret(pool!, { secret: ACCESS_KEY });
    expect(visitor).toMatchObject({ ok: true, role: 'visitor', rejection: null });
    expect(visitor.token).toBeTruthy();

    const admin = await loginWithSecret(pool!, { secret: ADMIN_PASSWORD });
    expect(admin).toMatchObject({ ok: true, role: 'admin' });

    // 两种会话的写权限不同（Q84）
    const visitorSession = await resolveSession(pool!, { token: visitor.token! });
    const adminSession = await resolveSession(pool!, { token: admin.token! });
    expect(assertWriteAccess(visitorSession)).toEqual({ allowed: false, status: 403 });
    expect(assertWriteAccess(adminSession)).toEqual({ allowed: true, status: null });
  });

  itDb('错误口令被拒绝，且不建立会话', async () => {
    const result = await loginWithSecret(pool!, { secret: 'wrong-secret-value' });
    expect(result).toMatchObject({ ok: false, role: null, rejection: 'invalid_credential' });
    expect(await countActiveSessions(pool!)).toMatchObject({ visitors: 0, admins: 0 });
  });

  itDb('数据库不保存明文口令', async () => {
    const rows = await pool!.query(`SELECT kind, secret_hash, secret_salt FROM access_credentials`);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(String(row.secret_hash)).not.toContain(ACCESS_KEY);
      expect(String(row.secret_hash)).not.toContain(ADMIN_PASSWORD);
      expect(String(row.secret_hash).length).toBeGreaterThan(64);
    }
    // 会话表也只存令牌哈希
    const session = await loginWithSecret(pool!, { secret: ACCESS_KEY });
    const stored = await pool!.query(`SELECT session_id FROM sessions`);
    expect(stored.rows[0]?.session_id).not.toBe(session.token);
  });

  itDb('会话可解析并自动续期，登出后失效', async () => {
    const login = await loginWithSecret(pool!, { secret: ACCESS_KEY, now: new Date('2026-09-14T00:00:00.000Z') });
    const session = await resolveSession(pool!, { token: login.token!, now: new Date('2026-09-20T00:00:00.000Z') });
    expect(session?.role).toBe('visitor');

    const lastSeen = await pool!.query(`SELECT last_seen_at FROM sessions`);
    expect(lastSeen.rows[0]?.last_seen_at).not.toBeNull();

    expect(await revokeSession(pool!, login.token!)).toBe(true);
    expect(await resolveSession(pool!, { token: login.token! })).toBeNull();
  });

  itDb('未知或已撤销令牌解析为 null', async () => {
    expect(await resolveSession(pool!, { token: 'not-a-real-token' })).toBeNull();
  });

  itDb('过期会话不再有效', async () => {
    const login = await loginWithSecret(pool!, { secret: ACCESS_KEY });
    await pool!.query(`UPDATE sessions SET expires_at = now() - interval '1 day'`);
    expect(await resolveSession(pool!, { token: login.token! })).toBeNull();
  });

  itDb('会话计数用于运维状态页，不含身份信息', async () => {
    await loginWithSecret(pool!, { secret: ACCESS_KEY });
    await loginWithSecret(pool!, { secret: ACCESS_KEY });
    await loginWithSecret(pool!, { secret: ADMIN_PASSWORD });
    expect(await countActiveSessions(pool!)).toMatchObject({ visitors: 2, admins: 1 });
  });
});

describe('凭据变更的会话影响', () => {
  itDb('改管理员密码后其它管理员会话失效，保留当前会话（Q73）', async () => {
    const keep = await loginWithSecret(pool!, { secret: ADMIN_PASSWORD });
    const other = await loginWithSecret(pool!, { secret: ADMIN_PASSWORD });

    const result = await changeAdminPassword(pool!, { newPassword: 'new-admin-password-0001', keepToken: keep.token! });
    expect(result).toMatchObject({ updated: true, error: null });
    expect(result.invalidatedSessions).toBe(1);

    expect(await resolveSession(pool!, { token: keep.token! })).toMatchObject({ role: 'admin' });
    expect(await resolveSession(pool!, { token: other.token! })).toBeNull();

    // 新口令可登录，旧口令不可
    expect(await loginWithSecret(pool!, { secret: 'new-admin-password-0001' })).toMatchObject({ ok: true, role: 'admin' });
    expect(await loginWithSecret(pool!, { secret: ADMIN_PASSWORD })).toMatchObject({ ok: false });
  });

  itDb('新密码过短被拒绝', async () => {
    const result = await changeAdminPassword(pool!, { newPassword: 'short' });
    expect(result).toMatchObject({ updated: false, error: 'too_short' });
  });

  itDb('环境变量里的管理员密码变化会让既有管理员会话失效', async () => {
    await loginWithSecret(pool!, { secret: ADMIN_PASSWORD });
    expect(await countActiveSessions(pool!)).toMatchObject({ admins: 1 });

    const synced = await syncCredentials(pool!, {
      accessKey: ACCESS_KEY,
      adminPassword: 'rotated-admin-password-77',
      recoveryPassword: RECOVERY_PASSWORD
    });
    expect(synced.changed).toBe(true);
    expect(synced.invalidatedSessions).toBe(1);
    expect(await countActiveSessions(pool!)).toMatchObject({ admins: 0 });
  });

  itDb('凭据未变化时重复同步不失效会话', async () => {
    await loginWithSecret(pool!, { secret: ACCESS_KEY });
    const synced = await syncCredentials(pool!, {
      accessKey: ACCESS_KEY,
      adminPassword: ADMIN_PASSWORD,
      recoveryPassword: RECOVERY_PASSWORD
    });
    expect(synced.changed).toBe(false);
    expect(synced.invalidatedSessions).toBe(0);
  });

  itDb('恢复密码可以重置管理员密码，错误恢复密码被拒（Q72）', async () => {
    const invalid = await resetAdminPasswordWithRecovery(pool!, {
      recoverySecret: 'wrong-recovery',
      newPassword: 'reset-admin-password-01',
      configuredRecoveryPassword: RECOVERY_PASSWORD
    });
    expect(invalid).toMatchObject({ updated: false, error: 'invalid_recovery' });

    const notConfigured = await resetAdminPasswordWithRecovery(pool!, {
      recoverySecret: RECOVERY_PASSWORD,
      newPassword: 'reset-admin-password-01',
      configuredRecoveryPassword: null
    });
    expect(notConfigured).toMatchObject({ updated: false, error: 'not_configured' });

    const ok = await resetAdminPasswordWithRecovery(pool!, {
      recoverySecret: RECOVERY_PASSWORD,
      newPassword: 'reset-admin-password-01',
      configuredRecoveryPassword: RECOVERY_PASSWORD
    });
    expect(ok).toMatchObject({ updated: true, error: null });
    expect(await loginWithSecret(pool!, { secret: 'reset-admin-password-01' })).toMatchObject({ ok: true, role: 'admin' });
  });

  itDb('清除全部会话是唯一的“踢所有人”手段（Q79）', async () => {
    await loginWithSecret(pool!, { secret: ACCESS_KEY });
    await loginWithSecret(pool!, { secret: ADMIN_PASSWORD });
    const revoked = await revokeAllSessions(pool!);
    expect(revoked).toBe(2);
    expect(await countActiveSessions(pool!)).toMatchObject({ visitors: 0, admins: 0 });
  });
});
