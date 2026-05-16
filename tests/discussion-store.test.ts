import { describe, expect, it } from 'vitest';
import { DiscussionMappingStore } from '../src/discussion-store.js';

describe('DiscussionMappingStore', () => {
  it('resolves waiting consumers when a mapping arrives', async () => {
    const store = new DiscussionMappingStore();
    const pending = store.waitFor(100, 88, 1000);

    const inserted = store.ingest([
      {
        channelChatId: 100,
        channelMessageId: 88,
        discussionChatId: 200,
        discussionMessageId: 300
      }
    ]);

    expect(inserted).toBe(1);
    await expect(pending).resolves.toEqual({
      channelChatId: 100,
      channelMessageId: 88,
      discussionChatId: 200,
      discussionMessageId: 300
    });
  });

  it('returns only truly new mapping count when duplicates are ingested', () => {
    const store = new DiscussionMappingStore();

    expect(
      store.ingest([
        {
          channelChatId: 100,
          channelMessageId: 88,
          discussionChatId: 200,
          discussionMessageId: 300
        }
      ])
    ).toBe(1);

    expect(
      store.ingest([
        {
          channelChatId: 100,
          channelMessageId: 88,
          discussionChatId: 200,
          discussionMessageId: 300
        }
      ])
    ).toBe(0);
  });
});
