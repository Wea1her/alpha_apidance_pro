import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { StoragePool } from './client.js';

/**
 * 访问层：共享访问密钥 + 管理员密码 + 服务端会话（Q78-Q85）。
 *
 * 依据：
 * - Q84：写操作需要管理员密码；只读会话访问写路由必须被拒。
 * - Q82：访问密钥验证通过后签发长期、自动续期的 HttpOnly Cookie，不反复输入。
 * - Q79：访问密钥不轮换；因此没有按人撤销，唯一隔离手段是清除服务端会话。
 * - Q72：环境变量保存恢复密码，用于忘记密码时重置。
 * - Q73：改管理员密码后全部管理员会话失效，保留操作者当前会话。
 * - Q86：访问密钥与管理员密码必须是两个不同的值，启动时校验。
 * - Q83：明文密钥来自环境变量；数据库只保存哈希，避免备份泄露直接暴露密钥。
 *
 * 安全取舍（明确记录，避免实现者误解为遗漏）：
 * - 这里用 scrypt 而不是 Argon2id：不引入新依赖；两者都是内存硬哈希，scrypt 在 Node 标准库内。
 * - 会话令牌使用 32 字节随机值，数据库只存其 SHA-256，令牌本身只在 Cookie 中。
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

const SCRYPT_KEY_LENGTH = 64;
const SESSION_TOKEN_BYTES = 32;
/** 长期 Cookie：一年；每次通过会话访问会自动续期（Q82）。 */
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export type SessionRole = 'visitor' | 'admin';

export interface AuthConfig {
  /** 共享访问密钥（环境变量明文）。 */
  accessKey: string;
  /** 管理员密码（环境变量明文）。 */
  adminPassword: string;
  /** 恢复密码；用于忘记密码时重置（Q72）。 */
  recoveryPassword?: string | null;
}

export interface AuthConfigValidation {
  ok: boolean;
  /** 校验失败的原因；ok 为 true 时为空数组。 */
  errors: string[];
  warnings: string[];
}

/**
 * 启动时校验（Q86）：两个凭据必须是不同的值，且满足最小长度。
 * 返回错误而不是抛异常，方便调用方打印后退出。
 */
export function validateAuthConfig(config: AuthConfig): AuthConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.accessKey || config.accessKey.trim().length === 0) {
    errors.push('缺少共享访问密钥（ACCESS_KEY）');
  } else if (config.accessKey.length < 12) {
    errors.push('共享访问密钥长度必须不少于 12 个字符');
  }

  if (!config.adminPassword || config.adminPassword.trim().length === 0) {
    errors.push('缺少管理员密码（ADMIN_PASSWORD）');
  } else if (config.adminPassword.length < 12) {
    errors.push('管理员密码长度必须不少于 12 个字符');
  }

  // Q86：两个值相同会让“访客只读”静默失效，必须拒绝启动。
  if (config.accessKey && config.adminPassword && config.accessKey === config.adminPassword) {
    errors.push('访问密钥与管理员密码不能是同一个值（会让只读隔离失效）');
  }

  if (config.recoveryPassword && config.recoveryPassword === config.adminPassword) {
    warnings.push('恢复密码与管理员密码相同，建议使用不同的值');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 从环境变量读取访问层配置。 */
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    accessKey: env.ACCESS_KEY?.trim() ?? '',
    adminPassword: env.ADMIN_PASSWORD?.trim() ?? '',
    recoveryPassword: env.RECOVERY_PASSWORD?.trim() ?? null,
  };
}

async function hashSecret(secret: string, salt: string): Promise<string> {
  const derived = await scrypt(secret, salt, SCRYPT_KEY_LENGTH);
  return derived.toString('hex');
}

/** 常量时间比较，避免通过响应时间推断口令。 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 初始化或更新数据库中的凭据哈希。
 *
 * 首次启动把环境变量里的明文口令写入哈希；后续启动若环境变量改变，则更新哈希
 * 并使旧会话失效（等价于“换密码”）。
 */
