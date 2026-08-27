import { PGlite } from '@electric-sql/pglite';
import argon2 from 'argon2';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '@alpha-research/db';
import { buildApp } from '../src/app.js';

describe('access-key sessions', () => {
  const databases: PGlite[] = [];
  const apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it('creates an HttpOnly session cookie and protects API routes', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const app = await buildApp({
      database,
      accessKeyHash: await argon2.hash('correct-key'),
      hookSecret: 'hook-secret',
      allowedOrigin: 'https://private.example',
      secureCookies: true
    });
    apps.push(app);

    await expect(app.inject({ method: 'GET', url: '/api/session' })).resolves.toMatchObject({ statusCode: 401 });
    const login = await app.inject({
      method: 'POST',
      url: '/auth/access-key',
      headers: { origin: 'https://private.example' },
      payload: { accessKey: 'correct-key' }
    });
    expect(login.statusCode).toBe(204);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');

    const token = String(cookie).split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: token } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ authenticated: true });

    await expect(
      app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie: token, origin: 'https://private.example' }
      })
    ).resolves.toMatchObject({ statusCode: 204 });
    await expect(
      app.inject({ method: 'GET', url: '/api/session', headers: { cookie: token } })
    ).resolves.toMatchObject({ statusCode: 401 });
  });

  it('rate limits repeated invalid keys per IP', async () => {
    const database = new PGlite();
    databases.push(database);
    await migrateDatabase(database);
    const app = await buildApp({
      database,
      accessKeyHash: await argon2.hash('correct-key'),
      hookSecret: 'hook-secret',
      allowedOrigin: 'https://private.example',
      secureCookies: false
    });
    apps.push(app);

    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/access-key',
        headers: { origin: 'https://private.example', 'x-forwarded-for': '10.0.0.8' },
        payload: { accessKey: 'wrong-key' }
      });
      expect(response.statusCode).toBe(401);
    }
    await expect(
      app.inject({
        method: 'POST',
        url: '/auth/access-key',
        headers: { origin: 'https://private.example', 'x-forwarded-for': '10.0.0.8' },
        payload: { accessKey: 'correct-key' }
      })
    ).resolves.toMatchObject({ statusCode: 429 });
  });
});
