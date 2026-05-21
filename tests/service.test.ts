import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AnalysisArchiveRecord } from '../src/analysis-archive-store.js';
import type { AnalysisTaskRecord } from '../src/analysis-task-queue.js';
import { createUnavailableAlphaReplayProvider, type AlphaReplayProvider } from '../src/alpha-replay-provider.js';
import {
  archiveAnalysisTaskResult,
  handleTelegramCommandUpdates,
  processAlphaMessage,
  replayAlphaEvents
} from '../src/service.js';

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

  it('passes the main push success time to afterSend', async () => {
    vi.useFakeTimers();
    const mainPushedAt = new Date('2026-05-20T08:30:45.123Z');
    vi.setSystemTime(mainPushedAt);
    const sendResult = { chatId: -1001, messageId: 10 };
    const send = vi.fn().mockResolvedValue(sendResult);
    const afterSend = vi.fn();

    try {
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
    } finally {
      vi.useRealTimers();
    }

    expect(afterSend).toHaveBeenCalledWith(
      expect.any(Object),
      10,
      2,
      sendResult,
      mainPushedAt
    );
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

  it('queues main telegram push failures without marking the event as delivered', async () => {
    const send = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const enqueueFailedMainPush = vi.fn().mockResolvedValue(undefined);
    const dedupe = new Set<string>();
    const inFlight = new Set<string>();
    const projectStars = new Map<string, number>();

    await expect(
      processAlphaMessage({
        raw: JSON.stringify({
          channel: 'follow',
          title: 'A 关注了 B',
          content: '用户简介: DeFi protocol\n你关注的8个用户也关注了ta',
          link: 'https://x.com/b',
          push_at: 1778660297
        }),
        receivedAt: new Date(1778660298123),
        commonFollowStarLevels: [5, 8, 12, 15, 20],
        dedupe,
        inFlight,
        projectStars,
        send,
        enqueueFailedMainPush
      })
    ).rejects.toThrow('fetch failed');

    expect(enqueueFailedMainPush).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'follow|https://x.com/b|A 关注了 B|1778660297',
      count: 8,
      star: 2,
      lastError: 'fetch failed'
    }));
    expect(dedupe.has('follow|https://x.com/b|A 关注了 B|1778660297')).toBe(false);
    expect(inFlight.size).toBe(0);
    expect(projectStars.has('b')).toBe(false);
  });

  it('persists project state after a successful main push', async () => {
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
    const persistProjectState = vi.fn().mockResolvedValue(undefined);

    await processAlphaMessage({
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 B',
        content: '你关注的8个用户也关注了ta',
        link: 'https://x.com/b',
        push_at: 1778660297
      }),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      projectStars: new Map(),
      projectPushCounts: new Map(),
      projectFirstChannelMessages: new Map(),
      send,
      persistProjectState
    });

    expect(persistProjectState).toHaveBeenCalledTimes(1);
  });

  it('does not persist project state when main push fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const enqueueFailedMainPush = vi.fn().mockResolvedValue(undefined);
    const persistProjectState = vi.fn().mockResolvedValue(undefined);

    await expect(
      processAlphaMessage({
        raw: JSON.stringify({
          channel: 'follow',
          title: 'A 关注了 B',
          content: '你关注的8个用户也关注了ta',
          link: 'https://x.com/b',
          push_at: 1778660297
        }),
        receivedAt: new Date(1778660298123),
        commonFollowStarLevels: [5, 8, 12, 15, 20],
        dedupe: new Set(),
        projectStars: new Map(),
        projectPushCounts: new Map(),
        projectFirstChannelMessages: new Map(),
        send,
        enqueueFailedMainPush,
        persistProjectState
      })
    ).rejects.toThrow('fetch failed');

    expect(persistProjectState).not.toHaveBeenCalled();
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
    const projectPushCounts = new Map<string, number>();

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
      projectPushCounts,
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
      projectPushCounts,
      send,
      afterSend
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(afterSend).toHaveBeenCalledTimes(2);
    expect(projectStars.get('b')).toBe(2);
    expect(projectPushCounts.get('b')).toBe(2);
    expect(send.mock.calls[0][0].split('\n')[0]).toBe('第1次推送');
    expect(send.mock.calls[1][0].split('\n')[0]).toBe('第2次推送');
    expect(send.mock.calls[1][0].split('\n')[1]).toBe('检测到项目星级变化：1星 → 2星');
  });

  it('links repeated channel pushes to the first channel push', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ chatId: -1001234567890, messageId: 321 })
      .mockResolvedValueOnce({ chatId: -1001234567890, messageId: 456 });
    const dedupe = new Set<string>();
    const projectStars = new Map<string, number>();
    const projectPushCounts = new Map<string, number>();
    const projectFirstChannelMessages = new Map<string, { chatId: number; messageId: number }>();

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
      projectPushCounts,
      projectFirstChannelMessages,
      send
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
      projectPushCounts,
      projectFirstChannelMessages,
      send
    });

    expect(projectFirstChannelMessages.get('b')).toEqual({ chatId: -1001234567890, messageId: 321 });
    expect(send.mock.calls[0][0]).not.toContain('首次推送：');
    expect(send.mock.calls[1][0].split('\n')).toContain('首次推送：https://t.me/c/1234567890/321');
  });

  it('skips concurrent repeated project pushes below the max star level', async () => {
    const sendResolves: Array<(value: { chatId: number; messageId: number }) => void> = [];
    const send = vi.fn(
      (_text: string) =>
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
    const projectPushCounts = new Map<string, number>();
    const baseInput = {
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      projectStars,
      projectPushCounts,
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
    expect(projectPushCounts.get('altdotfun')).toBe(6);
    expect(send.mock.calls[0][0].split('\n')[0]).toBe('第5次推送');
    expect(send.mock.calls[1][0].split('\n')[0]).toBe('第6次推送');
    expect(send.mock.calls[1][0].split('\n')[1]).toBe('⭐⭐⭐⭐⭐ Alpha 共同关注推送');
  });

  it('reserves increasing push counts for concurrent max-star project pushes', async () => {
    const sendResolves: Array<(value: { chatId: number; messageId: number }) => void> = [];
    const send = vi.fn(
      (_text: string) =>
        new Promise<{ chatId: number; messageId: number }>((resolve) => {
          sendResolves.push(resolve);
        })
    );
    const dedupe = new Set<string>();
    const projectStars = new Map<string, number>();
    const projectPushCounts = new Map<string, number>();
    const baseInput = {
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      projectStars,
      projectPushCounts,
      send
    };

    const first = processAlphaMessage({
      ...baseInput,
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 alt.fun',
        content: '你关注的46个用户也关注了ta',
        link: 'https://x.com/altdotfun',
        push_at: 1778660297
      })
    });
    const second = processAlphaMessage({
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
    expect(send.mock.calls[0][0].split('\n')[0]).toBe('第5次推送');
    expect(send.mock.calls[1][0].split('\n')[0]).toBe('第6次推送');

    for (const resolve of sendResolves) {
      resolve({ chatId: -1001, messageId: 10 });
    }
    await Promise.all([first, second]);

    expect(projectPushCounts.get('altdotfun')).toBe(6);
  });

  it('links concurrent repeated max-star pushes after the first channel message is created', async () => {
    const sendResolves: Array<(value: { chatId: number; messageId: number }) => void> = [];
    const send = vi.fn(
      (_text: string) =>
        new Promise<{ chatId: number; messageId: number }>((resolve) => {
          sendResolves.push(resolve);
        })
    );
    const dedupe = new Set<string>();
    const projectStars = new Map<string, number>();
    const projectPushCounts = new Map<string, number>();
    const projectFirstChannelMessages = new Map<string, { chatId: number; messageId: number }>();
    const projectLocks = new Map<string, Promise<void>>();
    const baseInput = {
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe,
      projectStars,
      projectPushCounts,
      projectFirstChannelMessages,
      projectLocks,
      send
    };

    const first = processAlphaMessage({
      ...baseInput,
      raw: JSON.stringify({
        channel: 'follow',
        title: 'A 关注了 alt.fun',
        content: '你关注的46个用户也关注了ta',
        link: 'https://x.com/altdotfun',
        push_at: 1778660297
      })
    });
    await Promise.resolve();

    const second = processAlphaMessage({
      ...baseInput,
      raw: JSON.stringify({
        channel: 'follow',
        title: 'C 关注了 alt.fun',
        content: '你关注的46个用户也关注了ta',
        link: 'https://x.com/altdotfun',
        push_at: 1778660397
      })
    });
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
    sendResolves[0]({ chatId: -1001234567890, messageId: 321 });
    await first;
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].split('\n')[0]).toBe('第6次推送');
    expect(send.mock.calls[1][0].split('\n')).toContain('首次推送：https://t.me/c/1234567890/321');

    sendResolves[1]({ chatId: -1001234567890, messageId: 456 });
    await second;
  });
});