export async function syncCredentials(
  pool: StoragePool,
  config: AuthConfig
): Promise<{ changed: boolean; invalidatedSessions: number }> {
  let changed = false;
  let invalidatedSessions = 0;

  const entries: Array<{ kind: SessionRole; secret: string }> = [
    { kind: 'visitor', secret: config.accessKey },
    { kind: 'admin', secret: config.adminPassword },
  ];

  for (const entry of entries) {
    const existing = await pool.query(`SELECT secret_hash, secret_salt FROM access_credentials WHERE kind = $1`, [
      entry.kind,
    ]);
    const row = existing.rows[0];
    if (row) {
      const candidate = await hashSecret(entry.secret, String(row.secret_salt));
      if (safeEqual(candidate, String(row.secret_hash))) continue;
      // 环境变量变了：更新哈希并让该角色既有会话失效（Q73）。
      const salt = randomBytes(16).toString('hex');
      const hash = await hashSecret(entry.secret, salt);
      await pool.transaction(async (client) => {
        await client.query(`UPDATE access_credentials SET secret_hash = $2, secret_salt = $3, updated_at = now() WHERE kind = $1`, [
          entry.kind,
          hash,
          salt,
        ]);
        const revoked = await client.query(
          `UPDATE sessions SET revoked_at = now() WHERE role = $1 AND revoked_at IS NULL`,
          [entry.kind]
        );
        invalidatedSessions += Number(revoked.rowCount ?? 0);
      });
      changed = true;
      continue;
    }

    const salt = randomBytes(16).toString('hex');
    const hash = await hashSecret(entry.secret, salt);
    await pool.query(
      `INSERT INTO access_credentials (credential_id, kind, secret_hash, secret_salt)
       VALUES ($1, $2, $3, $4) ON CONFLICT (kind) DO NOTHING`,
      [`cred_${entry.kind}`, entry.kind, hash, salt]
    );
    changed = true;
  }

  return { changed, invalidatedSessions };
}

export interface LoginResult {
  ok: boolean;
  role: SessionRole | null;
  /** 会话令牌（只在响应里出现一次，数据库只存哈希）。 */
  token: string | null;
  expiresAt: string | null;
  rejection: 'invalid_credential' | 'service_unavailable' | null;
}

/**
 * 校验访问密钥或管理员密码并建立会话。
 *
 * 同一个入口同时接受两种口令：先比对访问密钥（visitor），再比对管理员密码（admin）。
 * 由于 Q78 要求“会话严格绑定角色”，管理员会话才能访问写路由。
 */
export async function loginWithSecret(
  pool: StoragePool,
  input: { secret: string; userAgent?: string | null; now?: Date }
): Promise<LoginResult> {
  const now = input.now ?? new Date();
  const credentials = await pool.query(`SELECT kind, secret_hash, secret_salt FROM access_credentials`);
  if (credentials.rows.length === 0) {
    return { ok: false, role: null, token: null, expiresAt: null, rejection: 'service_unavailable' };
  }

  let role: SessionRole | null = null;
  for (const row of credentials.rows) {
    const candidate = await hashSecret(input.secret, String(row.secret_salt));
    if (safeEqual(candidate, String(row.secret_hash))) {
      role = String(row.kind) as SessionRole;
      break;
    }
  }
  if (!role) {
    return { ok: false, role: null, token: null, expiresAt: null, rejection: 'invalid_credential' };
  }

  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await pool.query(
    `INSERT INTO sessions (session_id, role, expires_at, user_agent, last_seen_at)
     VALUES ($1, $2, $3::timestamptz, $4, $5::timestamptz)`,
    [hashSessionToken(token), role, expiresAt, input.userAgent ?? null, now.toISOString()]
  );

  return { ok: true, role, token, expiresAt, rejection: null };
}

