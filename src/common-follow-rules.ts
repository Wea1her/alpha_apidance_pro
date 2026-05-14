export const DEFAULT_COMMON_FOLLOW_STAR_LEVELS = [5, 8, 12, 15, 20] as const;

export interface CommonFollowDecision {
  shouldPush: boolean;
  star: number;
  count: number;
  stars: string;
}

export function formatStars(star: number): string {
  return '⭐'.repeat(Math.max(0, star));
}

export function parseStarLevels(raw: string | undefined): number[] {
  if (!raw || raw.trim().length === 0) {
    return [...DEFAULT_COMMON_FOLLOW_STAR_LEVELS];
  }

  const levels = raw.split(',').map((part) => {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error('COMMON_FOLLOW_STAR_LEVELS must contain only positive integers');
    }
    const value = Number.parseInt(trimmed, 10);
    if (value <= 0) {
      throw new Error('COMMON_FOLLOW_STAR_LEVELS must contain only positive integers');
    }
    return value;
  });

  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] <= levels[i - 1]) {
      throw new Error('COMMON_FOLLOW_STAR_LEVELS must be strictly ascending');
    }
  }

  return levels;
}

export function buildCommonFollowDecision(
  count: number,
  levels: readonly number[] = DEFAULT_COMMON_FOLLOW_STAR_LEVELS
): CommonFollowDecision {
  let star = 0;
  for (const [index, threshold] of levels.entries()) {
    if (count >= threshold) {
      star = index + 1;
    }
  }

  return {
    shouldPush: star > 0,
    star,
    count,
    stars: formatStars(star)
  };
}
