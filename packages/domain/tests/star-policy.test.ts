import { describe, expect, it } from 'vitest';
import { applyHistoricalStar, starForCommonFollowCount } from '../src/star-policy.js';

describe('star policy', () => {
  it('maps configured thresholds and only moves upward', () => {
    expect(starForCommonFollowCount(12)).toBe(3);
    expect(applyHistoricalStar(3, 5)).toEqual({ highestStar: 3, changed: false });
  });
});
