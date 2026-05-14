import { describe, expect, it, vi } from 'vitest';
import { processAlphaMessage } from '../src/service.js';

describe('processAlphaMessage', () => {
  it('ignores heartbeat messages', async () => {
    const send = vi.fn();

    await processAlphaMessage({
      raw: JSON.stringify({ channel: 'heartbeat' }),
      receivedAt: new Date(),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('does not send events below the push threshold', async () => {
    const send = vi.fn();

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '用户简介:...\n你关注的4个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('sends starred messages when the threshold is met', async () => {
    const send = vi.fn();
    const analyze = vi.fn();

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '用户简介:...\n你关注的10个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send,
      analyze
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(analyze).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0]).toContain('⭐⭐');
    expect(send.mock.calls[0][0]).toContain('A 关注了 B');
    expect(send.mock.calls[0][0]).toContain('https://x.com/b');
  });

  it('triggers analysis on 3-star and above', async () => {
    const send = vi.fn();
    const analyze = vi.fn();

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '用户简介:...\n你关注的12个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send,
      analyze
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('dedupes repeated alpha events', async () => {
    const send = vi.fn();
    const analyze = vi.fn();
    const dedupe = new Set<string>();
    const input = {
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '你关注的20个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      send,
      analyze
    };

    await processAlphaMessage(input);
    await processAlphaMessage(input);

    expect(send).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
});
