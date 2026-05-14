import { describe, expect, it } from 'vitest';
import {
  calculateReceiveLatencyMs,
  extractCommonFollowCount,
  extractPushAtMs,
  formatCommonFollowDecisionMessage,
  formatReceiveLatencyMessage
} from '../src/alpha-event.js';
import { buildCommonFollowDecision } from '../src/common-follow-rules.js';

describe('extractCommonFollowCount', () => {
  it('reads common follow count from common fields', () => {
    expect(extractCommonFollowCount({ commonFollowCount: 8 })).toBe(8);
    expect(extractCommonFollowCount({ common_follow_count: 12 })).toBe(12);
    expect(extractCommonFollowCount({ common_follows_count: '15' })).toBe(15);
  });

  it('reads common follow count from nested data', () => {
    expect(extractCommonFollowCount({ data: { commonFollowCount: 20 } })).toBe(20);
  });

  it('reads common follow count from alpha Chinese content text', () => {
    expect(
      extractCommonFollowCount({
        content: '用户简介:...\n你关注的20个用户也关注了ta'
      })
    ).toBe(20);
  });

  it('returns null when the message does not include a count', () => {
    expect(extractCommonFollowCount({ title: 'new follow' })).toBeNull();
  });
});

describe('extractPushAtMs', () => {
  it('converts alpha second timestamps to milliseconds', () => {
    expect(extractPushAtMs({ push_at: 1778659735 })).toBe(1778659735000);
  });

  it('keeps millisecond timestamps unchanged', () => {
    expect(extractPushAtMs({ push_at: 1778659735123 })).toBe(1778659735123);
  });

  it('returns null when push_at is missing', () => {
    expect(extractPushAtMs({ title: 'new follow' })).toBeNull();
  });
});

describe('calculateReceiveLatencyMs', () => {
  it('calculates the difference between local receive time and alpha push_at', () => {
    expect(calculateReceiveLatencyMs({ push_at: 1778659735 }, new Date(1778659736234))).toBe(1234);
  });
});

describe('formatReceiveLatencyMessage', () => {
  it('formats latency in seconds', () => {
    expect(formatReceiveLatencyMessage({ push_at: 1778659735 }, new Date(1778659736234))).toContain(
      '估算延迟：1.234 秒'
    );
  });
});

describe('formatCommonFollowDecisionMessage', () => {
  it('formats pushable decisions with stars', () => {
    expect(formatCommonFollowDecisionMessage(buildCommonFollowDecision(8))).toBe(
      '监控池关注数：8，重要程度：⭐⭐'
    );
  });

  it('formats non-pushable decisions', () => {
    expect(formatCommonFollowDecisionMessage(buildCommonFollowDecision(4))).toBe(
      '监控池关注数：4，未达到推送阈值'
    );
  });
});
