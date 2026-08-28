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
        occurredAt: '2026-08-27T03:00:00Z' as unknown as Date, content: '你关注的 12 个用户也关注了ta', payload: { follow_user: { id_str: '99', screen_name: 'fiatphobia', name: 'fiatphobiaX' } }
      } }
    });
    const events = await database.query<{ type: string; aggregate_type: string; aggregate_id: string }>('select type, aggregate_type, aggregate_id from outbox_events');
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ type: 'signal.created', aggregate_type: 'project' });
  });

  it('marks a project as surge after ten new common follows in thirty minutes', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const handler = createDecodeAlphaEventHandler(database);
    const start = new Date('2026-08-27T03:00:00.000Z');
    for (const [index, count] of [[0, 3], [1, 13]] as const) {
      const raw = await database.query<{ id: string }>(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', $1, '{}'::jsonb, 'pending') returning id`, [`surge-${index}`]);
      await handler({
        id: `job-surge-${index}`, type: 'decode_alpha_event', priority: 1, status: 'running', idempotencyKey: `decode:surge-${index}`,
        payload: { rawEventId: raw.rows[0].id, event: { type: 'common_follow', externalId: `surge-event-${index}`, xUserId: 'surge-user', handle: 'surge', commonFollowCount: count, occurredAt: new Date(start.getTime() + index * 15 * 60 * 1000), payload: { follow_user: { id_str: 'surge-user', screen_name: 'surge' } } } }
      });
    }
    const project = await database.query<{ surge_until: string | null }>(`select surge_until from projects where x_user_id = 'surge-user'`);
    expect(project.rows[0]?.surge_until).not.toBeNull();
  });

  it('synchronizes the current common-follow count while keeping star history non-decreasing', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const handler = createDecodeAlphaEventHandler(database);
    for (const [index, count] of [12, 8].entries()) {
      const raw = await database.query<{ id: string }>(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', $1, '{}'::jsonb, 'pending') returning id`, [`sync-count-${index}`]);
      await handler({
        id: `job-sync-count-${index}`, type: 'decode_alpha_event', priority: 1, status: 'running', idempotencyKey: `decode:sync-count-${index}`,
        payload: { rawEventId: raw.rows[0].id, event: { type: 'common_follow', externalId: `sync-count-event-${index}`, xUserId: 'sync-count-user', handle: 'sync_count', commonFollowCount: count, occurredAt: new Date(`2026-08-27T03:0${index}:00Z`), payload: { follow_user: { id_str: 'sync-count-user', screen_name: 'sync_count' } } } }
      });
    }
    const project = await database.query<{ current_common_follow_count: number; highest_common_follow_count: number; highest_star: number }>(
      `select current_common_follow_count, highest_common_follow_count, highest_star from projects where x_user_id = 'sync-count-user'`
    );
    expect(project.rows[0]).toMatchObject({ current_common_follow_count: 8, highest_common_follow_count: 12, highest_star: 3 });
  });

  it('does not materialize later Alpha pushes for an already excluded project', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, status, excluded_at, exclusion_reason) values ('excluded-user', 'excluded_project', 'excluded', now(), 'AI 初筛自动拦截：个人账号') returning id`);
    const raw = await database.query<{ id: string }>(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'excluded-later', '{}'::jsonb, 'pending') returning id`);
    await createDecodeAlphaEventHandler(database)({
      id: 'job-excluded-later', type: 'decode_alpha_event', priority: 1, status: 'running', idempotencyKey: 'decode:excluded-later',
      payload: { rawEventId: raw.rows[0].id, event: {
        type: 'common_follow', externalId: 'excluded-event', xUserId: 'excluded-user', handle: 'excluded_project', commonFollowCount: 18,
        occurredAt: new Date('2026-08-27T03:00:00Z'), content: '你关注的 18 个用户也关注了ta', payload: { follow_user: { id_str: 'excluded-user', screen_name: 'excluded_project' } }
      } }
    });
    const signals = await database.query<{ count: string }>('select count(*)::text as count from signals where project_id = $1', [project.rows[0].id]);
    const state = await database.query<{ status: string; exclusion_reason: string | null }>('select status, exclusion_reason from projects where id = $1', [project.rows[0].id]);
    const rawState = await database.query<{ decode_status: string }>('select decode_status from raw_events where id = $1', [raw.rows[0].id]);
    expect(signals.rows[0]?.count).toBe('0');
    expect(state.rows[0]).toMatchObject({ status: 'excluded', exclusion_reason: 'AI 初筛自动拦截：个人账号' });
    expect(rawState.rows[0]?.decode_status).toBe('decoded');
  });

  it('promotes an allowed project to trench and schedules its report at three stars', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, status, highest_star, highest_common_follow_count) values ('promote-user', 'promote_project', 'active', 2, 8) returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    const raw = await database.query<{ id: string }>(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'promote-raw', '{}'::jsonb, 'pending') returning id`);
    await createDecodeAlphaEventHandler(database)({
      id: 'job-promote', type: 'decode_alpha_event', priority: 1, status: 'running', idempotencyKey: 'decode:promote',
      payload: { rawEventId: raw.rows[0].id, event: {
        type: 'common_follow', externalId: 'promote-event', xUserId: 'promote-user', handle: 'promote_project', commonFollowCount: 12,
        occurredAt: new Date('2026-08-27T03:00:00Z'), payload: { follow_user: { id_str: 'promote-user', screen_name: 'promote_project' } }
      } }
    });
    const state = await database.query<{ status: string; highest_star: number }>('select status, highest_star from projects where id = $1', [project.rows[0].id]);
    const monitor = await database.query<{ desired_state: string }>('select desired_state from alpha_monitors where project_id = $1', [project.rows[0].id]);
    const research = await database.query<{ type: string; status: string }>(`select type, status from jobs where idempotency_key = $1`, [`research:${project.rows[0].id}`]);
    expect(state.rows[0]).toMatchObject({ status: 'trench', highest_star: 3 });
    expect(monitor.rows[0]?.desired_state).toBe('enabled');
    expect(research.rows[0]).toMatchObject({ type: 'research_project', status: 'queued' });
  });
});
