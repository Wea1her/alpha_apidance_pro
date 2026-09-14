import 'dotenv/config';
import { createStoragePool, resolveDatabaseUrl } from '../storage/client.js';
import { describeWorkerLoop, runWorkerCycle } from './loop.js';

/**
 * Worker 常驻入口：`npm run worker:start`
 *
 * 职责（M2/M5）：
 * - 领取并执行生成任务（含租约回收）；
 * - 处理待投递；
 * - 按间隔执行保留期清理。
 *
 * 本入口**不接 Alpha WebSocket、不接 Telegram**：那是旧 worker 的职责。
 * 影子阶段的正确做法是让旧 worker 继续做唯一业务执行者，本 worker 只处理新库里的任务，
 * 并由 `src/service-decision-sink.ts` 收集对比证据（Q32、Q38）。
 */

const databaseUrl = resolveDatabaseUrl();
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL，worker 无法启动。');
  process.exit(1);
}

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 5_000);
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000);
const batchSize = Number(process.env.CLEANUP_BATCH_SIZE ?? 2_000);
const owner = process.env.WORKER_OWNER ?? `worker-${process.pid}`;

const pool = createStoragePool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10) });

let stopping = false;
let lastCleanupAt: Date | null = null;
let lastCycleAt: Date | null = null;
let cycles = 0;
let consecutiveErrors = 0;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.info(`收到 ${signal}，将在本轮结束后退出…`);
    stopping = true;
  });
}

console.info(`worker 启动：owner=${owner}，轮询间隔 ${intervalMs}ms，清理间隔 ${cleanupIntervalMs}ms`);

while (!stopping) {
  const cycle = await runWorkerCycle({
    pool,
    owner,
    executor: {
      // 影子阶段的默认行为：**不产生任何外部副作用**（Q32、Q87）。
      // 只有显式设置 TELEGRAM_DELIVERY_ENABLED=true 时才会真正发送。
      send: async (delivery, reportBody) => {
        if (process.env.TELEGRAM_DELIVERY_ENABLED !== 'true') {
          throw new Error('投递未启用（影子模式）：设置 TELEGRAM_DELIVERY_ENABLED=true 才会真正发送');
        }
        const { sendTelegramMessage } = await import('../telegram.js');
        const result = await sendTelegramMessage({
          botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
          chatId: delivery.targetChatId ?? process.env.TELEGRAM_CHAT_ID ?? '',
          text: reportBody ?? '（空正文）',
        });
        return { chatId: result.chatId, messageId: result.messageId };
      },
    },
    ...(lastCleanupAt ? { lastCleanupAt } : {}),
    cleanupIntervalMs,
    cleanup: { batchSize },
    warn: (message) => console.warn(message),
  });
  cycles += 1;
  lastCycleAt = new Date(cycle.finishedAt);
  if (cycle.cleanupAt) lastCleanupAt = cycle.cleanupAt;
  consecutiveErrors = cycle.errors.length > 0 ? consecutiveErrors + 1 : 0;

  const summary = describeWorkerLoop({ cycles, lastCycleAt, lastCleanupAt, consecutiveErrors, cleanupIntervalMs });
  console.info(
    `[${new Date().toISOString()}] 任务 领取 ${cycle.executor.jobsClaimed} 完成 ${cycle.executor.jobsSucceeded} ` +
      `失败 ${cycle.executor.jobsFailed}；投递 发送 ${cycle.executor.deliveriesSent} 失败 ${cycle.executor.deliveriesFailed}；` +
      `清理 ${cycle.cleanupSkipped ? '未到间隔' : cycle.cleanup ? `删除 ${cycle.cleanup.deletedEvents} 条${cycle.cleanup.hasMore ? '（还有剩余）' : ''}` : '失败'}；` +
      `清理滞后=${summary.cleanupStale}`
  );

  if (!stopping) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

await pool.close();
console.info(`worker 已退出（共 ${cycles} 轮）。`);
