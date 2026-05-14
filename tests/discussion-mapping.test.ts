import { describe, expect, it } from 'vitest';
import { extractDiscussionMappings } from '../src/discussion-mapping.js';

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
});
