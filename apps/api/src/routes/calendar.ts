import type { FastifyInstance } from 'fastify';
import type { ApiDatabase } from '../types.js';

export function registerCalendarRoutes(app: FastifyInstance, options: { database: ApiDatabase }): void {
  app.get<{ Querystring: { from?: string; to?: string; projectId?: string } }>('/api/calendar', async (request) => {
    const { from, to, projectId } = request.query;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (from) { params.push(from); clauses.push(`starts_at >= $${params.length}`); }
    if (to) { params.push(to); clauses.push(`starts_at < $${params.length}`); }
    if (projectId) { params.push(projectId); clauses.push(`project_id = $${params.length}`); }
    const result = await options.database.query(
      `select id, project_id, title, starts_at, status, confidence, remind_24h, remind_1h, source_evidence_id, created_at, updated_at
       from calendar_events ${clauses.length ? `where ${clauses.join(' and ')}` : ''} order by starts_at asc limit 200`,
      params
    );
    return { items: result.rows };
  });

  app.post<{ Body: { projectId?: string; title?: string; startsAt?: string; status?: string; confidence?: number; remind24h?: boolean; remind1h?: boolean; sourceEvidenceId?: string } }>('/api/calendar', async (request, reply) => {
    const body = request.body ?? {};
    if (!body.projectId || !body.title || !body.startsAt) return reply.code(400).send({ error: 'invalid_request' });
    const result = await options.database.query(
      `insert into calendar_events (project_id, title, starts_at, status, confidence, remind_24h, remind_1h, source_evidence_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, project_id, title, starts_at, status, confidence, remind_24h, remind_1h, source_evidence_id, created_at, updated_at`,
      [body.projectId, body.title, body.startsAt, body.status ?? 'pending', body.confidence ?? null, body.remind24h ?? true, body.remind1h ?? true, body.sourceEvidenceId ?? null]
    );
    return { item: result.rows[0] };
  });

  app.patch<{ Params: { id: string }; Body: { status?: string; title?: string; startsAt?: string; remind24h?: boolean; remind1h?: boolean } }>('/api/calendar/:id', async (request, reply) => {
    const body = request.body ?? {};
    const result = await options.database.query(
      `update calendar_events set status = coalesce($2, status), title = coalesce($3, title), starts_at = coalesce($4, starts_at),
              remind_24h = coalesce($5, remind_24h), remind_1h = coalesce($6, remind_1h), updated_at = now()
       where id = $1 returning id, project_id, title, starts_at, status, confidence, remind_24h, remind_1h, source_evidence_id, created_at, updated_at`,
      [request.params.id, body.status ?? null, body.title ?? null, body.startsAt ?? null, body.remind24h ?? null, body.remind1h ?? null]
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'not_found' });
    return { item: result.rows[0] };
  });
}
