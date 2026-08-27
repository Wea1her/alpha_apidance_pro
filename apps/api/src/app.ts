import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { installSessionProtection } from './plugins/session.js';
import { registerAlphaHookRoute } from './routes/alpha-hook.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerEventRoute } from './routes/events.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerLedgerRoutes } from './routes/ledger.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerSystemStatusRoutes } from './routes/system-status.js';
import type { ApiDatabase } from './types.js';

export interface BuildAppOptions {
  database: ApiDatabase;
  accessKeyHash: string;
  hookSecret: string;
  allowedOrigin?: string;
  secureCookies?: boolean;
  sessionTtlSeconds?: number;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256 * 1024,
    trustProxy: true
  });
  await app.register(cookie);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      // Keep malformed JSON as a string so the Hook ingestor can retain it for audit.
      done(null, body);
    }
  });

  installSessionProtection(app, {
    database: options.database,
    allowedOrigin: options.allowedOrigin
  });
  registerAuthRoutes(app, {
    database: options.database,
    accessKeyHash: options.accessKeyHash,
    sessionTtlSeconds: options.sessionTtlSeconds ?? 7 * 24 * 60 * 60,
    secureCookies: options.secureCookies ?? true,
    allowedOrigin: options.allowedOrigin
  });
  registerAlphaHookRoute(app, {
    database: options.database,
    hookSecret: options.hookSecret
  });
  registerProjectRoutes(app, { database: options.database });
  registerReportRoutes(app, { database: options.database });
  registerLedgerRoutes(app, { database: options.database });
  registerCalendarRoutes(app, { database: options.database });
  registerSystemStatusRoutes(app, { database: options.database });
  registerEventRoute(app, { database: options.database });

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/session', async () => ({ authenticated: true }));

  await app.ready();
  return app;
}