export interface SessionLookup {
  role: SessionRole;
  expiresAt: string | null;
}

/**
 * 解析会话令牌并续期（Q82：长期、自动续期）。
 * 返回 null 表示无效、已撤销或已过期。
 */
export async function resolveSession(
  pool: StoragePool,
  input: { token: string; now?: Date; renew?: boolean }
): Promise<SessionLookup | null> {
  const now = input.now ?? new Date();
  const sessionId = hashSessionToken(input.token);
  const result = await pool.query(
    `SELECT role, expires_at, revoked_at FROM sessions WHERE session_id = $1`,
    [sessionId]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.revoked_at !== null && row.revoked_at !== undefined) return null;
  if (row.expires_at instanceof Date && row.expires_at.getTime() <= now.getTime()) return null;

  if (input.renew !== false) {
    await pool.query(`UPDATE sessions SET last_seen_at = $2::timestamptz WHERE session_id = $1`, [
      sessionId,
      now.toISOString(),
    ]);
  }
  return {
    role: String(row.role) as SessionRole,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at ? String(row.expires_at) : null,
  };
}

export interface ElevateResult {
  ok: boolean;
  role: SessionRole | null;
  rejection: 'invalid_credential' | 'session_not_found' | 'admin_credential_missing' | null;
}

/**
 * 把已有会话提升为管理员（Q106：顶部管理入口 + 密码验证后展开）。
 *
 * 为什么需要它：访客用访问密钥进入后是**只读角色**（Q78 会话严格绑定角色）。
 * 若没有提权入口，访客想执行写操作必须先登出、再用管理员密码重新登录——
 * 与"顶部管理入口 + 验密后展开"的决策不符。
 *
 * 注意：
 * - 提权只改角色，**不新建会话**，因此不会产生第二个 Cookie；
 * - 仍然校验管理员密码本身（不能仅凭"已经登录"就拿到写权限）；
 * - 会话若已被撤销或不存在则拒绝。
 */
export async function elevateSession(
  pool: StoragePool,
  input: { token: string; adminPassword: string; now?: Date }
): Promise<ElevateResult> {
  const now = input.now ?? new Date();
  const admin = await pool.query(`SELECT secret_hash, secret_salt FROM access_credentials WHERE kind = 'admin'`);
  const row = admin.rows[0];
  if (!row) return { ok: false, role: null, rejection: 'admin_credential_missing' };

  const candidate = await hashSecret(input.adminPassword, String(row.secret_salt));
  if (!safeEqual(candidate, String(row.secret_hash))) {
    return { ok: false, role: null, rejection: 'invalid_credential' };
  }

  const sessionId = hashSessionToken(input.token);
  // $1::text IS NOT NULL 锚定参数类型（否则 Postgres 无法推断参数类型）。
  const updated = await pool.query(
    `UPDATE sessions
        SET role = 'admin', last_seen_at = $2::timestamptz
      WHERE session_id = $1
        AND revoked_at IS NULL
        AND $1::text IS NOT NULL`,
    [sessionId, now.toISOString()]
  );
  if ((updated.rowCount ?? 0) === 0) return { ok: false, role: null, rejection: 'session_not_found' };
  return { ok: true, role: 'admin', rejection: null };
}

