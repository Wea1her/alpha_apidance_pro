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
  parseAlphaMessage
} from './alpha-client.js';
import {
  extractCommonFollowCount,
  formatCommonFollowDecisionMessage,
  formatReceiveLatencyMessage
} from './alpha-event.js';
import {
  buildCommonFollowDecision,
  parseStarLevels
} from './common-follow-rules.js';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function listenSeconds(): number {
  const raw = process.env.ALPHA_LISTEN_SECONDS?.trim();
  if (!raw) return 120;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('ALPHA_LISTEN_SECONDS must be a positive integer');
  }
  return parsed;
}

async function main(): Promise<void> {
  const wallet = new Wallet(requireEnv('ALPHA_WALLET_PRIVATE_KEY'));
  const baseUrl = process.env.ALPHA_BASE_URL?.trim() || DEFAULT_ALPHA_BASE_URL;
  const wsBaseUrl = process.env.ALPHA_WS_BASE_URL?.trim() || DEFAULT_ALPHA_WS_BASE_URL;
  const starLevels = parseStarLevels(process.env.COMMON_FOLLOW_STAR_LEVELS);

  console.log(`alpha wallet: ${wallet.address}`);
  console.log('signing alpha login message...');

  const payload = await createAlphaLoginPayload(wallet.address, (message) => wallet.signMessage(message));
  const token = await loginAlpha({ baseUrl, payload });
  const wsUrl = buildAlphaWsUrl(wsBaseUrl, token);
  const timeoutMs = listenSeconds() * 1000;

  console.log(`login ok, connecting websocket for ${Math.round(timeoutMs / 1000)}s...`);

  const socket = new WebSocket(wsUrl);
  const timeout = setTimeout(() => {
    console.log('listen timeout reached, closing websocket');
    socket.close(1000, 'test complete');
  }, timeoutMs);

  socket.on('open', () => {
    console.log('alpha websocket connected');
  });

  socket.on('message', (data) => {
    const receivedAt = new Date();
    const raw = data.toString();
    try {
      const message = parseAlphaMessage(raw);
      if (isAlphaHeartbeat(message)) {
        console.log(`[heartbeat] ${new Date().toISOString()}`);
        return;
      }
      console.log('[alpha event]');
      console.log(`本地收到时间：${receivedAt.toISOString()}`);
      console.log(formatReceiveLatencyMessage(message, receivedAt));
      console.log(JSON.stringify(message, null, 2));
      const count = extractCommonFollowCount(message);
      if (count === null) {
        console.log('未在事件中识别到监控池关注数，暂不执行星级判断');
        return;
      }
      const decision = buildCommonFollowDecision(count, starLevels);
      console.log(formatCommonFollowDecisionMessage(decision));
    } catch (error) {
      console.log('[alpha raw message]');
      console.log(raw);
      console.warn(error instanceof Error ? error.message : String(error));
    }
  });

  socket.on('close', (code, reason) => {
    clearTimeout(timeout);
    console.log(`alpha websocket closed: ${code} ${reason.toString()}`);
  });

  socket.on('error', (error) => {
    clearTimeout(timeout);
    console.error(`alpha websocket error: ${error.message}`);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
