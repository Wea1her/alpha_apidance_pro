import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import {
  formatFaultDrillReport,
  runFaultDrills,
  drillF5TelegramUnavailable,
  drillF12F13ExternalErrors
} from '../src/testing/fault-drills.js';

/**
 * 故障注入演练（M5、验收方案第 4 节）集成测试。
 *
 * 这组测试的作用：把演练脚本本身也纳入回归——将来若解耦、退避或错误分类被改坏，
 * 演练会在 CI 里失败，而不是等到验收时才发现。
 */

let pool: StoragePool | null = null;
let available = false;

function itDrill(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available) return;
    await fn();
  });
}

beforeAll(async () => {
  pool = await openTestDatabase();
  available = pool !== null;
  if (available) await resetSchemaAndMigrate(pool!);
});

beforeEach(async () => {
  if (!available) return;
  await pool!.query(
    'TRUNCATE projects, jobs, reports, delivery_records, decisions, inbound_events, audit_records RESTART IDENTITY CASCADE'
  );
});

afterAll(async () => {
  if (pool) await pool.close();
});

describe('F5：Telegram 不可用不阻塞报告生成（Q5）', () => {
  itDrill('投递失败时报告仍生成并保存，投递单独等待', async () => {
    const result = await drillF5TelegramUnavailable(pool!);
    expect(result.status).toBe('passed');
    expect(result.observed).toMatchObject({
      jobSucceeded: 1,
      reportSaved: true,
      jobStage: 'succeeded',
      deliverySent: false,
      deliveryAbandoned: false,
      secondRoundGenerated: 0,
      bodyUnchanged: true
    });
  });

  itDrill('失败时给出具体原因，便于页面解释', async () => {
    const result = await drillF5TelegramUnavailable(pool!);
    expect(result.notes).toEqual([]);
    expect(result.observed.deliveryFailed).toBe(1);
  });
});

describe('F12/F13：模型侧错误分类', () => {
  itDrill('鉴权失效进入失败态、记录原因、不产生半成品报告', async () => {
    const [auth] = await drillF12F13ExternalErrors(pool!);
    expect(auth?.status).toBe('passed');
    expect(auth?.observed).toMatchObject({
      jobsFailed: 1,
      stage: 'failed',
      reportCreated: false,
      scheduledRetry: true
    });
    expect(String(auth?.observed.lastError)).toContain('401');
  });

  itDrill('429 进入退避重试，投递不直接放弃也不误告警', async () => {
    const results = await drillF12F13ExternalErrors(pool!);
    const throttle = results.find((item) => item.id === 'F13');
    expect(throttle?.status).toBe('passed');
    expect(throttle?.observed).toMatchObject({
      stage: 'failed',
      scheduledRetry: true,
      deliveryAbandoned: false,
      deliveryRetryScheduled: true,
      deliveryShouldAlert: false
    });
  });
});

describe('完整演练', () => {
  itDrill('无失败场景，且跳过项都带原因说明', async () => {
    const report = await runFaultDrills(pool!);
    expect(report.failed).toBe(0);
    // 兜底注入的场景必须给出原因，不能静默跳过
    for (const result of report.results.filter((item) => item.status === 'skipped')) {
      expect(result.notes.join('').length).toBeGreaterThan(0);
    }
    // 关键场景必须在“已执行”而不是“跳过”里
    const executed = new Set(report.results.filter((item) => item.status === 'passed').map((item) => item.id));
    for (const id of ['F1', 'F3', 'F4', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12', 'F13']) {
      expect(executed, id).toContain(id);
    }
  });

  itDrill('报告明确区分通过与跳过', async () => {
    const report = await runFaultDrills(pool!);
    const markdown = formatFaultDrillReport(report);
    expect(markdown).toContain('跳过不等于通过');
    expect(markdown).toContain('F5');
  });
});
