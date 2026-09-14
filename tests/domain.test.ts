import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CLASSIFICATION_TYPES,
  CONTRACT_ADDRESS_REJECTIONS,
  EXCLUSION_REASONS,
  JOB_KINDS,
  JOB_STAGES,
  PROJECT_POOL_STATES,
  PROJECT_SOURCES,
  REASON_CODES,
  REASON_CODE_LABELS,
  isReasonCode,
  planRestoreTransition,
  type ReasonCode
} from '../shared/domain.js';

describe('领域原因码契约', () => {
  it('原因码唯一且都有中文说明', () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    for (const code of REASON_CODES) {
      const label = REASON_CODE_LABELS[code];
      expect(label, code).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
    }
    expect(Object.keys(REASON_CODE_LABELS).sort()).toEqual([...REASON_CODES].sort());
  });

  it('覆盖旧实现 processAlphaMessage 的每个提前返回点', () => {
    // 对应 src/service.ts 的判定链：解析失败、心跳、缺关注数、未达门槛、
    // 去重重复、并发在处理、星级未升高、分类拦截、分类异常放行、推送成功、推送失败。
    const legacyChain: ReasonCode[] = [
      'PARSE_ERROR',
      'HEARTBEAT',
      'COUNT_MISSING',
      'BELOW_THRESHOLD',
      'DEDUPE_REPEAT',
      'IN_FLIGHT',
      'STAR_NOT_INCREASED',
      'CLASSIFY_BLOCKED',
      'CLASSIFY_ERROR_ALLOWED',
      'CLASSIFY_ALLOWED',
      'PUSHED',
      'SEND_FAILED'
    ];
    for (const code of legacyChain) {
      expect(REASON_CODES, code).toContain(code);
    }
  });

  it('任务、报告与投递阶段的码都在全集内', () => {
    const phases: ReasonCode[] = [
      'ANALYSIS_QUEUED',
      'ANALYSIS_GENERATED',
      'DEEP_QUEUED',
      'DEEP_GENERATED',
      'DEPENDENCY_WAIT',
      'DELIVERY_PENDING',
      'DELIVERY_SENT',
      'DELIVERY_FAILED',
      'DELIVERY_UNCERTAIN',
      'EXCLUDED_BY_CLASSIFICATION',
      'EXCLUDED_MANUALLY',
      'RESTORED'
    ];
    for (const code of phases) {
      expect(REASON_CODES, code).toContain(code);
    }
  });

  it('isReasonCode 只接受枚举内的值', () => {
    expect(isReasonCode('PUSHED')).toBe(true);
    expect(isReasonCode('NOT_A_CODE')).toBe(false);
    expect(isReasonCode(undefined)).toBe(false);
    expect(isReasonCode(42)).toBe(false);
  });

  it('枚举值与分类类型、状态、来源、阶段保持一致', () => {
    expect(ACCOUNT_CLASSIFICATION_TYPES).toContain('MEDIA');
    expect(CONTRACT_ADDRESS_REJECTIONS).toContain('bad_checksum');
    expect(EXCLUSION_REASONS).toEqual(['classification', 'manual']);
    expect(PROJECT_POOL_STATES).toEqual(['monitored', 'excluded']);
    expect(PROJECT_SOURCES).toEqual(['natural', 'restored', 'history_import']);
    expect(JOB_KINDS).toContain('delivery');
    expect(JOB_STAGES).toContain('dead_letter');
  });
});

describe('恢复状态流转（Q132、Q136）', () => {
  it('已排除的项目可以恢复为监控中', () => {
    const result = planRestoreTransition('excluded', '2026-09-14T00:00:00.000Z', '误拦');
    expect(result).toMatchObject({
      transition: { from: 'excluded', to: 'monitored', reasonCode: 'RESTORED' },
      requiresReason: true
    });
  });

  it('监控中的项目不接受恢复操作', () => {
    expect(planRestoreTransition('monitored', '2026-09-14T00:00:00.000Z', null)).toEqual({ error: 'not_excluded' });
  });

  it('人工排除的恢复需要理由（Q136）', () => {
    const withReason = planRestoreTransition('excluded', '2026-09-14T00:00:00.000Z', '项目方已澄清');
    const withoutReason = planRestoreTransition('excluded', '2026-09-14T00:00:00.000Z', null);
    expect('transition' in withReason && withReason.requiresReason).toBe(true);
    expect('transition' in withoutReason && withoutReason.requiresReason).toBe(false);
  });
});
