import 'dotenv/config';
import { Wallet } from 'ethers';
import WebSocket from 'ws';
import {
  DEFAULT_ALPHA_BASE_URL,
  DEFAULT_ALPHA_WS_BASE_URL,
  buildAlphaWsUrl,
  createAlphaLoginPayload,
  isAlphaHeartbeat,
  loginAlpha,
  parseAlphaMessage,
} from '../alpha-client.js';
import { createStoragePool } from '../storage/client.js';
import { handleInboundEvent, buildInboundEventId } from './inbound-pipeline.js';
import { recordConfigVersion } from '../storage/config-repository.js';

/**
 * 实时桥接（演示/影子用）：上游 Alpha WebSocket → 新栈流水线 → 数据库 → 前端轮询可见。
 *
 * 与旧 worker 的关键差异：
 * - **不发送 Telegram、不调用模型**：投递实现固定失败（记 SEND_FAILED），分类器不注入。
 *   这样它只做“接收 → 记录 → 判定 → 落库”，不会产生任何外部副作用或付费调用（Q32、Q87）。
 * - 因此它可以安全地作为影子期的新栈采集路径运行：旧 worker 继续做唯一业务执行者。
 *
 * 用法：`npm run bridge:alpha -- --db=<连接串> --seconds=90 --force`
 *
 * ⚠️ **危险：这条命令会接管生产事件流**（2026-09-14 实测）
 *
 * 实测记录：同一钱包开第二条 WebSocket 连接后，**业务事件只会投递给最近一次登录的连接**，
 * 而心跳对旧连接仍然照常广播。后果是——旧 worker 进程健康、心跳正常、日志没有报错，
 * 但**业务推送会静默停止**。
 *
 * 证据：
 * - 连接①（较早登录）监听 576s：心跳 19 次，业务事件 **0**；
 * - 同一时段新登录的连接②监听 45s：业务事件 **1**（“A8猪脚饭 关注了 Roger|Bluebird🕊️”）。
 *
 * 因此本脚本**默认拒绝运行**，必须显式传 `--force`。
 * 影子期的正确做法是让**旧 worker 旁路写本地 sink**、新栈消费 sink（架构文档 Q32-B），
 * 而不是再连一次上游——那样会抢走生产推送。
 */

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = arg('db', process.env.BRIDGE_DB_URL ?? '');
if (!databaseUrl) {
  console.error('缺少目标库：用 --db=<连接串> 或 BRIDGE_DB_URL 指定（必须是演示/测试库）');
  process.exit(1);
}
if (!/bench|test|demo|real/i.test(databaseUrl)) {
  console.error('拒绝执行：目标库名需包含 bench/test/demo/real，避免误写生产库。');
  process.exit(1);
}

if (!process.argv.includes('--force')) {
  console.error(
    [
      '',
      '════════════════════════════════════════════════════════════════',
      ' 已拒绝执行：这条桥接会登录上游，并可能“接管”生产 worker 的事件流。',
      '',
      ' 实测结论（2026-09-14）：同一钱包的第二条连接会让业务事件只投给最近登录的',
      ' 那条连接，而心跳对旧连接照常广播——也就是说旧 worker 看起来完全正常，',
      ' 但业务推送会静默停止。',
      '',
      ' 影子期请改用“旧 worker 旁路写本地 sink、新栈消费 sink”的方式（架构文档 Q32-B）。',
      ' 若你确认当前没有生产连接在跑（例如停机窗口内），再加 --force 执行。',
      '════════════════════════════════════════════════════════════════',
      '',
    ].join('\n')
  );
  process.exit(3);
}

const seconds = Number(arg('seconds', '90'));
const starLevels = [3, 8, 13, 18, 23];
const collectorId = `bridge-${Date.now().toString(36)}`;

