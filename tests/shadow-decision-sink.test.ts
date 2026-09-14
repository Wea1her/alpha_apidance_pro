import { describe, expect, it, vi } from 'vitest';
import { processAlphaMessage, type LegacyDecisionEvent } from '../src/service.js';

/**
 * 影子期决策回调（Q32、Q38）。
 *
 * 目标：旧 worker 在判定链的每个分支都把“为什么推/为什么没推”的真实证据交给旁路 sink，
 * 且回调的存在与失败都不改变业务行为。
 */

function followMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    channel: 'follow',
    title: 'A 关注了 B',
    content: '用户简介:...\n你关注的5个用户也关注了ta',
    link: 'https://x.com/b',
    push_at: 1778660297,
    ...overrides
  });
}

async function run(
  raw: string,
  extra: Partial<Parameters<typeof processAlphaMessage>[0]> = {}
): Promise<LegacyDecisionEvent[]> {
  const events: LegacyDecisionEvent[] = [];
  await processAlphaMessage({
    raw,
    receivedAt: new Date(1778660298123),
    commonFollowStarLevels: [5, 8, 12, 15, 20],
    dedupe: new Set(),
    send: vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 }),
    onDecision: (event) => {
      events.push(event);
    },
    ...extra
  });
  // 回调是异步触发的（不阻塞业务），这里让微任务队列清空。
  await new Promise((resolve) => setTimeout(resolve, 0));
  return events;
}

describe('影子期决策回调', () => {
  it('心跳与解析失败也回调，便于区分“没收到”和“收到了但没推”', async () => {
    const heartbeat = await run(JSON.stringify({ channel: 'heartbeat' }));
    expect(heartbeat.map((event) => event.reasonCode)).toEqual(['HEARTBEAT']);

    const broken = await run('{"broken":');
    expect(broken.map((event) => event.reasonCode)).toEqual(['PARSE_ERROR']);
    expect(broken[0]?.detail?.error).toBeTruthy();
  });

  it('未达门槛与推送成功分别回调，且带星级与关注数', async () => {
    const below = await run(followMessage({ content: '你关注的4个用户也关注了ta' }));
    expect(below[0]).toMatchObject({ reasonCode: 'BELOW_THRESHOLD', count: 4, star: 0 });

    const pushed = await run(followMessage());
    expect(pushed[0]).toMatchObject({ reasonCode: 'PUSHED', count: 5, star: 1, projectKey: 'b' });
    // 推送分支带频道引用，便于与投递记录对齐
    expect(pushed[0]?.detail).toMatchObject({ chatId: -1001, messageId: 10 });
  });

  it('重复事件与星级未升高分别回调，不混为一谈', async () => {
    const dedupe = new Set<string>();
    const first = await run(followMessage(), { dedupe });
    expect(first[0]?.reasonCode).toBe('PUSHED');

    const repeat = await run(followMessage(), { dedupe });
    expect(repeat[0]).toMatchObject({ reasonCode: 'DEDUPE_REPEAT' });

    // 同账号已经 1 星，再来一条同样 1 星的事件：星级未升高
    const projectStars = new Map<string, number>([['b', 1]]);
    const notIncreased = await run(followMessage({ push_at: 1778660399 }), {
      projectStars,
      dedupe: new Set<string>()
    });
    expect(notIncreased[0]).toMatchObject({ reasonCode: 'STAR_NOT_INCREASED', previousStar: 1, star: 1 });
  });

  it('分类拦截、放行与分类异常分别回调，异常分支不伪造类型', async () => {
    const blocked = await run(followMessage(), {
      classify: async () => ({ allowPush: false, type: 'KOL', reason: '个人账号' })
    });
    expect(blocked[0]).toMatchObject({ reasonCode: 'CLASSIFY_BLOCKED' });
    expect(blocked[0]?.classification).toMatchObject({ type: 'KOL', reason: '个人账号' });

    const allowed = await run(followMessage(), {
      classify: async () => ({ allowPush: true, type: 'PROJECT', reason: '项目方' })
    });
    expect(allowed.map((event) => event.reasonCode)).toContain('CLASSIFY_ALLOWED');

    const failed = await run(followMessage(), {
      classify: async () => {
        throw new Error('分类超时');
      }
    });
    expect(failed[0]).toMatchObject({ reasonCode: 'CLASSIFY_ERROR_ALLOWED' });
    expect(failed[0]?.classification).toMatchObject({ type: null, error: '分类超时' });
  });

  it('推送失败回调 SEND_FAILED，但业务仍然照常抛出', async () => {
    const events: LegacyDecisionEvent[] = [];
    const send = vi.fn().mockRejectedValue(new Error('telegram 503'));
    await expect(
      processAlphaMessage({
        raw: followMessage(),
        receivedAt: new Date(1778660298123),
        commonFollowStarLevels: [5, 8, 12, 15, 20],
        dedupe: new Set(),
        send,
        onDecision: (event) => {
          events.push(event);
        }
      })
    ).rejects.toThrow('telegram 503');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.map((event) => event.reasonCode)).toContain('SEND_FAILED');
  });

  it('回调抛错不影响业务，也不影响推送', async () => {
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 11 });
    const warn = vi.fn();
    await processAlphaMessage({
      raw: followMessage(),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send,
      warn,
      onDecision: () => {
        throw new Error('sink 写失败');
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('决策回调失败'))).toBe(true);
  });

  it('不传回调时行为与旧实现一致（回归保护）', async () => {
    const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 12 });
    await processAlphaMessage({
      raw: followMessage(),
      receivedAt: new Date(1778660298123),
      commonFollowStarLevels: [5, 8, 12, 15, 20],
      dedupe: new Set(),
      send
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
