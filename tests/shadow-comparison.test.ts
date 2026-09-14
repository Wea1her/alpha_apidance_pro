import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLASSIFICATION_THRESHOLD,
  alignmentKeyToString,
  compareShadowSamples,
  dedupeKeyPushAt,
  evaluateShadowAcceptance,
  formatShadowReport,
  isExcludedSample,
  legacyAlignmentKey,
  newSystemAlignmentKey,
  type LegacySinkRecord,
  type NewSystemDecisionRecord
} from '../src/testing/shadow-comparison.js';

/**
 * 影子对比（Q30-Q43、Q57）纯逻辑测试。
 *
 * 重点验证三件事：
 * 1) 对齐键用（归一化账号 + 上游秒级时间），不依赖上游消息 ID；
 * 2) 星级与去重是硬门槛，任何差异都阻断；
 * 3) 分类差异率的分母是“旧系统实际分类过的样本”，且重启窗口/合成样本被排除。
 */

function legacy(overrides: Partial<LegacySinkRecord> = {}): LegacySinkRecord {
  return {
    reasonCode: 'PUSHED',
    receivedAt: '2026-09-14T00:00:01.000Z',
    projectKey: 'projecta',
    dedupeKey: 'follow|https://x.com/projecta|Alice 关注了 A|1789000000',
    star: 1,
    previousStar: 0,
    count: 5,
    classification: { type: 'PROJECT', confidence: 0.9, reason: '项目方', error: null },
    ...overrides
  };
}

function next(overrides: Partial<NewSystemDecisionRecord> = {}): NewSystemDecisionRecord {
  return {
    decisionId: 'dec-1',
    projectKey: 'projecta',
    reasonCode: 'CLASSIFY_ALLOWED',
    decidedAt: '2026-09-14T00:00:02.000Z',
    upstreamPushAtSec: 1_789_000_000,
    star: 1,
    previousStar: 0,
    count: 5,
    classificationType: 'PROJECT',
    classificationConfidence: 0.88,
    classificationError: null,
    ...overrides
  };
}

describe('对齐键（Q31）', () => {
  it('从旧去重键里取上游秒级时间', () => {
    expect(dedupeKeyPushAt('follow|https://x.com/a|t|1789000000')).toBe(1_789_000_000);
    expect(dedupeKeyPushAt('follow|https://x.com/a|t|')).toBeNull();
    expect(dedupeKeyPushAt('broken')).toBeNull();
    expect(dedupeKeyPushAt(null)).toBeNull();
  });

  it('旧记录没有去重键时退到接收时间，并在键里体现账号', () => {
    const key = legacyAlignmentKey(legacy({ dedupeKey: null, receivedAt: '2026-09-14T00:00:01.000Z' }));
    expect(key).toEqual({ projectKey: 'projecta', pushAtSec: Math.floor(Date.parse('2026-09-14T00:00:01.000Z') / 1000) });
  });

  it('缺少账号的样本无法对齐', () => {
    expect(legacyAlignmentKey(legacy({ projectKey: null }))).toBeNull();
    expect(newSystemAlignmentKey(next({ projectKey: null }))).toBeNull();
    expect(newSystemAlignmentKey(next({ upstreamPushAtSec: null }))).toBeNull();
  });

  it('新系统侧要求上游时间存在，不允许用本地时间顶替', () => {
    expect(newSystemAlignmentKey(next({ upstreamPushAtSec: null }))).toBeNull();
    expect(newSystemAlignmentKey(next())).toEqual({ projectKey: 'projecta', pushAtSec: 1_789_000_000 });
    expect(alignmentKeyToString({ projectKey: 'a', pushAtSec: 1 })).toBe('a@1');
  });
});

describe('样本排除（Q39、Q57）', () => {
  it('重启窗口内的样本被排除', () => {
    expect(isExcludedSample({ restartedInWindow: true })).toEqual({ excluded: true, reason: 'restart_window' });
  });

  it('合成样本默认排除，显式允许时才纳入', () => {
    expect(isExcludedSample({ sampleSource: 'synthetic' })).toEqual({ excluded: true, reason: 'synthetic' });
    expect(isExcludedSample({ sampleSource: 'synthetic', includeSynthetic: true }).excluded).toBe(false);
  });

  it('真实流量样本默认纳入', () => {
    expect(isExcludedSample({ sampleSource: 'live' })).toEqual({ excluded: false, reason: null });
  });
});