describe('replayAlphaEvents', () => {
  it('logs unavailable replay once and does not process events', async () => {
    const warn = vi.fn();
    const onEvent = vi.fn();
    const unavailableLogged = { value: false };
    const provider = createUnavailableAlphaReplayProvider('no historical endpoint');

    await replayAlphaEvents({
      provider,
      since: new Date('2026-05-21T00:00:00.000Z'),
      onEvent,
      unavailableLogged,
      warn
    });
    await replayAlphaEvents({
      provider,
      since: new Date('2026-05-21T00:01:00.000Z'),
      onEvent,
      unavailableLogged,
      warn
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Alpha 历史回放不可用');
  });

  it('replays available events through the same alpha message processing path', async () => {
    const provider: AlphaReplayProvider = {
      available: true,
      async replaySince() {
        return [
          {
            raw: JSON.stringify({
              channel: 'follow',
              title: 'A 关注了 B',
              content: '你关注的8个用户也关注了ta',
              link: 'https://x.com/b',
              push_at: 1778660297
            }),
            receivedAt: new Date('2026-05-21T00:00:01.000Z')
          }
        ];
      }
    };
    const dedupe = new Set<string>();
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });

    const onEvent = (raw: string, receivedAt: Date) =>
      processAlphaMessage({
        raw,
        receivedAt,
        commonFollowStarLevels: [5, 8, 12, 15, 20],
        dedupe,
        send
      });

    await replayAlphaEvents({
      provider,
      since: new Date('2026-05-21T00:00:00.000Z'),
      onEvent,
      info: vi.fn(),
      warn: vi.fn()
    });
    await replayAlphaEvents({
      provider,
      since: new Date('2026-05-21T00:00:00.000Z'),
      onEvent,
      info: vi.fn(),
      warn: vi.fn()
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('⭐⭐');
  });
});

const analysisTask: AnalysisTaskRecord = {
  version: 1,
  taskKey: '-1001:10',
  projectKey: 'project-a',
  channelChatId: -1001,
  channelMessageId: 10,
  title: 'A 关注了 Project A',
  content: '你关注的12个用户也关注了ta',
  link: 'https://x.com/project_a',
  mainPushedAt: '2026-05-20T01:00:00.000Z',
  count: 12,
  star: 3,
  retryCount: 0,
  nextRetryAt: '2026-05-20T01:00:00.000Z',
  createdAt: '2026-05-20T01:00:00.000Z',
  updatedAt: '2026-05-20T01:00:00.000Z'
};

const archivedAnalysis: Extract<AnalysisArchiveRecord, { recordType: 'analysis' }> = {
  version: 1,
  recordType: 'analysis',
  sourceTaskKey: '-1001:10',
  projectKey: 'project-a',
  title: 'A 关注了 Project A',
  content: '你关注的12个用户也关注了ta',
  link: 'https://x.com/project_a',
  mainPushedAt: '2026-05-20T01:00:00.000Z',
  archivedAt: '2026-05-20T01:02:00.000Z',
  analysisCreatedAt: '2026-05-20T01:02:00.000Z',
  star: 3,
  count: 12,
  channelMessage: { chatId: -1001, messageId: 10 },
  discussionAnalysisMessage: { chatId: '-1002', messageId: 20 },
  analysisText: 'Project A 完整分析'
};

describe('archiveAnalysisTaskResult', () => {
  it('archives first analysis results and hydrates the tracker', async () => {
    const archiveStore = {
      upsert: vi.fn().mockResolvedValue(undefined),
      getFirstAnalysis: vi.fn()
    };
    const analysisTracker = { set: vi.fn() };

    await archiveAnalysisTaskResult({
      task: analysisTask,
      result: {
        type: 'analysis',
        message: { chatId: -1002, messageId: 20 },
        analysisText: 'Project A 完整分析'
      },
      discussionChatId: '-1002',
      archiveStore,
      analysisTracker,
      now: new Date('2026-05-20T01:02:00.000Z')
    });

    expect(archiveStore.upsert).toHaveBeenCalledWith({
      ...archivedAnalysis,
      archivedAt: '2026-05-20T01:02:00.000Z',
      analysisCreatedAt: '2026-05-20T01:02:00.000Z'
    });
    expect(analysisTracker.set).toHaveBeenCalledWith('project-a', {
      discussionChatId: '-1002',
      analysisMessageId: 20
    });
  });

  it('archives repeat hits when the project already has analysis text', async () => {
    const archiveStore = {
      upsert: vi.fn().mockResolvedValue(undefined),
      getFirstAnalysis: vi.fn().mockResolvedValue(archivedAnalysis)
    };
    const analysisTracker = { set: vi.fn() };

    await archiveAnalysisTaskResult({
      task: {
        ...analysisTask,
        taskKey: '-1001:11',
        channelMessageId: 11,
        mainPushedAt: '2026-05-20T03:00:00.000Z',
        count: 20,
        star: 5
      },
      result: {
        type: 'reminder',
        message: { chatId: -1002, messageId: 21 },
        existingAnalysis: { discussionChatId: '-1002', analysisMessageId: 20 }
      },
      discussionChatId: '-1002',
      archiveStore,
      analysisTracker,
      now: new Date('2026-05-20T03:02:00.000Z')
    });

    expect(archiveStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      recordType: 'hit',
      sourceTaskKey: '-1001:11',
      projectKey: 'project-a',
      mainPushedAt: '2026-05-20T03:00:00.000Z',
      star: 5,
      count: 20,
      channelMessage: { chatId: -1001, messageId: 11 },
      discussionAnalysisMessage: { chatId: '-1002', messageId: 20 },
      reminderMessage: { chatId: -1002, messageId: 21 }
    }));
    expect(analysisTracker.set).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing analysis with a same-task reminder after restart', async () => {
    const archiveStore = {
      upsert: vi.fn().mockResolvedValue(undefined),
      getFirstAnalysis: vi.fn().mockResolvedValue(archivedAnalysis)
    };
    const analysisTracker = { set: vi.fn() };

    await archiveAnalysisTaskResult({
      task: analysisTask,
      result: {
        type: 'reminder',
        message: { chatId: -1002, messageId: 21 },
        existingAnalysis: { discussionChatId: '-1002', analysisMessageId: 20 }
      },
      discussionChatId: '-1002',
      archiveStore,
      analysisTracker,
      now: new Date('2026-05-20T01:03:00.000Z')
    });

    expect(archiveStore.upsert).not.toHaveBeenCalled();
    expect(analysisTracker.set).not.toHaveBeenCalled();
  });
});

