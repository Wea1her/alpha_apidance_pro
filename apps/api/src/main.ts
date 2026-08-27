import 'dotenv/config';
import { createPostgresDatabase, migrateDatabase } from '@alpha-research/db';
import { buildApp } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
const accessKeyHash = process.env.ACCESS_KEY_HASH;
const alphaHookSecret = process.env.ALPHA_HOOK_SECRET;

if (!databaseUrl || !accessKeyHash || !alphaHookSecret) {
  throw new Error('DATABASE_URL, ACCESS_KEY_HASH and ALPHA_HOOK_SECRET are required');
}

const database = createPostgresDatabase(databaseUrl);
await migrateDatabase(database);
const secureCookies = process.env.SECURE_COOKIES === 'true' || (process.env.SECURE_COOKIES !== 'false' && process.env.NODE_ENV !== 'development');
const app = await buildApp({
  database,
  accessKeyHash,
  hookSecret: alphaHookSecret,
  allowedOrigin: process.env.APP_ORIGIN,
  secureCookies,
  logger: true
});
app.addHook('onClose', async () => database.close());

const port = Number.parseInt(process.env.API_PORT ?? '3000', 10);
await app.listen({ host: process.env.API_HOST ?? '0.0.0.0', port });
