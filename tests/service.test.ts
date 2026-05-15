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
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
    const afterSend = vi.fn();

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
      afterSend
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(afterSend).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('⭐⭐');
    expect(send.mock.calls[0][0]).toContain('A 关注了 B');
    expect(send.mock.calls[0][0]).toContain('https://x.com/b');
  });

  it('classifies and analyzes 1-star project events before sending', async () => {
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
    const afterSend = vi.fn();
    const classify = vi.fn().mockResolvedValue({ allowPush: true, type: 'PROJECT', reason: '项目账号' });

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '用户简介: DeFi protocol\n你关注的5个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send,
      classify,
      afterSend
    });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][1]).toBe(5);
    expect(classify.mock.calls[0][2]).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(afterSend).toHaveBeenCalledTimes(1);
  });

  it('blocks KOL events before sending to Telegram', async () => {
    const send = vi.fn();
    const afterSend = vi.fn();
    const classify = vi.fn().mockResolvedValue({ allowPush: false, type: 'KOL', reason: '个人观点账号' });

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '用户简介: trader and researcher\n你关注的20个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send,
      classify,
      afterSend
    });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(afterSend).not.toHaveBeenCalled();
  });

  it('blocks media events before sending to Telegram', async () => {
    const send = vi.fn();
    const afterSend = vi.fn();
    const classify = vi.fn().mockResolvedValue({ allowPush: false, type: 'MEDIA', reason: '媒体资讯账号' });

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '用户简介: crypto media and news\n你关注的20个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send,
      classify,
      afterSend
    });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(afterSend).not.toHaveBeenCalled();
  });

  it('blocks dev and individual builder events before sending to Telegram', async () => {
    const send = vi.fn();
    const afterSend = vi.fn();
    const classify = vi.fn().mockResolvedValue({ allowPush: false, type: 'DEV', reason: '个人开发者账号' });

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '用户简介: dev building onchain apps\n你关注的20个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send,
      classify,
      afterSend
    });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(afterSend).not.toHaveBeenCalled();
  });

  it('pushes and analyzes when classification fails', async () => {
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
    const afterSend = vi.fn();
    const classify = vi.fn().mockRejectedValue(new Error('classification failed'));

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '用户简介: unclear\n你关注的5个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send,
      classify,
      afterSend
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(afterSend).toHaveBeenCalledTimes(1);
  });

  it('dedupes repeated alpha events', async () => {
    const send = vi.fn();
    const afterSend = vi.fn();
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
      afterSend
    };

    await processAlphaMessage(input);
    await processAlphaMessage(input);

    expect(send).toHaveBeenCalledTimes(1);
    expect(afterSend).toHaveBeenCalledTimes(1);
  });

  it('skips repeated project pushes when the project star level has not increased', async () => {
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
    const afterSend = vi.fn();
    const dedupe = new Set<string>();
    const projectStars = new Map<string, number>();

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '你关注的5个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      projectStars,
      send,
      afterSend
    });

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'C 关注了 B',
        content: '你关注的7个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660397
      }),
      receivedAt: new Date(1778660398123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      projectStars,
      send,
      afterSend
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(afterSend).toHaveBeenCalledTimes(1);
    expect(projectStars.get('b')).toBe(1);
  });

  it('pushes repeated projects again only when the project star level increases', async () => {
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
    const afterSend = vi.fn();
    const dedupe = new Set<string>();
    const projectStars = new Map<string, number>();

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '你关注的5个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      projectStars,
      send,
      afterSend
    });

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'C 关注了 B',
        content: '你关注的8个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660397
      }),
      receivedAt: new Date(1778660398123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      projectStars,
      send,
      afterSend
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(afterSend).toHaveBeenCalledTimes(2);
    expect(projectStars.get('b')).toBe(2);
    expect(send.mock.calls[1][0].split('\n')[0]).toBe('检测到项目星级变化：1星 → 2星');
  });

  it('skips concurrent repeated project pushes below the max star level', async () => {
    const sendResolves: Array<(value: { chatId: number; messageId: number }) => void> = [];
    const send = vi.fn(
      () =>
        new Promise<{ chatId: number; messageId: number }>((resolve) => {
          sendResolves.push(resolve);
        })
    );
    const dedupe = new Set<string>();
    const projectStars = new Map<string, number>();
    const baseInput = {
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      projectStars,
      send
    };

    const first = processAlphaMessage({
      ...baseInput,
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 alt.fun',
        content: '你关注的5个用户也关注了ta',
        link: 'https://x.com/altdotfun',
        push_at: 1778660297
      })
    });
    const second = processAlphaMessage({
      ...baseInput,
      raw: JSON.stringify({
        channel: 'follow',
        title: 'C 关注了 alt.fun',
        content: '你关注的7个用户也关注了ta',
        link: 'https://x.com/altdotfun',
        push_at: 1778660397
      })
    });

    for (const resolve of sendResolves) {
      resolve({ chatId: -1001, messageId: 10 });
    }
    await Promise.all([first, second]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(projectStars.get('altdotfun')).toBe(1);
  });

  it('keeps pushing repeated projects at the max star level', async () => {
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
    const dedupe = new Set<string>();
    const projectStars = new Map<string, number>();
    const baseInput = {
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      projectStars,
      send
    };

    await processAlphaMessage({
      ...baseInput,
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 alt.fun',
        content: '你关注的46个用户也关注了ta',
        link: 'https://x.com/altdotfun',
        push_at: 1778660297
      })
    });
    await processAlphaMessage({
      ...baseInput,
      raw: JSON.stringify({
        channel: 'follow',
        title: 'C 关注了 alt.fun',
        content: '你关注的46个用户也关注了ta',
        link: 'https://x.com/altdotfun',
        push_at: 1778660397
      })
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(projectStars.get('altdotfun')).toBe(5);
    expect(send.mock.calls[1][0].split('\n')[0]).toBe('⭐⭐⭐⭐⭐ Alpha 共同关注推送');
  });
});
