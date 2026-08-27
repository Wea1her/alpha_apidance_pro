import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '@alpha-research/db';
import { createDecodeAlphaEventHandler } from '../src/handlers/decode-alpha-event.js';

describe('decode-alpha-event realtime notifications', () => {
  const databases: PGlite[] = [];
  afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

  it('publishes an outbox event after materializing an Alpha signal', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const raw = await database.query<{ id: string }>(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'realtime-raw', '{}'::jsonb, 'pending') returning id`);
    const handler = createDecodeAlphaEventHandler(database);
    await handler({
      id: 'job-realtime', type: 'decode_alpha_event', priority: 1, status: 'running', idempotencyKey: 'decode:realtime',
      payload: { rawEventId: raw.rows[0].id, event: {
        type: 'common_follow', externalId: 'evt-realtime', xUserId: '99', handle: 'fiatphobia', avatarUrl: 'https://pbs.twimg.com/profile_images/example.jpg', commonFollowCount: 12,
        occurredAt: new Date('2026-08-27T03:00:00Z'), content: '你关注的 12 个用户也关注了ta', payload: { follow_user: { id_str: '99', screen_name: 'fiatphobia', name: 'fiatphobiaX' } }
      } }
    });
    const events = await database.query<{ type: string; aggregate_type: string; aggregate_id: string }>('select type, aggregate_type, aggregate_id from outbox_events');
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ type: 'signal.created', aggregate_type: 'project' });
  });
});
