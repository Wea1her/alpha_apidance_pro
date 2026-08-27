import type { FastifyInstance } from 'fastify';
import type { ApiDatabase } from '../types.js';

export function registerLedgerRoutes(app: FastifyInstance, options: { database: ApiDatabase }): void {
  app.get<{ Querystring: { projectId?: string } }>('/api/ledger', async (request) => {
    const projectId = request.query.projectId;
    const result = await options.database.query(
      `select id, project_id, type, status, amount_text, content, occurred_at, created_at, updated_at
       from ledger_entries ${projectId ? 'where project_id = $1' : ''} order by coalesce(occurred_at, created_at) desc limit 200`,
      projectId ? [projectId] : []
    );
    return { items: result.rows };
  });

  app.post<{ Body: { projectId?: string; type?: string; status?: string; amountText?: string; content?: string; occurredAt?: string } }>('/api/ledger', async (request, reply) => {
    const body = request.body ?? {};
    if (!body.projectId || !body.content || !body.type || !body.status) return reply.code(400).send({ error: 'invalid_request' });
    const result = await options.database.query(
      `insert into ledger_entries (project_id, type, status, amount_text, content, occurred_at)
       values ($1, $2, $3, $4, $5, $6) returning id, project_id, type, status, amount_text, content, occurred_at, created_at, updated_at`,
      [body.projectId, body.type, body.status, body.amountText ?? null, body.content, body.occurredAt ?? null]
    );
    return { item: result.rows[0] };
  });

  app.patch<{ Params: { id: string }; Body: { status?: string; content?: string; amountText?: string } }>('/api/ledger/:id', async (request, reply) => {
    const body = request.body ?? {};
    const result = await options.database.query(
      `update ledger_entries set status = coalesce($2, status), content = coalesce($3, content), amount_text = coalesce($4, amount_text), updated_at = now()
       where id = $1 returning id, project_id, type, status, amount_text, content, occurred_at, created_at, updated_at`,
      [request.params.id, body.status ?? null, body.content ?? null, body.amountText ?? null]
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'not_found' });
    return { item: result.rows[0] };
  });
}