describe('对比：完全一致', () => {
  it('同一事件在两侧判定一致时没有差异', () => {
    const report = compareShadowSamples([legacy()], [next()]);
    expect(report).toMatchObject({ legacyTotal: 1, newTotal: 1, matched: 1, legacyOnly: 0, newOnly: 0 });
    expect(report.starMismatches).toEqual([]);
    expect(report.dedupeMismatches).toEqual([]);
    expect(report.classificationMismatches).toEqual([]);
    expect(report.classificationDenominator).toBe(1);
  });

  it('分类置信度不同不算差异（模型不可复现，只比类型）', () => {
    const report = compareShadowSamples([legacy()], [next({ classificationConfidence: 0.51 })]);
    expect(report.classificationMismatches).toEqual([]);
  });
});

describe('对比：确定性维度的硬门槛', () => {
  it('星级不一致被记录为差异', () => {
    const report = compareShadowSamples([legacy({ star: 2 })], [next({ star: 1 })]);
    expect(report.starMismatches).toHaveLength(1);
    expect(report.starMismatches[0]).toMatchObject({ dimension: 'star', legacy: '2', next: '1', projectKey: 'projecta' });
  });

  it('未达门槛（star 为 null/0）与 1 星视为不同，不混淆', () => {
    const report = compareShadowSamples([legacy({ star: null, reasonCode: 'BELOW_THRESHOLD' })], [next({ star: 1 })]);
    expect(report.starMismatches[0]).toMatchObject({ legacy: '0', next: '1' });
  });

  it('去重结论按“是否被跳过”比较：不同原因码表达同一结论不算差异', () => {
    const report = compareShadowSamples(
      [legacy({ reasonCode: 'DEDUPE_REPEAT' })],
      [next({ reasonCode: 'STAR_NOT_INCREASED' })]
    );
    expect(report.dedupeMismatches).toEqual([]);
  });

  it('一方判为重复、另一方放行时记录去重差异', () => {
    const report = compareShadowSamples([legacy({ reasonCode: 'DEDUPE_REPEAT' })], [next({ reasonCode: 'PUSHED' })]);
    expect(report.dedupeMismatches).toHaveLength(1);
    expect(report.dedupeMismatches[0]).toMatchObject({ legacy: 'repeated', next: 'passed' });
  });
});

describe('对比：分类差异率的分母（Q36）', () => {
  it('分母只算旧系统实际分类过的样本；交集外不参与', () => {
    // 旧系统只对第二条分类过（第一条是未达门槛，没有分类结论）
    const legacyRecords = [
      legacy({ dedupeKey: 'follow|l|t|100', star: 0, reasonCode: 'BELOW_THRESHOLD', classification: null }),
      legacy({ dedupeKey: 'follow|l|t|200', star: 1 })
    ];
    const newRecords = [
      next({ upstreamPushAtSec: 100, star: 0, reasonCode: 'BELOW_THRESHOLD', classificationType: null }),
      next({ upstreamPushAtSec: 200, star: 1, classificationType: 'KOL' })
    ];
    const report = compareShadowSamples(legacyRecords, newRecords);
    expect(report.matched).toBe(2);
    // 只有第二条进入分母
    expect(report.classificationDenominator).toBe(1);
    expect(report.classificationMismatches).toHaveLength(1);
    expect(report.classificationMismatchRate).toBe(1);
  });

  it('分类调用异常单独记为 classify_error，与类型不同区分开', () => {
    const report = compareShadowSamples(
      [legacy({ classification: { type: null, confidence: null, reason: null, error: 'timeout' } })],
      [next({ classificationType: null, classificationError: 'timeout' })]
    );
    // 两侧都是异常 → 结论一致，不算差异
    expect(report.classificationMismatches).toEqual([]);
  });
});

describe('对比：对齐缺口与排除样本', () => {
  it('统计仅旧系统有与仅新系统有', () => {
    const legacyRecords = [legacy({ dedupeKey: 'follow|l|t|100' }), legacy({ dedupeKey: 'follow|l|t|999' })];
    const newRecords = [next({ upstreamPushAtSec: 100 }), next({ upstreamPushAtSec: 777 })];
    const report = compareShadowSamples(legacyRecords, newRecords);
    expect(report).toMatchObject({ matched: 1, legacyOnly: 1, newOnly: 1 });
  });

  it('重启窗口样本被排除且计入 excluded', () => {
    const report = compareShadowSamples(
      [legacy({ restartedInWindow: true }), legacy({ dedupeKey: 'follow|l|t|100' })],
      [next({ upstreamPushAtSec: 100 })]
    );
    expect(report.excludedLegacy).toBe(1);
    expect(report.matched).toBe(1);
  });

  it('缺账号或时间的样本不计入样本总数（无法对齐）', () => {
    const report = compareShadowSamples([legacy({ projectKey: null })], [next({ upstreamPushAtSec: null })]);
    expect(report).toMatchObject({ legacyTotal: 0, newTotal: 0, matched: 0 });
  });

  it('同一对齐键重复出现时只保留一条（重复样本本身由去重维度表达）', () => {
    const report = compareShadowSamples([legacy(), legacy()], [next()]);
    expect(report.legacyTotal).toBe(1);
    expect(report.matched).toBe(1);
  });
});

