import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACCESS_COOKIE } from '../plugins/session.js';
import { hashToken, normalizeOrigin } from '../plugins/security.js';
import type { ApiDatabase } from '../types.js';

const AccessKeyBody = z.object({ accessKey: z.string().min(1).max(512) }).strict();

export interface AuthRoutesOptions {
  database: ApiDatabase;
  accessKeyHash: string;
  sessionTtlSeconds: number;
  secureCookies: boolean;
  maxFailedAttempts?: number;
  failureWindowMinutes?: number;
  allowedOrigin?: string;
}

function originAllowed(origin: string | undefined, allowedOrigin: string | undefined): boolean {
  if (!origin || !allowedOrigin) return false;
  try {
    return normalizeOrigin(origin) === normalizeOrigin(allowedOrigin);
  } catch {
    return false;
  }
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  app.post('/auth/access-key', async (request, reply) => {
    if (!originAllowed(request.headers.origin, options.allowedOrigin)) {
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    const parsed = AccessKeyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const ip = request.ip;
    const failed = await options.database.query<{ count: string }>(
      `select count(*)::text as count
       from login_attempts
       where ip_address = $1 and succeeded = false
         and attempted_at > now() - ($2::integer * interval '1 minute')`,
      [ip, options.failureWindowMinutes ?? 15]
    );
    if (Number(failed.rows[0]?.count ?? 0) >= (options.maxFailedAttempts ?? 5)) {
      return reply.code(429).send({ error: 'too_many_attempts' });
    }

    const succeeded = await argon2.verify(options.accessKeyHash, parsed.data.accessKey).catch(() => false);
    await options.database.query(
      'insert into login_attempts (ip_address, succeeded) values ($1, $2)',
      [ip, succeeded]
    );
    if (!succeeded) return reply.code(401).send({ error: 'invalid_access_key' });

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + options.sessionTtlSeconds * 1000);
    await options.database.query(
      'insert into access_sessions (token_hash, expires_at) values ($1, $2)',
      [hashToken(token), expiresAt]
    );
    reply.setCookie(ACCESS_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: options.secureCookies,
      sameSite: 'strict',
      maxAge: options.sessionTtlSeconds
    });
    return reply.code(204).send();
  });

  app.post('/auth/logout', async (request, reply) => {
    await options.database.query(
      'update access_sessions set revoked_at = now() where id = $1 and revoked_at is null',
      [request.accessSession!.sessionId]
    );
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}
