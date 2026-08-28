import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '@alpha-research/db';
import { registerProjectRoutes } from '../src/routes/projects.js';

describe('project tweet history route', () => {
  const databases: PGlite[] = [];
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });

  it('hides tweets before three-star trench state and exposes Alpha tweets in trench', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, status, highest_star) values ('tweet-user', 'tweet_project', 'active', 2) returning id`);
    await database.query(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'tweet-route-raw', '{}'::jsonb, 'decoded')`);
    const raw = await database.query<{ id: string }>('select id from raw_events limit 1');
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, x_post_url, content, data) values ($1, $2, 'tweet-user', 'new_tweet', now(), 'https://x.com/tweet_project/status/1', 'testnet soon', '{}'::jsonb)`, [raw.rows[0].id, project.rows[0].id]);
    await database.query(`insert into alpha_monitors (project_id, alpha_user_id, tweet_enabled, desired_state, actual_state) values ($1, 'alpha-user', true, 'enabled', 'enabled')`, [project.rows[0].id]);
    const app = Fastify(); apps.push(app); registerProjectRoutes(app, { database }); await app.ready();
    const before = await app.inject({ method: 'GET', url: `/api/projects/${project.rows[0].id}/tweets` });
    expect(before.json()).toEqual({ items: [] });
    await database.query(`update projects set status = 'trench', highest_star = 3 where id = $1`, [project.rows[0].id]);
    const after = await app.inject({ method: 'GET', url: `/api/projects/${project.rows[0].id}/tweets` });
    expect(after.statusCode).toBe(200);
    expect(after.json<{ items: Array<{ type: string; content: string }> }>().items).toMatchObject([{ type: 'new_tweet', content: 'testnet soon' }]);
  });

  it('filters the signal stream by an exact historical star level', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    await database.query(`insert into projects (x_user_id, current_handle, status, highest_star) values ('star-1', 'one', 'active', 1), ('star-2', 'two', 'active', 2), ('star-3', 'three', 'trench', 3)`);
    const projects = await database.query<{ id: string; current_handle: string }>(`select id, current_handle from projects where x_user_id like 'star-%' order by current_handle`);
    for (const project of projects.rows) await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.id]);
    const app = Fastify(); apps.push(app); registerProjectRoutes(app, { database }); await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/projects?filter=star_2' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: Array<{ handle: string }> }>().items.map((item) => item.handle)).toEqual(['two']);
  });

  it('sorts projects inside a star category by common-follow count instead of push time', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    await database.query(`
      insert into projects (x_user_id, current_handle, status, highest_star, highest_common_follow_count, current_common_follow_count, updated_at)
      values ('sort-low', 'sort_low', 'active', 2, 5, 5, now()),
             ('sort-high', 'sort_high', 'active', 2, 12, 12, now() - interval '2 hours'),
             ('sort-mid', 'sort_mid', 'active', 2, 8, 8, now() - interval '1 hour')
    `);
    await database.query(`
      insert into screening_decisions (project_id, decision, account_type, reason)
      select id, 'allowed', 'PROJECT', '项目账号' from projects where x_user_id like 'sort-%'
    `);
    const app = Fastify(); apps.push(app); registerProjectRoutes(app, { database }); await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/projects?filter=star_2&limit=all' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: Array<{ handle: string }> }>().items.map((item) => item.handle)).toEqual(['sort_high', 'sort_mid', 'sort_low']);
  });

  it('returns the complete approved pool when limit=all', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    await database.query(`
      insert into projects (x_user_id, current_handle, status, highest_star)
      select 'all-' || n::text, 'all_project_' || n::text, 'active', 1
      from generate_series(1, 1005) as n
    `);
    await database.query(`
      insert into screening_decisions (project_id, decision, account_type, reason)
      select id, 'allowed', 'PROJECT', '项目账号' from projects where x_user_id like 'all-%'
    `);
    const app = Fastify(); apps.push(app); registerProjectRoutes(app, { database }); await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/projects?filter=all&limit=all' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: Array<{ handle: string }> }>().items).toHaveLength(1005);

    const numericResponse = await app.inject({ method: 'GET', url: '/api/projects?filter=all&limit=2000' });
    expect(numericResponse.statusCode).toBe(200);
    expect(numericResponse.json<{ items: Array<{ handle: string }> }>().items).toHaveLength(1005);
  });

  it('defensively hides institutional account types from the approved pool', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    await database.query(`
      insert into projects (x_user_id, current_handle, status)
      values ('entity-chain', 'chain_official', 'active'), ('entity-exchange', 'exchange_official', 'active'),
             ('entity-foundation', 'foundation_official', 'active'), ('entity-affiliate', 'affiliate_official', 'active'),
             ('entity-project', 'early_project', 'active')
    `);
    await database.query(`
      insert into screening_decisions (project_id, decision, account_type, reason)
      select id, 'allowed',
        case current_handle
          when 'chain_official' then 'CHAIN'
          when 'exchange_official' then 'EXCHANGE'
          when 'foundation_official' then 'FOUNDATION'
          when 'affiliate_official' then 'AFFILIATE'
          else 'PROJECT'
        end,
        '测试分类'
      from projects where x_user_id like 'entity-%'
    `);
    const app = Fastify(); apps.push(app); registerProjectRoutes(app, { database }); await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/projects?filter=all&limit=all' });
    expect(response.json<{ items: Array<{ handle: string }> }>().items.map((item) => item.handle)).toEqual(['early_project']);
  });

  it('classifies launchpad projects separately from DeFi', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name, status, highest_star) values ('launchpad-user', 'launchpad_xyz', 'Launchpad XYZ', 'active', 2) returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '发射台项目')`, [project.rows[0].id]);
    const raw = await database.query<{ id: string }>(`insert into raw_events (source, dedupe_key, payload, decode_status) values ('alpha_hook', 'launchpad-raw', '{}'::jsonb, 'decoded') returning id`);
    await database.query(`insert into signals (raw_event_id, project_id, x_user_id, type, occurred_at, content, data) values ($1, $2, 'launchpad-user', 'profile_change', now(), 'Launchpad token launcher with swap integrations', '{}'::jsonb)`, [raw.rows[0].id, project.rows[0].id]);
    const app = Fastify(); apps.push(app); registerProjectRoutes(app, { database }); await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/projects?filter=all&limit=all' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: Array<{ handle: string; playbookCategory: string }> }>().items.find((item) => item.handle === 'launchpad_xyz')?.playbookCategory).toBe('Launchpad');
  });

  it('classifies every .fun account ID as Launchpad', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, display_name, status) values ('fun-user', 'rocket.fun', 'Rocket Swap', 'active') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '发射台项目')`, [project.rows[0].id]);
    const app = Fastify(); apps.push(app); registerProjectRoutes(app, { database }); await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/projects?filter=all&limit=all' });
    expect(response.json<{ items: Array<{ handle: string; playbookCategory: string }> }>().items.find((item) => item.handle === 'rocket.fun')?.playbookCategory).toBe('Launchpad');
  });
});
