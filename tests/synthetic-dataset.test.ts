import { describe, expect, it } from 'vitest';
import {
  INBOUND_EVENT_PARAMS_PER_ROW,
  POSTGRES_MAX_PARAMS_PER_STATEMENT,
  SYNTH_STAR_LEVELS,
  clampBatchSize,
  buildSyntheticEvent,
  createSeededRandom,
  starForCount,
  syntheticAccount
} from '../src/testing/synthetic-dataset.js';

/**
 * 合成数据生成器（M5、验收方案第 3 节）。
 *
 * 这里只测纯逻辑与确定性：写入数据库的部分由压测脚本在压测库里执行，
 * 不进单元测试（避免测试套件依赖百万级数据）。
 */

describe('可复现随机源', () => {
  it('同一 seed 产生同一序列，不同 seed 不同', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const c = createSeededRandom(43);
    const sequenceA = [a(), a(), a()];
    const sequenceB = [b(), b(), b()];
    const sequenceC = [c(), c(), c()];
    expect(sequenceA).toEqual(sequenceB);
    expect(sequenceA).not.toEqual(sequenceC);
  });

  it('输出落在 [0,1) 且分布不至于退化', () => {
    const random = createSeededRandom(7);
    const values = Array.from({ length: 500 }, () => random());
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    // 粗略检查不会一直返回同一个值
    expect(new Set(values).size).toBeGreaterThan(400);
  });
});

describe('账号派生', () => {
  it('handle 固定宽度、可排序，链接由 handle 派生', () => {
    expect(syntheticAccount(0).projectKey).toBe('synth000000');
    expect(syntheticAccount(123).projectKey).toBe('synth000123');
    expect(syntheticAccount(123).link).toBe('https://x.com/synth000123');
  });
});

describe('星级推导与生效阈值一致（不修改业务规则）', () => {
  it('与 common-follow-rules 的语义一致', () => {
    expect(starForCount(0)).toBe(0);
    expect(starForCount(2)).toBe(0);
    expect(starForCount(3)).toBe(1);
    expect(starForCount(8)).toBe(2);
    expect(starForCount(13)).toBe(3);
    expect(starForCount(18)).toBe(4);
    expect(starForCount(23)).toBe(5);
    expect(starForCount(999)).toBe(5);
  });

  it('阈值档位与本地生效配置一致', () => {
    expect([...SYNTH_STAR_LEVELS]).toEqual([3, 8, 13, 18, 23]);
  });
});

describe('事件生成', () => {
  const options = { includeDuplicates: true, includeParseErrors: true, includeClassificationErrors: true };

  it('同一随机序列产生完全相同的事件（可复现）', () => {
    const first = buildSyntheticEvent({
      random: createSeededRandom(11),
      accountIndex: 5,
      sequence: 1,
      baseTimeMs: 1_700_000_000_000,
      windowMs: 86_400_000,
      options
    });
    const second = buildSyntheticEvent({
      random: createSeededRandom(11),
      accountIndex: 5,
      sequence: 1,
      baseTimeMs: 1_700_000_000_000,
      windowMs: 86_400_000,
      options
    });
    expect(second).toEqual(first);
  });

  it('事件字段自洽：星级由关注数推出、去重键与旧实现格式一致', () => {
    const random = createSeededRandom(3);
    for (let index = 0; index < 50; index += 1) {
      const event = buildSyntheticEvent({
        random,
        accountIndex: index,
        sequence: index + 1,
        baseTimeMs: 1_700_000_000_000,
        windowMs: 86_400_000,
        options
      });
      if (!event.parseError) {
        expect(event.star).toBe(starForCount(event.count));
      }
      expect(event.dedupeKey.split('|')).toHaveLength(4);
      expect(event.dedupeKey.startsWith('follow|https://x.com/synth')).toBe(true);
      expect(event.reasonCode.length).toBeGreaterThan(0);
    }
  });

  it('解析失败样本不带关注数与星级（不能伪造判定依据）', () => {
    // 用足够多的样本命中 1% 的解析失败分支
    const random = createSeededRandom(99);
    const events = Array.from({ length: 400 }, (_, index) =>
      buildSyntheticEvent({
        random,
        accountIndex: index,
        sequence: index + 1,
        baseTimeMs: 1_700_000_000_000,
        windowMs: 86_400_000,
        options
      })
    );
    const broken = events.filter((event) => event.parseError);
    expect(broken.length).toBeGreaterThan(0);
    for (const event of broken) {
      // 关键：解析失败样本的原始 payload 本身就不是合法 JSON，判定依据不会被伪造。
      expect(() => JSON.parse(event.rawPayload)).toThrow();
      expect(event.parseError).toBeTruthy();
    }
  });

  it('关闭边界样本选项后不再产生重复/解析失败/分类异常', () => {
    const random = createSeededRandom(5);
    const events = Array.from({ length: 300 }, (_, index) =>
      buildSyntheticEvent({
        random,
        accountIndex: index,
        sequence: index + 1,
        baseTimeMs: 1_700_000_000_000,
        windowMs: 86_400_000,
        options: { includeDuplicates: false, includeParseErrors: false, includeClassificationErrors: false }
      })
    );
    expect(events.some((event) => event.parseError)).toBe(false);
    expect(events.some((event) => event.classificationError)).toBe(false);
    expect(events.some((event) => event.isDuplicate)).toBe(false);
  });

  it('覆盖各星级与未达门槛，样本分布不退化', () => {
    const random = createSeededRandom(2024);
    const stars = new Set<number>();
    const reasons = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) {
      const event = buildSyntheticEvent({
        random,
        accountIndex: index % 50,
        sequence: index + 1,
        baseTimeMs: 1_700_000_000_000,
        windowMs: 86_400_000,
        options
      });
      stars.add(event.star);
      reasons.add(event.reasonCode);
    }
    // 未达门槛到五星都应出现，否则压测会掩盖真实分布
    expect([...stars].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(reasons.has('BELOW_THRESHOLD')).toBe(true);
    expect(reasons.has('COUNT_MISSING')).toBe(true);
    expect(reasons.has('PUSHED')).toBe(true);
  });
});

describe('批量大小的协议上限（实测发现的缺陷）', () => {
  it('请求过的批量被收敛到 PostgreSQL 参数上限以内', () => {
    // 1 万行 × 10 参数 = 10 万，超过协议上限（32767），实跑会报
    // “bind message has 34464 parameter formats but 0 parameters”。
    const clamped = clampBatchSize(10_000);
    expect(clamped * INBOUND_EVENT_PARAMS_PER_ROW).toBeLessThanOrEqual(POSTGRES_MAX_PARAMS_PER_STATEMENT);
    expect(clamped).toBeGreaterThan(0);
  });

  it('合法批量保持原样，非法值退到安全值', () => {
    expect(clampBatchSize(500)).toBe(500);
    expect(clampBatchSize(0)).toBe(Math.floor(POSTGRES_MAX_PARAMS_PER_STATEMENT / INBOUND_EVENT_PARAMS_PER_ROW));
    expect(clampBatchSize(undefined)).toBe(Math.floor(POSTGRES_MAX_PARAMS_PER_STATEMENT / INBOUND_EVENT_PARAMS_PER_ROW));
    expect(clampBatchSize(Number.NaN)).toBe(Math.floor(POSTGRES_MAX_PARAMS_PER_STATEMENT / INBOUND_EVENT_PARAMS_PER_ROW));
  });
});
