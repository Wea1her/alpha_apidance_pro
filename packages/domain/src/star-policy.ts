const DEFAULT_THRESHOLDS = [5, 8, 12, 15, 20] as const;

export interface StarPolicyOptions { thresholds?: readonly number[]; }

export function starForCommonFollowCount(count: number, options: StarPolicyOptions = {}): number {
  if (!Number.isInteger(count) || count < 0) return 0;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  let star = 0;
  for (const [index, threshold] of thresholds.entries()) if (count >= threshold) star = index + 1;
  return Math.min(5, star);
}

export function applyHistoricalStar(currentHighest: number, observedCount: number, options?: StarPolicyOptions): { highestStar: number; changed: boolean } {
  const highestStar = Math.max(currentHighest, starForCommonFollowCount(observedCount, options));
  return { highestStar, changed: highestStar > currentHighest };
}
