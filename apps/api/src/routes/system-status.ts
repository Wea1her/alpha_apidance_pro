import type { FastifyInstance } from 'fastify';
import type { ApiDatabase } from '../types.js';

export function registerSystemStatusRoutes(app: FastifyInstance, options: { database: ApiDatabase }): void {
  app.get('/api/system/status', async () => {
    const [raw, jobs, projects, providers] = await Promise.all([
      options.database.query<{ count: string; latest: string | null }>(`select count(*)::text as count, max(received_at) as latest from raw_events`),
      options.database.query<{ queued: string; failed: string }>(`select count(*) filter (where status in ('queued','retry','running'))::text as queued, count(*) filter (where status = 'dead')::text as failed from jobs`),
      options.database.query<{ count: string }>(`select count(*)::text as count from projects where status <> 'excluded'`),
      options.database.query<{ name: string; health: string; checked: string | null }>(`select name, health_status as health, last_health_check_at as checked from ai_provider_profiles order by name`)
    ]);
    return { hook: { status: 'connected', rawEvents: Number(raw.rows[0]?.count ?? 0), latestReceivedAt: raw.rows[0]?.latest ?? null }, queue: { pending: Number(jobs.rows[0]?.queued ?? 0), dead: Number(jobs.rows[0]?.failed ?? 0) }, projects: Number(projects.rows[0]?.count ?? 0), aiProviders: providers.rows };
  });
}
