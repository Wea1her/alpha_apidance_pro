import { extractCommonFollowCount } from '../alpha-event.js';
import { parseAlphaMessage } from '../alpha-client.js';
import type { ParsedAlphaEvent } from '../domain/decision-rules.js';

/**
 * 把上游原始消息解析成业务事实。
 *
 * 与旧实现 src/service.ts 保持一致：
 * - 解析失败抛出（由调用方记录 PARSE_ERROR 并保留原始 payload）；
 * - 心跳消息由调用方用 isAlphaHeartbeat 判定；
 * - 去重键为 channel|link|title|push_at 直接拼接；
 * - 项目键优先取 link 里的 X handle，其次整条 link，最后标题。
 *
 * 与旧实现的差异只有一处：这里同时保留 push_at（秒）与去重键原文，
 * 因为历史实现从未把它们落盘，而页面需要它们来解释“为什么没推”。
 */

export interface ParseAlphaEventResult extends ParsedAlphaEvent {}

function messageString(message: Record<string, unknown>, field: string): string {
  const value = message[field];
  return typeof value === 'string' ? value : '';
}

/** 与旧实现 buildDedupeKey 完全一致。 */
export function buildLegacyDedupeKey(message: Record<string, unknown>): string {
  const channel = messageString(message, 'channel') || 'unknown';
  const link = messageString(message, 'link');
  const title = messageString(message, 'title');
  const pushAt = message.push_at === undefined ? '' : String(message.push_at);
  return [channel, link, title, pushAt].join('|');
}

/** 与旧实现 parseChannelHandle 完全一致。 */
export function parseChannelHandle(link: string): string | null {
  const matched = link.match(/^https:\/\/(?:x|twitter)\.com\/([^/?#]+)/i);
  return matched?.[1] ?? null;
}

/** 与旧实现 buildProjectKey 完全一致。 */
export function buildProjectKey(message: Record<string, unknown>): string {
  const link = messageString(message, 'link').trim();
  const handle = parseChannelHandle(link);
  if (handle) return handle.toLowerCase();
  if (link) return link.toLowerCase();
  return (messageString(message, 'title') || 'unknown').trim().toLowerCase();
}

/** 解析上游事件时间（秒）。缺失返回 null，绝不用本地时间顶替。 */
export function extractUpstreamPushAtSec(message: Record<string, unknown>): number | null {
  const raw = message.push_at;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // 上游存在毫秒与秒两种形态：大于 1e10 视为毫秒。
    return raw > 1e10 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const value = Number.parseInt(raw.trim(), 10);
    if (value > 0) return value > 1e10 ? Math.floor(value / 1000) : value;
  }
  return null;
}

/**
 * 解析原始消息。解析失败时抛出错误，调用方据此写 PARSE_ERROR 判定。
 */
export function parseAlphaEvent(raw: string): ParseAlphaEventResult {
  const message = parseAlphaMessage(raw) as Record<string, unknown>;
  const link = messageString(message, 'link').trim() || null;
  const title = messageString(message, 'title').trim() || null;
  const content = messageString(message, 'content').trim() || null;
  const channel = messageString(message, 'channel').trim() || null;
  const projectKey = buildProjectKey(message);
  const displayName = title ? (title.split('关注了')[1]?.trim() || title) : null;

  return {
    channel,
    title,
    link,
    content,
    upstreamPushAtSec: extractUpstreamPushAtSec(message),
    commonFollowCount: extractCommonFollowCount(message),
    legacyDedupeKey: buildLegacyDedupeKey(message),
    projectKey,
    displayName,
  };
}
