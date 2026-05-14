import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMON_FOLLOW_STAR_LEVELS,
  buildCommonFollowDecision,
  formatStars,
  parseStarLevels
} from '../src/common-follow-rules.js';

describe('buildCommonFollowDecision', () => {
  it('does not push when count is below 5', () => {
    expect(buildCommonFollowDecision(4)).toEqual({
      shouldPush: false,
      star: 0,
      count: 4,
      stars: ''
    });
  });

  it('maps common follow counts to the configured star levels', () => {
    expect(buildCommonFollowDecision(5).star).toBe(1);
    expect(buildCommonFollowDecision(7).star).toBe(1);
    expect(buildCommonFollowDecision(8).star).toBe(2);
    expect(buildCommonFollowDecision(11).star).toBe(2);
    expect(buildCommonFollowDecision(12).star).toBe(3);
    expect(buildCommonFollowDecision(14).star).toBe(3);
    expect(buildCommonFollowDecision(15).star).toBe(4);
    expect(buildCommonFollowDecision(19).star).toBe(4);
    expect(buildCommonFollowDecision(20).star).toBe(5);
    expect(buildCommonFollowDecision(100).star).toBe(5);
  });

  it('marks every count above the first threshold as pushable', () => {
    expect(buildCommonFollowDecision(5).shouldPush).toBe(true);
    expect(buildCommonFollowDecision(20).shouldPush).toBe(true);
  });
});

describe('parseStarLevels', () => {
  it('parses ascending comma-separated levels', () => {
    expect(parseStarLevels('5,8,12,15,20')).toEqual(DEFAULT_COMMON_FOLLOW_STAR_LEVELS);
  });

  it('rejects invalid levels', () => {
    expect(() => parseStarLevels('5,8,8')).toThrow('COMMON_FOLLOW_STAR_LEVELS must be strictly ascending');
    expect(() => parseStarLevels('5,abc')).toThrow('COMMON_FOLLOW_STAR_LEVELS must contain only positive integers');
  });
});

describe('formatStars', () => {
  it('formats star count for messages', () => {
    expect(formatStars(0)).toBe('');
    expect(formatStars(3)).toBe('⭐⭐⭐');
  });
});
