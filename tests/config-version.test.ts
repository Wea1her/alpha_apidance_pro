import { describe, expect, it } from 'vitest';
import {
  buildConfigVersionSnapshot,
  canonicalJson,
  configSnapshotsEqual,
  hashConfigSnapshot,
  planConfigVersion
} from '../shared/config-version.js';

const baseInput = {
  commonFollowStarLevels: [3, 8, 13, 18, 23],
  xaiModel: 'grok-4.3',
  deepAnalysis: { xaiModel: 'grok-4.20-multi-agent-0309' },
  xaiSearchTools: ['x_search', 'web_search'],
  deepAnalysisSearchTools: ['web_search']
};

describe('配置版本快照', () => {
  it('记录实际生效的阈值与模型，而不是代码默认值', () => {
    const snapshot = buildConfigVersionSnapshot(baseInput);
    expect(snapshot.starLevels).toEqual([3, 8, 13, 18, 23]);
    expect(snapshot.maxStar).toBe(5);
    expect(snapshot.classificationModel).toBe('grok-4.3');
    expect(snapshot.deepModel).toBe('grok-4.20-multi-agent-0309');
    expect(snapshot.searchTools).toEqual(['web_search', 'x_search']);
  });

  it('并发与时限使用已确认初值作为兜底', () => {
    const snapshot = buildConfigVersionSnapshot(baseInput);
    expect(snapshot.classificationConcurrency).toBe(2);
    expect(snapshot.standardConcurrency).toBe(2);
    expect(snapshot.deepConcurrency).toBe(1);
    expect(snapshot.requestTimeoutMs).toEqual({ classification: 60_000, standard: 180_000, deep: 600_000 });
    expect(snapshot.telegramRetryAttempts).toBe(20);
  });

  it('不包含敏感字段（凭据、路径、聊天 ID）', () => {
    const snapshot = buildConfigVersionSnapshot({
      ...baseInput,
      // 故意传入多余字段，白名单必须把它们全部丢弃。
      ...({ alphaWalletPrivateKey: '0xdeadbeef', telegramBotToken: '123:abc', telegramChatId: '-100999', proxyUrl: 'http://user:pass@host' } as object)
    } as never);
    const text = JSON.stringify(snapshot);
    for (const secret of ['0xdeadbeef', '123:abc', '-100999', 'user:pass']) {
      expect(text).not.toContain(secret);
    }
  });

  it('同一配置的哈希稳定，工具集合顺序不影响结果', () => {
    const a = buildConfigVersionSnapshot(baseInput);
    const b = buildConfigVersionSnapshot({ ...baseInput, xaiSearchTools: ['web_search', 'x_search'] });
    expect(hashConfigSnapshot(a)).toBe(hashConfigSnapshot(b));
    expect(configSnapshotsEqual(a, b)).toBe(true);
  });

  it('阈值或模型变化会产生不同哈希', () => {
    const a = buildConfigVersionSnapshot(baseInput);
    const changedThreshold = buildConfigVersionSnapshot({ ...baseInput, commonFollowStarLevels: [5, 8, 12, 15, 20] });
    const changedModel = buildConfigVersionSnapshot({ ...baseInput, deepAnalysis: { xaiModel: 'grok-4.20-fast' } });
    expect(hashConfigSnapshot(a)).not.toBe(hashConfigSnapshot(changedThreshold));
    expect(hashConfigSnapshot(a)).not.toBe(hashConfigSnapshot(changedModel));
  });

  it('canonicalJson 对键顺序不敏感但对数组顺序敏感', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('配置版本记录生成', () => {
  const snapshot = buildConfigVersionSnapshot(baseInput);

  it('首次生成建立新版本', () => {
    const result = planConfigVersion(snapshot, {
      previous: null,
      effectiveAt: '2026-09-14T00:00:00.000Z',
      newId: () => 'cfg-1'
    });
    expect('record' in result && result.record.configVersionId).toBe('cfg-1');
    expect('record' in result && result.record.effectiveAt).toBe('2026-09-14T00:00:00.000Z');
  });

  it('配置未变化时沿用既有版本号，不产生新版本', () => {
    const first = planConfigVersion(snapshot, { previous: null, effectiveAt: 't0', newId: () => 'cfg-1' });
    const hash = 'record' in first ? first.record.hash : '';
    const second = planConfigVersion(snapshot, {
      previous: { hash, configVersionId: 'cfg-1' },
      effectiveAt: 't1',
      newId: () => 'cfg-2'
    });
    expect('unchanged' in second && second.unchanged).toBe(true);
    expect('unchanged' in second && second.configVersionId).toBe('cfg-1');
  });

  it('配置变化时生成新版本', () => {
    const first = planConfigVersion(snapshot, { previous: null, effectiveAt: 't0', newId: () => 'cfg-1' });
    const hash = 'record' in first ? first.record.hash : '';
    const changed = buildConfigVersionSnapshot({ ...baseInput, commonFollowStarLevels: [5, 8, 12, 15, 20] });
    const second = planConfigVersion(changed, {
      previous: { hash, configVersionId: 'cfg-1' },
      effectiveAt: 't2',
      newId: () => 'cfg-2'
    });
    expect('record' in second && second.record.configVersionId).toBe('cfg-2');
    expect('record' in second && second.record.hash).not.toBe(hash);
  });
});
