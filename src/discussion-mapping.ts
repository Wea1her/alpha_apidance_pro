export interface DiscussionMapping {
  discussionChatId: number;
  discussionMessageId: number;
  channelChatId: number;
  channelMessageId: number;
}

export function extractDiscussionMappings(updates: unknown[]): DiscussionMapping[] {
  const mappings: DiscussionMapping[] = [];

  for (const update of updates) {
    if (!update || typeof update !== 'object') continue;
    const record = update as Record<string, unknown>;
    const message = record.message;
    if (!message || typeof message !== 'object') continue;
    const msg = message as Record<string, unknown>;
    const chat = msg.chat;
    const forwardFromChat = msg.forward_from_chat;
    const isAutomaticForward = msg.is_automatic_forward === true;
    const discussionMessageId = typeof msg.message_id === 'number' ? msg.message_id : null;
    const channelMessageId = typeof msg.forward_from_message_id === 'number' ? msg.forward_from_message_id : null;

    if (!isAutomaticForward || discussionMessageId === null || channelMessageId === null) continue;
    if (!chat || typeof chat !== 'object') continue;
    if (!forwardFromChat || typeof forwardFromChat !== 'object') continue;

    const discussionChatId =
      typeof (chat as Record<string, unknown>).id === 'number'
        ? ((chat as Record<string, unknown>).id as number)
        : null;
    const channelChatId =
      typeof (forwardFromChat as Record<string, unknown>).id === 'number'
        ? ((forwardFromChat as Record<string, unknown>).id as number)
        : null;

    if (discussionChatId === null || channelChatId === null) continue;

    mappings.push({
      discussionChatId,
      discussionMessageId,
      channelChatId,
      channelMessageId
    });
  }

  return mappings;
}
