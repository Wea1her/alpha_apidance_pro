import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashToken, normalizeOrigin } from './security.js';
import type { ApiDatabase } from '../types.js';

export const ACCESS_COOKIE = 'alpha_access';

interface SessionRow {
  id: string;
  token_hash: string;
}

export interface SessionPluginOptions {
  database: ApiDatabase;
  allowedOrigin?: string;
}

function isProtectedPath(request: FastifyRequest): boolean {
  return request.url === '/events' || request.url.startsWith('/api/') || request.url === '/auth/logout';
}

export function installSessionProtection(app: FastifyInstance, options: SessionPluginOptions): void {
  app.addHook('preHandler', async (request, reply) => {
    if (!isProtectedPath(request)) return;

    const token = request.cookies[ACCESS_COOKIE];
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const tokenHash = hashToken(token);
    const result = await options.database.query<SessionRow>(
      `update access_sessions
       set last_seen_at = now()
       where token_hash = $1 and revoked_at is null and expires_at > now()
       returning id, token_hash`,
      [tokenHash]
    );
    const session = result.rows[0];
    if (!session) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    request.accessSession = { sessionId: session.id, tokenHash: session.token_hash };

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      let sameOrigin = false;
      try {
        sameOrigin = Boolean(origin && options.allowedOrigin && normalizeOrigin(origin) === normalizeOrigin(options.allowedOrigin));
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        return reply.code(403).send({ error: 'origin_not_allowed' });
      }
    }
  });
}
