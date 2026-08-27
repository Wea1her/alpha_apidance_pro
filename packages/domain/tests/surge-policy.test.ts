import { describe, expect, it } from 'vitest';
import { evaluateSurge } from '../src/surge-policy.js';

describe('surge policy', () => {
  it('requires a comparable baseline and marks a six-hour surge', () => {
    const start = new Date('2026-08-26T00:00:00Z');
    expect(evaluateSurge([{ occurredAt: start, count: 20, dedupeKey: 'a' }], start)).toMatchObject({ triggered: false });
    const now = new Date('2026-08-26T00:30:00Z');
    const result = evaluateSurge([
      { occurredAt: start, count: 3, dedupeKey: 'a' },
      { occurredAt: now, count: 13, dedupeKey: 'b' }
    ], now);
    expect(result).toMatchObject({ triggered: true, baselineCount: 3, peakCount: 13, triggeredAt: now });
    expect(result.expiresAt?.getTime()).toBe(now.getTime() + 6 * 60 * 60 * 1000);
  });

  it('does not trigger when ten new follows occur outside the thirty-minute window', () => {
    const now = new Date('2026-08-26T01:00:00Z');
    expect(evaluateSurge([
      { occurredAt: new Date('2026-08-26T00:29:00Z'), count: 3, dedupeKey: 'a' },
      { occurredAt: now, count: 13, dedupeKey: 'b' }
    ], now)).toMatchObject({ triggered: false });
  });
});
