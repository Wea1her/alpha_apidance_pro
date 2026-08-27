import 'dotenv/config';
import { createPostgresDatabase } from './client.js';
import { migrateDatabase } from './migrate.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const database = createPostgresDatabase(databaseUrl);
try {
  await migrateDatabase(database);
  console.info('数据库迁移完成');
} finally {
  await database.close();
}
