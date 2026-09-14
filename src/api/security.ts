/**
 * HTTP 层的安全原语：速率限制、来源校验与 Cookie 常量。
 *
 * 依据：Q54（首版安全基线 = 审计 + 写接口 CSRF/来源校验 + 登录与改密速率限制 + 敏感操作二次确认）、
 * Q82（长期 HttpOnly Cookie）、Q84（写操作需要管理员密码）。
 *
 * 这里刻意不引入额外依赖：速率限制是单实例内存滑动窗口，够首版使用；
 * 多实例部署时需要换成共享存储，这一点在注释里显式标注，避免被误当作分布式限流。
 */

export interface RateLimitRule {
  /** 窗口内允许的最大次数。 */
  max: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** 被拒绝时的重试等待（毫秒）。 */
  retryAfterMs: number;
}

/**
 * 单实例内存滑动窗口限流器。
 *
 * 限制：进程内有效；多实例或重启后会重置。首版是单机 Compose 部署（Q23、Q24），
 * 且本轮限流只用于登录/改密这类低频入口，因此可接受。
 */
export class InMemoryRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 记录一次尝试并判断是否超限。 */
  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const current = this.now();
    const windowStart = current - rule.windowMs;
    const existing = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

    if (existing.length >= rule.max) {
      const oldest = existing[0] ?? current;
      this.hits.set(key, existing);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, oldest + rule.windowMs - current) };
    }

    existing.push(current);
    this.hits.set(key, existing);
    return { allowed: true, remaining: Math.max(0, rule.max - existing.length), retryAfterMs: 0 };
  }

  /** 清空（用于测试与凭据轮换后的解锁）。 */
  reset(key?: string): void {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }
}

/** 本会话使用的 Cookie 名与属性。 */
export const SESSION_COOKIE_NAME = 'djk_session';

/**
 * Cookie 属性：HttpOnly + SameSite=Lax + Secure。
 * 本地开发（无 HTTPS）时 Secure 会导致 Cookie 不被写入，所以由调用方按部署形态决定。
 */
export function sessionCookieOptions(options: { secure: boolean; maxAgeMs: number }): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    path: '/',
    maxAge: Math.floor(options.maxAgeMs / 1000),
  };
}

export interface OriginCheckInput {
  method: string;
  origin: string | undefined;
  host: string | undefined;
  contentType?: string | undefined;
}

export interface OriginCheckResult {
  allowed: boolean;
  reason: 'ok' | 'origin_mismatch' | 'missing_origin' | 'bad_content_type';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 写接口的来源校验（Q54 的 CSRF 防线）。
 *
 * 规则：写方法必须带 Origin 且与 Host 同源；JSON 写入必须声明 content-type。
 * 用同源校验而不是 CSRF token：整站同域、只有一个写入口，同源校验更简单且不引入状态。
 */
export function checkWriteOrigin(input: OriginCheckInput): OriginCheckResult {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { allowed: true, reason: 'ok' };
  if (!input.origin) return { allowed: false, reason: 'missing_origin' };
  if (!input.host) return { allowed: false, reason: 'origin_mismatch' };

  let originHost: string;
  try {
    originHost = new URL(input.origin).host;
  } catch {
    return { allowed: false, reason: 'origin_mismatch' };
  }
  if (originHost !== input.host) return { allowed: false, reason: 'origin_mismatch' };

  if (input.contentType && !input.contentType.toLowerCase().includes('application/json')) {
    return { allowed: false, reason: 'bad_content_type' };
  }
  return { allowed: true, reason: 'ok' };
}

/** 客户端标识：优先取代理头，其次连接地址；仅用于限流键，不用于审计（Q75）。 */
export function clientKeyOf(input: { forwardedFor?: string | undefined; remoteAddress?: string | undefined }): string {
  const forwarded = input.forwardedFor?.split(',')[0]?.trim();
  if (forwarded && forwarded.length > 0) return forwarded;
  return input.remoteAddress ?? 'unknown';
}