const pool = createStoragePool({ connectionString: databaseUrl, max: 4, applicationName: 'djk-alpha-bridge' });
// 配置版本：让判定记录能引用“当时生效的规则”（Q38）。
const configVersion = await recordConfigVersion(pool, {
  config: {
    commonFollowStarLevels: starLevels,
    xaiModel: 'not-configured-in-bridge',
    xaiSearchTools: [],
  },
  effectiveAt: new Date(),
});
console.log(`目标库: ${databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
console.log(`配置版本: ${configVersion.record.configVersionId}`);

const wallet = new Wallet(requireEnv('ALPHA_WALLET_PRIVATE_KEY'));
const baseUrl = process.env.ALPHA_BASE_URL?.trim() || DEFAULT_ALPHA_BASE_URL;
const wsBaseUrl = process.env.ALPHA_WS_BASE_URL?.trim() || DEFAULT_ALPHA_WS_BASE_URL;

console.log(`钱包地址: ${wallet.address}`);
console.warn('⚠️  正在以 --force 连接上游：若生产 worker 同时在线，它可能收不到业务事件。');
let token: string;
try {
  const payload = await createAlphaLoginPayload(wallet.address, (message) => wallet.signMessage(message));
  token = await loginAlpha({ baseUrl, payload });
  console.log('上游登录成功，准备连接 WebSocket');
} catch (error) {
  console.error(`上游登录失败（可能网络不可达或凭据失效）：${error instanceof Error ? error.message : String(error)}`);
  await pool.close();
  process.exit(2);
}

const socket = new WebSocket(buildAlphaWsUrl(wsBaseUrl, token));
let ingestSeq = 0;
let businessEvents = 0;
let heartbeats = 0;
const reasonCounts: Record<string, number> = {};

const startedAt = Date.now();
const closing = new Promise<void>((resolve) => {
  const timer = setTimeout(() => {
    console.log(`监听 ${seconds}s 结束，关闭连接`);
    socket.close(1000, 'bridge window complete');
    resolve();
  }, seconds * 1000);

  socket.on('close', (code, reason) => {
    clearTimeout(timer);
    console.log(`WebSocket 关闭：${code} ${reason.toString()}`);
    resolve();
  });
  socket.on('error', (error) => {
    console.error(`WebSocket 错误：${error.message}`);
    clearTimeout(timer);
    resolve();
  });
});

socket.on('open', () => console.log('WebSocket 已连接'));

socket.on('message', (data) => {
  void (async () => {
    const receivedAt = new Date();
    const raw = data.toString();
    let message: Record<string, unknown>;
    try {
      message = parseAlphaMessage(raw);
    } catch {
      // 非 JSON 消息也值得记录（解析失败是页面要解释的一类事实）
      ingestSeq += 1;
      const result = await handleInboundEvent({
        pool,
        collectorId,
        ingestSeq,
        raw,
        receivedAt: receivedAt.toISOString(),
        starLevels,
        configVersionId: configVersion.record.configVersionId,
      });
      reasonCounts[result.reasonCode] = (reasonCounts[result.reasonCode] ?? 0) + 1;
      return;
    }

    if (isAlphaHeartbeat(message)) {
      heartbeats += 1;
      return;
    }

    businessEvents += 1;
    ingestSeq += 1;
    const title = typeof message.title === 'string' ? message.title : '';
    console.log(
      `[业务事件 ${businessEvents}] seq=${ingestSeq} ${receivedAt.toISOString()} link=${String(message.link ?? '-')} title=${title.slice(0, 50)}`
    );

    try {
      const result = await handleInboundEvent({
        pool,
        collectorId,
        ingestSeq,
        raw,
        receivedAt: receivedAt.toISOString(),
        starLevels,
        configVersionId: configVersion.record.configVersionId,
        // 桥接不注入分类器：只验证“接收 → 判定 → 落库”这条链路。
        // 投递实现固定失败：桥接不产生任何外部副作用，失败原因也会如实记录。
        send: async () => {
          throw new Error('桥接模式未启用 Telegram 投递');
        },
      });
      reasonCounts[result.reasonCode] = (reasonCounts[result.reasonCode] ?? 0) + 1;
      const outcome = result.outcome;
      console.log(
        `  → 原因码 ${result.reasonCode}；项目 ${result.projectId ?? '(无)'}；判定 ${result.decisionId ?? '(重复)'}` +
          (outcome
            ? `；关注数 ${outcome.count ?? '未识别'}；星级 ${outcome.previousStar}→${outcome.star}`
            : '')
      );
    } catch (error) {
      console.error(`  处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  })();
});

await closing;
socket.terminate();

const elapsedMs = Date.now() - startedAt;
const counts = await pool.query(
  `SELECT (SELECT count(*)::int FROM inbound_events WHERE collector_id = $1) AS events,
          (SELECT count(*)::int FROM decisions d JOIN inbound_events e ON e.event_id = d.event_id WHERE e.collector_id = $1) AS decisions,
          (SELECT count(*)::int FROM projects WHERE last_event_at IS NOT NULL) AS projects_with_events`,
  [collectorId]
);

console.log('--- 桥接结果 ---');
console.log(`监听时长 ${(elapsedMs / 1000).toFixed(1)}s；心跳 ${heartbeats}；业务事件 ${businessEvents}`);
console.log(`落库：接收记录 ${counts.rows[0]?.events}、判定 ${counts.rows[0]?.decisions}；有事件的项目 ${counts.rows[0]?.projects_with_events}`);
console.log(`原因码分布：${JSON.stringify(reasonCounts)}`);
console.log(`事件 ID 前缀：${buildInboundEventId(collectorId, 1)}（便于在页面里检索）`);
await pool.close();
