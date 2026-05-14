import { describe, expect, it } from 'vitest';
import { DiscussionMappingStore } from '../src/discussion-store.js';

describe('DiscussionMappingStore', () => {
  it('resolves waiting consumers when a mapping arrives', async () => {
    const store = new DiscussionMappingStore();
    const pending = store.waitFor(100, 88, 1000);

    store.ingest([
      {
        channelChatId: 100,
        channelMessageId: 88,
        discussionChatId: 200,
        discussionMessageId: 300
      }
    ]);

    await expect(pending).resolves.toEqual({
      channelChatId: 100,
      channelMessageId: 88,
      discussionChatId: 200,
      discussionMessageId: 300
    });
  });
});
