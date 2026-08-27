import { createHash } from 'node:crypto';

export type AlphaSignalType =
  | 'heartbeat'
  | 'common_follow'
  | 'new_tweet'
  | 'ca'
  | 'profile_change'
  | 'unknown';

export interface DecodedAlphaEvent {
  type: AlphaSignalType;
  externalId?: string;
  xUserId?: string;
  handle?: string;
  avatarUrl?: string;
  commonFollowCount?: number;
  xPostUrl?: string;
  content?: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

const COMMON_FOLLOW_PATTERN = /你关注的\s*(\d+)\s*个用户也关注了ta/i;
const CONTRACT_PATTERN = /\b0x[a-fA-F0-9]{40}\b/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function nestedData(record: Record<string, unknown>): Record<string, unknown> {
  return asRecord(record.data) ?? {};
}

function nestedRecord(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = asRecord(record[key]);
    if (value) return value;
  }
  const data = nestedData(record);
  for (const key of keys) {
    const value = asRecord(data[key]);
    if (value) return value;
  }
  return undefined;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return firstString(record, keys) ?? firstString(nestedData(record), keys);
}

function readCount(record: Record<string, unknown>): number | undefined {
  const raw = readString(record, [
    'commonFollowCount',
    'common_follow_count',
    'common_follows_count',
    'commonCount',
    'common_count'
  ]);
  if (raw && /^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return undefined;
}

function parseOccurredAt(record: Record<string, unknown>): Date {
  const value = readString(record, ['occurred_at', 'occurredAt', 'push_at', 'timestamp', 'created_at']);
  if (!value) return new Date();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function handleFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(parsed.hostname)) return undefined;
    const firstPath = parsed.pathname.split('/').filter(Boolean)[0];
    return firstPath && firstPath !== 'i' ? firstPath : undefined;
  } catch {
    return undefined;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])])
  );
}

export function decodeAlphaWebhook(input: unknown): DecodedAlphaEvent {
  const record = asRecord(input);
  if (!record) throw new Error('Alpha Hook payload must be an object');

  const followUser = nestedRecord(record, ['follow_user', 'followUser', 'target_user', 'targetUser']);
  const tweet = nestedRecord(record, ['tweet', 'status', 'post']);
  const typeHint = (readString(record, ['type', 'event', 'channel', 'push_type', 'pushType']) ?? '').toLowerCase();
  const content = readString(record, ['content', 'text', 'message', 'body']) ?? firstString(tweet ?? {}, ['content', 'full_text', 'text', 'message', 'body']);
  const xPostUrl = readString(record, ['x_post_url', 'post_url', 'tweet_url', 'link', 'url']) ?? firstString(tweet ?? {}, ['x_post_url', 'post_url', 'tweet_url', 'url', 'link']);
  const commonFollowCount = readCount(record) ?? (content?.match(COMMON_FOLLOW_PATTERN)
    ? Number.parseInt(content.match(COMMON_FOLLOW_PATTERN)![1], 10)
    : undefined);
  const externalId = readString(record, ['event_id', 'eventId', 'tweet_id', 'tweetId', 'id']) ?? firstString(tweet ?? {}, ['tweet_id', 'tweetId', 'id_str', 'id']);
  // Alpha's new_follower payload puts the followed project in follow_user;
  // user is the account that triggered the notification and must not become
  // the project identity.
  const xUserId = firstString(followUser ?? {}, ['id_str', 'id', 'x_user_id'])
    ?? readString(record, ['x_user_id', 'target_user_id', 'user_id', 'userId', 'author_id', 'authorId']);
  const targetHandle = firstString(followUser ?? {}, ['screen_name', 'username', 'handle']);
  const avatarUrl = firstString(followUser ?? {}, [
    'profile_image_url_https',
    'profile_image_url',
    'avatar_url',
    'avatarUrl'
  ]) ?? readString(record, ['profile_image_url_https', 'profile_image_url', 'avatar_url', 'avatarUrl']);
  const heartbeat = typeHint.includes('heartbeat');
  const ca = typeHint.includes('ca') || Boolean(content && CONTRACT_PATTERN.test(content));
  const type: AlphaSignalType = heartbeat
    ? 'heartbeat'
    : commonFollowCount !== undefined
      ? 'common_follow'
      : ca
        ? 'ca'
        : typeHint.includes('tweet') || Boolean(xPostUrl)
          ? 'new_tweet'
          : typeHint.includes('profile') || typeHint.includes('avatar') || typeHint.includes('description')
            ? 'profile_change'
            : 'unknown';

  return {
    type,
    externalId,
    xUserId,
    handle: targetHandle ?? handleFromUrl(xPostUrl),
    avatarUrl,
    commonFollowCount,
    xPostUrl,
    content,
    occurredAt: parseOccurredAt(record),
    payload: record
  };
}

export function buildAlphaDedupeKey(event: DecodedAlphaEvent): string {
  if (event.externalId) return `alpha:${event.externalId}`;
  const stable = canonicalize({
    type: event.type,
    xUserId: event.xUserId,
    handle: event.handle,
    commonFollowCount: event.commonFollowCount,
    xPostUrl: event.xPostUrl,
    content: event.content,
    payload: event.payload
  });
  const digest = createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
  return `alpha:hash:${digest}`;
}