describe('handleTelegramCommandUpdates', () => {
  it('writes and sends markdown export documents for authorized commands', async () => {
    const exportDir = await mkdtemp(join(tmpdir(), 'analysis-export-'));
    const sendDocument = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 30 });
    const sendMessage = vi.fn();

    await handleTelegramCommandUpdates({
      updates: [
        {
          update_id: 1,
          channel_post: {
            message_id: 50,
            text: '导出分析 2026-05-20T09 2026-05-20T09',
            chat: { id: -1001, type: 'channel' }
          }
        }
      ],
      archiveStore: { listAll: vi.fn().mockResolvedValue([archivedAnalysis]) },
      botToken: 'bot-token',
      telegramRetryAttempts: 2,
      telegramRetryMinDelayMs: 10,
      telegramRetryMaxDelayMs: 20,
      exportAdminUsernames: [],
      exportAllowedChatIds: ['-1001'],
      exportDir,
      now: new Date('2026-05-20T02:00:00.000Z'),
      sendMessage,
      sendDocument
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendDocument).toHaveBeenCalledWith(expect.objectContaining({
      botToken: 'bot-token',
      chatId: '-1001',
      filename: 'alpha-analysis-2026-05-20T09-2026-05-20T09.md',
      caption: '分析导出：2026-05-20 09:00 ~ 2026-05-20 09:59'
    }));
    const filePath = sendDocument.mock.calls[0][0].filePath;
    await expect(readFile(filePath, 'utf8')).resolves.toContain('Project A 完整分析');
  });

  it('replies to chat id commands and rejects unauthorized exports', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 31 });
    const sendDocument = vi.fn();

    await handleTelegramCommandUpdates({
      updates: [
        {
          update_id: 1,
          message: {
            message_id: 51,
            text: '查看聊天ID',
            chat: { id: -1001, type: 'supergroup' }
          }
        },
        {
          update_id: 2,
          message: {
            message_id: 52,
            text: '导出分析 2026-05-20T09 2026-05-20T09',
            from: { username: 'mallory' },
            chat: { id: -1001, type: 'supergroup' }
          }
        }
      ],
      archiveStore: { listAll: vi.fn() },
      botToken: 'bot-token',
      telegramRetryAttempts: 2,
      telegramRetryMinDelayMs: 10,
      telegramRetryMaxDelayMs: 20,
      exportAdminUsernames: ['alice'],
      exportAllowedChatIds: [],
      sendMessage,
      sendDocument
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      chatId: '-1001',
      text: '聊天ID：-1001'
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chatId: '-1001',
      text: '无权限执行分析导出'
    }));
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it('checks export authorization before replying with invalid export usage', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 31 });

    await handleTelegramCommandUpdates({
      updates: [
        {
          update_id: 1,
          message: {
            message_id: 53,
            text: '导出分析 2026-05-20T09',
            from: { username: 'mallory' },
            chat: { id: -1001, type: 'supergroup' }
          }
        }
      ],
      archiveStore: { listAll: vi.fn() },
      botToken: 'bot-token',
      telegramRetryAttempts: 2,
      telegramRetryMinDelayMs: 10,
      telegramRetryMaxDelayMs: 20,
      exportAdminUsernames: ['alice'],
      exportAllowedChatIds: [],
      sendMessage
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '-1001',
      text: '无权限执行分析导出'
    }));
  });
});
