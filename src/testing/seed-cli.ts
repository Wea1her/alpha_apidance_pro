import 'dotenv/config';
import { createStoragePool, resolveDatabaseUrl } from '../storage/client.js';
import { generateSyntheticDataset } from './synthetic-dataset.js';

/**
 * 合成数据入口：`npm run seed:synthetic -- --accounts=100000 --events=1000000`
 *
 * 直接使用 DATABASE_URL，并且**拒绝在非测试/压测库上执行**（脚本会写入大量数据）。
 */
function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const databaseUrl = resolveDatabaseUrl();
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL；合成数据需要指向隔离的压测库。');
  process.exit(1);
}
if (!/bench|test/i.test(databaseUrl)) {
  console.error('拒绝执行：DATABASE_URL 看起来不是测试/压测库（库名需含 test 或 bench）。');
  process.exit(1);
}

const pool = createStoragePool({ connectionString: databaseUrl, max: 8, applicationName: 'daxinjiankong-seed' });
let lastLogged = 0;
try {
  const summary = await generateSyntheticDataset(pool, {
    seed: Number(arg('seed', '42')),
    accounts: Number(arg('accounts', '100000')),
    events: Number(arg('events', '1000000')),
    days: Number(arg('days', '90')),
    batchSize: Number(arg('batch', '2000')),
    onProgress: ({ written, total }) => {
      const percent = Math.floor((written / total) * 100);
      if (percent >= lastLogged + 5) {
        lastLogged = percent;
        console.info(`进度 ${percent}%（${written}/${total}）`);
      }
    },
  });
  console.info(`合成数据完成：${JSON.stringify(summary)}`);
} catch (error) {
  console.error(`生成失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.close();
}
