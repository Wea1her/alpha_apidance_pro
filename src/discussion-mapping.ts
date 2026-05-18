export interface DiscussionMapping {
  discussionChatId: number;
  discussionMessageId: number;
  channelChatId: number;
  channelMessageId: number;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  return typeof record[key] === 'number' ? (record[key] as number) : null;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function extractLegacyForwardSource(msg: Record<string, unknown>): {
  channelChatId: number | null;
  channelMessageId: number | null;
} {
  const forwardFromChat = objectField(msg, 'forward_from_chat');
  return {
    channelChatId: forwardFromChat ? numberField(forwardFromChat, 'id') : null,
    channelMessageId: numberField(msg, 'forward_from_message_id')
  };
}

function extractForwardOriginSource(msg: Record<string, unknown>): {
  channelChatId: number | null;
  channelMessageId: number | null;
} {
  const forwardOrigin = objectField(msg, 'forward_origin');
  if (!forwardOrigin || forwardOrigin.type !== 'channel') {
    return { channelChatId: null, channelMessageId: null };
  }

  const chat = objectField(forwardOrigin, 'chat');
  return {
    channelChatId: chat ? numberField(chat, 'id') : null,
    channelMessageId: numberField(forwardOrigin, 'message_id')
  };
}

export function extractDiscussionMappingFromMessage(message: unknown): DiscussionMapping | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const chat = objectField(msg, 'chat');
  const isAutomaticForward = msg.is_automatic_forward === true;
  const discussionMessageId = numberField(msg, 'message_id');
  const legacySource = extractLegacyForwardSource(msg);
  const originSource = extractForwardOriginSource(msg);
  const channelChatId = legacySource.channelChatId ?? originSource.channelChatId;
  const channelMessageId = legacySource.channelMessageId ?? originSource.channelMessageId;

  if (!isAutomaticForward || discussionMessageId === null || channelMessageId === null) return null;
  if (!chat) return null;

  const discussionChatId = numberField(chat, 'id');
  if (discussionChatId === null || channelChatId === null) return null;

  return {
    discussionChatId,
    discussionMessageId,
    channelChatId,
    channelMessageId
  };
}

export function extractDiscussionMappings(updates: unknown[]): DiscussionMapping[] {
  const mappings: DiscussionMapping[] = [];

  for (const update of updates) {
    if (!update || typeof update !== 'object') continue;
    const record = update as Record<string, unknown>;
    const mapping = extractDiscussionMappingFromMessage(record.message);
    if (mapping) mappings.push(mapping);
  }

  return mappings;
}
