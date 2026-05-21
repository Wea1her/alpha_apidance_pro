import { createTwitter6551Client, type Twitter6551Client } from './twitter-6551-client.js';

export const PROJECT_BACKING_CANDIDATE_LIMIT = 30;

export interface ProjectBackingCandidate {
  username: string;
  displayName?: string;
  description?: string;
  followersCount?: number;
  verified?: boolean;
  rawCategory?: string;
}

export interface ProjectBackingEvidence {
  source: '6551';
  available: boolean;
  candidateCount: number | null;
  candidates: ProjectBackingCandidate[];
  warnings: string[];
}

export interface CollectProjectBackingEvidenceOptions {
  link: string;
  twitterToken?: string;
  twitterApiBaseUrl: string;
  proxyUrl?: string;
  client?: Twitter6551Client;
}

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const RESPONSE_ARRAY_KEYS = ['data', 'result', 'users', 'items'];

export function extractUsernameFromXLink(link: string): string | null {
  const matched = link.match(/^https?:\/\/(?:x|twitter)\.com\/@?([^/?#]+)/i);
  return normalizeUsername(matched?.[1]);
}

function emptyEvidence(warnings: string[] = []): ProjectBackingEvidence {
  return {
    source: '6551',
    available: false,
    candidateCount: null,
    candidates: [],
    warnings
  };
}

function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const username = value.trim().replace(/^@+/, '');
  if (!USERNAME_PATTERN.test(username)) return null;
  return username;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function booleanField(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function responseItems(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];

  const queue: unknown[] = [response];
  const visited = new Set<object>();
  while (queue.length > 0) {
    const item = queue.shift();
    if (Array.isArray(item)) return item;
    if (!item || typeof item !== 'object' || visited.has(item)) continue;

    visited.add(item);
    const record = item as Record<string, unknown>;
    for (const key of RESPONSE_ARRAY_KEYS) {
      const value = record[key];
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return [];
}

function candidateFromItem(item: unknown): ProjectBackingCandidate | null {
  if (!item || typeof item !== 'object') return null;

  const record = item as Record<string, unknown>;
  const username = normalizeUsername(
    record.username ??
      record.screenName ??
      record.screen_name ??
      record.userName ??
      record.twUserName ??
      record.twAccount ??
      record.handle
  );
  if (!username) return null;

  const candidate: ProjectBackingCandidate = { username };
  const displayName = stringField(record, ['displayName', 'name']);
  const description = stringField(record, ['description', 'bio']);
  const followersCount = numberField(record, [
    'followersCount',
    'followerCount',
    'followers_count',
    'followers_count_str',
    'followers'
  ]);
  const verified = booleanField(record, ['verified', 'isBlueVerified', 'blueVerified']);
  const rawCategory = stringField(record, ['rawCategory', 'category', 'type']);

  if (displayName !== undefined) candidate.displayName = displayName;
  if (description !== undefined) candidate.description = description;
  if (followersCount !== undefined) candidate.followersCount = followersCount;
  if (verified !== undefined) candidate.verified = verified;
  if (rawCategory !== undefined) candidate.rawCategory = rawCategory;

  return candidate;
}

export async function collectProjectBackingEvidence(
  options: CollectProjectBackingEvidenceOptions
): Promise<ProjectBackingEvidence> {
  if (!options.twitterToken) {
    return emptyEvidence(['未配置 TWITTER_TOKEN，跳过 6551 项目背书查询']);
  }

  const username = extractUsernameFromXLink(options.link);
  if (!username) {
    return emptyEvidence(['无法从 X 链接提取 username，跳过 6551 项目背书查询']);
  }

  try {
    const client = options.client ?? createTwitter6551Client({
      token: options.twitterToken,
      baseUrl: options.twitterApiBaseUrl,
      proxyUrl: options.proxyUrl
    });
    const response = await client.postOpen('twitter_kol_followers', { username });
    const rawItems = responseItems(response);
    const candidates = rawItems
      .map(candidateFromItem)
      .filter((candidate): candidate is ProjectBackingCandidate => candidate !== null);

    return {
      source: '6551',
      available: true,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, PROJECT_BACKING_CANDIDATE_LIMIT),
      warnings: rawItems.length > 0 && candidates.length === 0 ? ['6551 项目背书候选无法解析 username'] : []
    };
  } catch (error) {
    return emptyEvidence([
      `twitter_kol_followers 查询失败：${error instanceof Error ? error.message : String(error)}`
    ]);
  }
}