/** 登出：撤销单个会话。 */
export async function revokeSession(pool: StoragePool, token: string, now = new Date()): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sessions SET revoked_at = $2::timestamptz WHERE session_id = $1 AND revoked_at IS NULL`,
    [hashSessionToken(token), now.toISOString()]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 修改管理员密码（Q73）：更新哈希并使其它管理员会话失效，保留当前会话。
 */
export async function changeAdminPassword(
  pool: StoragePool,
  input: { newPassword: string; keepToken?: string | null; now?: Date }
): Promise<{ updated: boolean; invalidatedSessions: number; error: 'too_short' | null }> {
  if (input.newPassword.trim().length < 12) {
    return { updated: false, invalidatedSessions: 0, error: 'too_short' };
  }
  const now = input.now ?? new Date();
  const salt = randomBytes(16).toString('hex');
  const hash = await hashSecret(input.newPassword.trim(), salt);

  return pool.transaction(async (client) => {
    await client.query(
      // $1 只作类型锚点：让参数类型可推断（不参与更新）。
      `UPDATE access_credentials SET secret_hash = $2, secret_salt = $3, updated_at = $4::timestamptz WHERE kind = 'admin' AND $1::text IS NOT NULL`,
      ['admin', hash, salt, now.toISOString()]
    );
    const keep = input.keepToken ? hashSessionToken(input.keepToken) : null;
    const revoked = await client.query(
      `UPDATE sessions SET revoked_at = $2::timestamptz
        WHERE role = 'admin' AND revoked_at IS NULL AND ($1::text IS NULL OR session_id <> $1::text)`,
      [keep, now.toISOString()]
    );
    return { updated: true, invalidatedSessions: Number(revoked.rowCount ?? 0), error: null };
  });
}

/**
 * 用恢复密码重置管理员密码（Q72）。
 * 恢复密码由调用方从环境变量读入后传入（不在这里读 process.env，配置集中且便于测试）。
 */
export async function resetAdminPasswordWithRecovery(
  pool: StoragePool,
  input: {
    recoverySecret: string;
    newPassword: string;
    /** 已配置的恢复密码；为空表示未配置，无法使用该途径。 */
    configuredRecoveryPassword: string | null;
    keepToken?: string | null;
    now?: Date;
  }
): Promise<{ updated: boolean; invalidatedSessions: number; error: 'invalid_recovery' | 'not_configured' | 'too_short' | null }> {
  const configured = (input.configuredRecoveryPassword ?? '').trim();
  if (configured.length === 0) {
    return { updated: false, invalidatedSessions: 0, error: 'not_configured' };
  }
  const provided = input.recoverySecret.trim();
  if (!safeEqual(configured, provided)) {
    return { updated: false, invalidatedSessions: 0, error: 'invalid_recovery' };
  }
  const result = await changeAdminPassword(pool, {
    newPassword: input.newPassword,
    keepToken: input.keepToken ?? null,
    now: input.now,
  });
  if (result.error) return { updated: false, invalidatedSessions: 0, error: result.error };
  return { updated: true, invalidatedSessions: result.invalidatedSessions, error: null };
}

/** 清除所有会话（Q79：唯一能让所有人重新验证的手段）。 */
export async function revokeAllSessions(pool: StoragePool, now = new Date()): Promise<number> {
  const result = await pool.query(`UPDATE sessions SET revoked_at = $1::timestamptz WHERE revoked_at IS NULL`, [
    now.toISOString(),
  ]);
  return Number(result.rowCount ?? 0);
}

export interface SessionSnapshot {
  visitors: number;
  admins: number;
}

/** 运维状态页需要的会话计数（不含身份信息）。 */
export async function countActiveSessions(pool: StoragePool, now = new Date()): Promise<SessionSnapshot> {
  const result = await pool.query(
    `SELECT role, count(*)::int AS count FROM sessions
      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $1::timestamptz)
      GROUP BY role`,
    [now.toISOString()]
  );
  const snapshot: SessionSnapshot = { visitors: 0, admins: 0 };
  for (const row of result.rows) {
    if (String(row.role) === 'visitor') snapshot.visitors = Number(row.count ?? 0);
    else if (String(row.role) === 'admin') snapshot.admins = Number(row.count ?? 0);
  }
  return snapshot;
}

/** 写操作门禁：只有管理员会话可以通过（Q84）。 */
export function assertWriteAccess(session: SessionLookup | null): { allowed: boolean; status: 403 | 401 | null } {
  if (!session) return { allowed: false, status: 401 };
  if (session.role !== 'admin') return { allowed: false, status: 403 };
  return { allowed: true, status: null };
}
