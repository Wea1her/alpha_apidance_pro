import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import { diffSnapshots, listConfigVersions, readCurrentConfigVersion, recordConfigVersion } from '../src/storage/config-repository.js';

/**
 * 配置版本仓储（Q38、Q102）集成测试：需要真实 PostgreSQL；不可用时跳过。
 */

let pool: StoragePool | null = null;
let available = false;

const BASE_CONFIG = {
  commonFollowStarLevels: [3, 8, 13, 18, 23],
  xaiModel: 'grok-4.3',
  deepAnalysis: { xaiModel: 'grok-4.20-multi-agent-0309' },
  xaiSearchTools: ['web_search', 'x_search'],
};

function itDb(name: string, fn: () => Promise<void>): void {
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
  await pool!.query('TRUNCATE config_versions, decisions, inbound_events RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  if (pool) await pool.close();
});

describe('配置版本记录', () => {
  itDb('首次记录生成版本，并标记为首次', async () => {
    const result = await recordConfigVersion(pool!, { config: BASE_CONFIG, effectiveAt: new Date('2026-09-14T00:00:00.000Z') });
    expect(result.created).toBe(true);
    expect(result.record.changedFields).toEqual(['（首次记录）']);
    expect(result.record.snapshot.starLevels).toEqual([3, 8, 13, 18, 23]);
    expect(result.record.snapshot.maxStar).toBe(5);
  });

  itDb('配置未变化时不产生新版本（幂等）', async () => {
    const first = await recordConfigVersion(pool!, { config: BASE_CONFIG });
    const second = await recordConfigVersion(pool!, { config: BASE_CONFIG });
    expect(second.created).toBe(false);
    expect(second.record.configVersionId).toBe(first.record.configVersionId);

    const rows = await pool!.query(`SELECT count(*)::int AS c FROM config_versions`);
    expect(rows.rows[0]?.c).toBe(1);
  });

  itDb('阈值变化产生新版本并给出差异字段', async () => {
    await recordConfigVersion(pool!, { config: BASE_CONFIG, effectiveAt: new Date('2026-09-14T00:00:00.000Z') });
    const changed = await recordConfigVersion(pool!, {
      config: { ...BASE_CONFIG, commonFollowStarLevels: [5, 8, 12, 15, 20] },
      effectiveAt: new Date('2026-09-14T01:00:00.000Z'),
    });
    expect(changed.created).toBe(true);
    // 阈值顺序变化会影响 starLevels 与 maxStar 两个字段
    expect(changed.record.changedFields).toContain('starLevels');
    expect(changed.record.snapshot.starLevels).toEqual([5, 8, 12, 15, 20]);
  });

  itDb('快照不含凭证字段', async () => {
    const result = await recordConfigVersion(pool!, {
      config: {
        ...BASE_CONFIG,
        ...({ alphaWalletPrivateKey: '0xdeadbeef', telegramBotToken: '123:abc', telegramChatId: '-100999' } as object),
      } as never,
    });
    const text = JSON.stringify(result.record.snapshot);
    for (const secret of ['0xdeadbeef', '123:abc', '-100999']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('配置变更时间线（Q102）', () => {
  itDb('倒序返回，并按相邻版本给出差异字段', async () => {
    await recordConfigVersion(pool!, { config: BASE_CONFIG, effectiveAt: new Date('2026-09-14T00:00:00.000Z') });
    await recordConfigVersion(pool!, {
      config: { ...BASE_CONFIG, xaiModel: 'grok-4.4' },
      effectiveAt: new Date('2026-09-14T02:00:00.000Z'),
    });

    const versions = await listConfigVersions(pool!);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.effectiveAt).toContain('2026-09-14');
    // 最新版本相对更早版本变化了模型字段
    const latestChanged = versions[0]!.changedFields;
    expect(latestChanged.length).toBeGreaterThan(0);
    // 最早版本前面没有可比较对象 → 显示为首次记录
    expect(versions[1]?.changedFields).toEqual(['（首次记录）']);
  });

  itDb('当前生效版本是最新记录，空库时为 null', async () => {
    expect(await readCurrentConfigVersion(pool!)).toBeNull();
    await recordConfigVersion(pool!, { config: BASE_CONFIG, effectiveAt: new Date('2026-09-14T00:00:00.000Z') });
    const newest = await recordConfigVersion(pool!, {
      config: { ...BASE_CONFIG, deepAnalysis: { xaiModel: 'grok-4.20-fast' } },
      effectiveAt: new Date('2026-09-15T00:00:00.000Z'),
    });
    const current = await readCurrentConfigVersion(pool!);
    expect(current?.configVersionId).toBe(newest.record.configVersionId);
  });
});

describe('快照差异比较', () => {
  it('首次记录与字段变化都被识别', () => {
    expect(diffSnapshots(null, { starLevels: [1], maxStar: 1 } as never)).toEqual(['（首次记录）']);
    const before = { starLevels: [1], maxStar: 1, classificationModel: 'a' } as never;
    const after = { starLevels: [2], maxStar: 1, classificationModel: 'a' } as never;
    expect(diffSnapshots(before, after)).toEqual(['starLevels']);
  });

  it('没有差异时返回空数组', () => {
    const snapshot = { starLevels: [1], maxStar: 1 } as never;
    expect(diffSnapshots(snapshot, snapshot)).toEqual([]);
  });
});
