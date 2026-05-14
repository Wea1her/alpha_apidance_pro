import type { CommonFollowDecision } from './common-follow-rules.js';

const COUNT_FIELD_NAMES = [
  'commonFollowCount',
  'common_follow_count',
  'common_follows_count',
  'commonCount',
  'common_count'
];

const COMMON_FOLLOW_TEXT_RE = /你关注的\s*(\d+)\s*个用户也关注了ta/;

function toCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

export function extractCommonFollowCount(message: Record<string, unknown>): number | null {
  for (const field of COUNT_FIELD_NAMES) {
    const count = toCount(message[field]);
    if (count !== null) return count;
  }

  const data = message.data;
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    for (const field of COUNT_FIELD_NAMES) {
      const count = toCount((data as Record<string, unknown>)[field]);
      if (count !== null) return count;
    }
  }

  const content = message.content;
  if (typeof content === 'string') {
    const matched = content.match(COMMON_FOLLOW_TEXT_RE);
    if (matched) {
      return Number.parseInt(matched[1], 10);
    }
  }

  return null;
}

export function formatCommonFollowDecisionMessage(decision: CommonFollowDecision): string {
  if (!decision.shouldPush) {
    return `监控池关注数：${decision.count}，未达到推送阈值`;
  }
  return `监控池关注数：${decision.count}，重要程度：${decision.stars}`;
}

export function extractPushAtMs(message: Record<string, unknown>): number | null {
  const raw = message.push_at;
  const value = toCount(raw);
  if (value === null) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

export function calculateReceiveLatencyMs(
  message: Record<string, unknown>,
  receivedAt: Date
): number | null {
  const pushAtMs = extractPushAtMs(message);
  if (pushAtMs === null) return null;
  return receivedAt.getTime() - pushAtMs;
}

export function formatReceiveLatencyMessage(
  message: Record<string, unknown>,
  receivedAt: Date
): string {
  const latencyMs = calculateReceiveLatencyMs(message, receivedAt);
  if (latencyMs === null) {
    return '估算延迟：缺少 push_at，无法计算';
  }
  return `估算延迟：${(latencyMs / 1000).toFixed(3)} 秒`;
}
