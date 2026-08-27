export interface OutboxDatabase {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface AppendOutboxEventInput {
  type: string;
  aggregateType: string;
  aggregateId: string;
  version: number;
  payload: unknown;
  idempotencyKey: string;
}

export interface OutboxEvent {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  version: number;
  payload: unknown;
}

interface OutboxRow {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  version: number;
  payload: unknown;
}

function toOutboxEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    type: row.type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    version: row.version,
    payload: row.payload
  };
}

export class OutboxStore {
  constructor(private readonly database: OutboxDatabase) {}

  async append(input: AppendOutboxEventInput): Promise<OutboxEvent> {
    const inserted = await this.database.query<OutboxRow>(
      `insert into outbox_events (
         type, aggregate_type, aggregate_id, version, payload, idempotency_key
       ) values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (idempotency_key) do nothing
       returning id, type, aggregate_type, aggregate_id, version, payload`,
      [
        input.type,
        input.aggregateType,
        input.aggregateId,
        input.version,
        JSON.stringify(input.payload),
        input.idempotencyKey
      ]
    );
    if (inserted.rows[0]) return toOutboxEvent(inserted.rows[0]);

    const existing = await this.database.query<OutboxRow>(
      `select id, type, aggregate_type, aggregate_id, version, payload
       from outbox_events
       where idempotency_key = $1`,
      [input.idempotencyKey]
    );
    if (!existing.rows[0]) {
      throw new Error(`Outbox event disappeared after idempotent append: ${input.idempotencyKey}`);
    }
    return toOutboxEvent(existing.rows[0]);
  }

  async listPending(consumer: string, limit = 100): Promise<OutboxEvent[]> {
    const result = await this.database.query<OutboxRow>(
      `select e.id, e.type, e.aggregate_type, e.aggregate_id, e.version, e.payload
       from outbox_events e
       left join outbox_deliveries d
         on d.outbox_event_id = e.id
        and d.consumer = $1
       where d.delivered_at is null
       order by e.created_at asc, e.id asc
       limit $2`,
      [consumer, limit]
    );
    return result.rows.map(toOutboxEvent);
  }

  async markDelivered(eventId: string, consumer: string, deliveredAt = new Date()): Promise<void> {
    await this.database.query(
      `insert into outbox_deliveries (
         outbox_event_id, consumer, delivered_at, attempts
       ) values ($1, $2, $3, 1)
       on conflict (outbox_event_id, consumer)
       do update set delivered_at = excluded.delivered_at,
                     attempts = outbox_deliveries.attempts + 1,
                     last_error = null`,
      [eventId, consumer, deliveredAt]
    );
  }
}
