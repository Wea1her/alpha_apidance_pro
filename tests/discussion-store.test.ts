import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DiscussionMappingStore } from '../src/discussion-store.js';

async function createStore(): Promise<DiscussionMappingStore> {
  const dir = await mkdtemp(join(tmpdir(), 'discussion-store-'));
  return new DiscussionMappingStore({ persistPath: join(dir, 'discussion-mappings.jsonl') });
}

describe('DiscussionMappingStore', () => {
  it('resolves waiting consumers when a mapping arrives', async () => {
    const store = await createStore();
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

  it('returns only truly new mapping count when duplicates are ingested', async () => {
    const store = await createStore();

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