describe('验收判定（Q16、Q33-D）', () => {
  it('确定性维度有差异即阻断', () => {
    const report = compareShadowSamples([legacy({ star: 2 })], [next({ star: 1 })]);
    const acceptance = evaluateShadowAcceptance(report);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.blockers.join()).toContain('星级判定');
  });

  it('分类差异率超过阈值即阻断，未超过则通过', () => {
    // 10 个样本中有 1 个分类不同 → 10% > 默认 2%
    const legacyRecords = Array.from({ length: 10 }, (_, index) =>
      legacy({ dedupeKey: `follow|l|t|${1000 + index}` })
    );
    const newRecords = Array.from({ length: 10 }, (_, index) =>
      next({ upstreamPushAtSec: 1000 + index, classificationType: index === 0 ? 'KOL' : 'PROJECT' })
    );
    const over = evaluateShadowAcceptance(compareShadowSamples(legacyRecords, newRecords));
    expect(over.passed).toBe(false);
    expect(over.blockers.join()).toContain('分类差异率');

    const under = evaluateShadowAcceptance(compareShadowSamples(legacyRecords, newRecords), { threshold: 0.2 });
    expect(under.passed).toBe(true);
  });

  it('样本量不足与对齐缺口只给提示，不冒充通过', () => {
    const report = compareShadowSamples([legacy()], [next()]);
    const acceptance = evaluateShadowAcceptance(report, { minMatched: 100 });
    expect(acceptance.passed).toBe(true);
    expect(acceptance.warnings.join()).toContain('样本量');
  });

  it('默认阈值与已确认的 2% 一致', () => {
    expect(DEFAULT_CLASSIFICATION_THRESHOLD).toBe(0.02);
  });
});

describe('报告格式化', () => {
  it('包含分母口径说明与结论行', () => {
    const report = compareShadowSamples([legacy()], [next()]);
    const markdown = formatShadowReport(report, evaluateShadowAcceptance(report));
    expect(markdown).toContain('影子对比报告');
    expect(markdown).toContain('分母 = 旧系统实际分类过的样本数');
    expect(markdown).toContain('通过');
  });

  it('未通过时在报告里列出阻断原因', () => {
    const report = compareShadowSamples([legacy({ star: 5 })], [next({ star: 1 })]);
    const markdown = formatShadowReport(report, evaluateShadowAcceptance(report));
    expect(markdown).toContain('未通过');
    expect(markdown).toContain('阻断');
  });
});

describe('旧系统 sink 落盘（Q38-D、Q42）', () => {
  it('写入 JSONL 并带上样本来源与重启标记', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createDecisionSink } = await import('../src/service-decision-sink.js');

    const directory = await mkdtemp(join(tmpdir(), 'djk-sink-'));
    const filePath = join(directory, 'nested', 'decisions.jsonl');
    const sink = createDecisionSink({ filePath, isRestartWindow: () => true, sampleSource: 'live' });

    await sink({
      reasonCode: 'BELOW_THRESHOLD',
      raw: '{"channel":"follow"}',
      receivedAt: '2026-09-14T00:00:00.000Z',
      projectKey: 'projecta',
      dedupeKey: 'follow|l|t|1789000000',
      star: 0,
      previousStar: 0,
      count: 2
    });
    await sink({
      reasonCode: 'PUSHED',
      raw: '{"channel":"follow"}',
      receivedAt: '2026-09-14T00:00:01.000Z',
      projectKey: 'projecta',
      dedupeKey: 'follow|l|t|1789000100',
      star: 1,
      previousStar: 0,
      count: 5
    });

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({
      reasonCode: 'BELOW_THRESHOLD',
      sampleSource: 'live',
      restartedInWindow: true,
      projectKey: 'projecta'
    });
    expect(typeof first.recordedAt).toBe('string');
  });

  it('写入失败时只回调错误，不抛给业务链路', async () => {
    const { createDecisionSink } = await import('../src/service-decision-sink.js');
    const errors: unknown[] = [];
    // 用一个必然失败的目标：路径含 NUL 字节，文件系统会直接拒绝。
    const sink = createDecisionSink({ filePath: 'invalid path/x.jsonl', onError: (error) => errors.push(error) });
    await expect(
      sink({
        reasonCode: 'HEARTBEAT',
        raw: '{}',
        receivedAt: '2026-09-14T00:00:00.000Z',
        projectKey: null,
        dedupeKey: null,
        star: null,
        previousStar: null,
        count: null
      })
    ).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
  });
});
