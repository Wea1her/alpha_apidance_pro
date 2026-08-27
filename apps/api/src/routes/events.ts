import type { FastifyInstance } from 'fastify';
import type { ApiDatabase } from '../types.js';

export interface EventRoutesOptions { database: ApiDatabase; pollMs?: number; maxDurationMs?: number; }

function formatCursorTimestamp(value: string): string {
  // Keep sub-millisecond precision while emitting a stable ISO-like value.
  // PostgreSQL's US format always has six fractional digits; trim only the
  // insignificant trailing zeroes, retaining at least millisecond precision.
  const match = value.match(/^(.*\.)(\d{6})(Z)$/);
  if (!match) return value;
  const fraction = match[2].replace(/0+$/, '').padEnd(3, '0');
  return `${match[1]}${fraction}${match[3]}`;
}

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
    const rawCursor = request.headers['last-event-id'];
    let cursorCreatedAt = new Date(0).toISOString();
    let cursorId = '00000000-0000-0000-0000-000000000000';
    if (typeof rawCursor === 'string' && rawCursor.includes('|')) {
      const separator = rawCursor.indexOf('|');
      // Keep the timestamp text as-is. Normalising through Date would truncate
      // PostgreSQL's microsecond precision and make the same event appear on
      // every poll when it falls between two millisecond boundaries.
      const rawTimestamp = rawCursor.slice(0, separator);
      const parsedDate = new Date(rawTimestamp);
      if (!Number.isNaN(parsedDate.getTime())) cursorCreatedAt = rawTimestamp;
      cursorId = rawCursor.slice(separator + 1) || cursorId;
    }
    let active = true;
    const startedAt = Date.now();
    request.raw.on('close', () => { active = false; });
    const tick = async () => {
      if (!active || Date.now() - startedAt > (options.maxDurationMs ?? 25 * 60 * 1000)) {
        response.end();
        return;
      }
      const rows = await options.database.query<{ id: string; type: string; aggregate_type: string; aggregate_id: string; version: number; created_at: string }>(
        `select id, type, aggregate_type, version, aggregate_id,
                to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
         from outbox_events
         where (created_at, id) > ($1::timestamptz, $2::uuid)
         order by created_at asc, id asc limit 50`,
        [cursorCreatedAt, cursorId]
      );
      for (const row of rows.rows) {
        // Format the timestamp without going through a JavaScript Date (which
        // would truncate microseconds) so the lexicographic cursor is lossless.
        const timestamp = formatCursorTimestamp(row.created_at);
        const eventCursor = `${timestamp}|${row.id}`;
        // Keep the default "message" event so the browser's onmessage handler
        // receives every domain event without needing one listener per type.
        response.write(`id: ${eventCursor}\ndata: ${JSON.stringify({ type: row.type, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, version: row.version })}\n\n`);
        cursorCreatedAt = timestamp;
        cursorId = row.id;
      }
      if (active) {
        response.write(': keep-alive\n\n');
        setTimeout(tick, options.pollMs ?? 1000);
      }
    };
    await tick();
  });
}
