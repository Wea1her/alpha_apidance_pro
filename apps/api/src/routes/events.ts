import type { FastifyInstance } from 'fastify';
import type { ApiDatabase } from '../types.js';

export interface EventRoutesOptions { database: ApiDatabase; pollMs?: number; maxDurationMs?: number; }

export function registerEventRoute(app: FastifyInstance, options: EventRoutesOptions): void {
  app.get('/events', async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    let lastEventId = request.headers['last-event-id'] ?? '00000000-0000-0000-0000-000000000000';
    let active = true;
    const startedAt = Date.now();
    request.raw.on('close', () => { active = false; });
    const tick = async () => {
      if (!active || Date.now() - startedAt > (options.maxDurationMs ?? 25 * 60 * 1000)) {
        response.end();
        return;
      }
      const rows = await options.database.query<{ id: string; type: string; aggregate_type: string; aggregate_id: string; version: number }>(
        `select id, type, aggregate_type, aggregate_id, version
         from outbox_events where id > $1 order by created_at asc, id asc limit 50`,
        [lastEventId]
      );
      for (const row of rows.rows) {
        response.write(`id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify({ aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, version: row.version })}\n\n`);
        lastEventId = row.id;
      }
      if (active) {
        response.write(': keep-alive\n\n');
        setTimeout(tick, options.pollMs ?? 3000);
      }
    };
    await tick();
  });
}
