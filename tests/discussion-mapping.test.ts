import { describe, expect, it } from 'vitest';
import {
  extractDiscussionMappingFromMessage,
  extractDiscussionMappings
} from '../src/discussion-mapping.js';

describe('extractDiscussionMappings', () => {
  it('extracts automatic forward mapping from discussion updates', () => {
    const mappings = extractDiscussionMappings([
      {
        update_id: 1,
        message: {
          message_id: 200,
          is_automatic_forward: true,
          chat: { id: -1003769834276, type: 'supergroup' },
          forward_from_chat: { id: -1003903535780 },
          forward_from_message_id: 88
        }
      }
    ]);

    expect(mappings).toEqual([
      {
        discussionChatId: -1003769834276,
        discussionMessageId: 200,
        channelChatId: -1003903535780,
        channelMessageId: 88
      }
    ]);
  });

  it('extracts automatic forward mapping from modern forward_origin updates', () => {
    const mappings = extractDiscussionMappings([
      {
        update_id: 1,
        message: {
          message_id: 1039,
          is_automatic_forward: true,
          chat: { id: -1003769834276, type: 'supergroup' },
          forward_origin: {
            type: 'channel',
            chat: { id: -1003903535780, type: 'channel', title: 'Alpha' },
            message_id: 580
          }
        }
      }
    ]);

    expect(mappings).toEqual([
      {
        discussionChatId: -1003769834276,
        discussionMessageId: 1039,
        channelChatId: -1003903535780,
        channelMessageId: 580
      }
    ]);
  });

  it('extracts automatic forward mapping from a pinned discussion message', () => {
    const mapping = extractDiscussionMappingFromMessage({
      message_id: 1040,
      is_automatic_forward: true,
      chat: { id: -1003769834276, type: 'supergroup' },
      forward_origin: {
        type: 'channel',
        chat: { id: -1003903535780, type: 'channel', title: 'Alpha' },
        message_id: 581
      }
    });

    expect(mapping).toEqual({
      discussionChatId: -1003769834276,
      discussionMessageId: 1040,
      channelChatId: -1003903535780,
      channelMessageId: 581
    });
  });

  it('ignores non-automatic pinned messages', () => {
    expect(
      extractDiscussionMappingFromMessage({
        message_id: 1040,
        chat: { id: -1003769834276, type: 'supergroup' },
        text: 'manual pin'
      })
    ).toBeNull();
  });
});
