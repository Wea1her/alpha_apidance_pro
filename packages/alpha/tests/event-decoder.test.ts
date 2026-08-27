import { describe, expect, it } from 'vitest';
import { decodeAlphaWebhook, buildAlphaDedupeKey } from '../src/event-decoder.js';

describe('AlphaEventDecoder', () => {
  it('decodes a common-follow event into a stable project signal', () => {
    const payload = {
      event_id: 'evt-1',
      type: 'follow',
      user_id: '12345',
      link: 'https://x.com/project_alpha',
      content: '你关注的 12 个用户也关注了ta'
    };

    const event = decodeAlphaWebhook(payload);

    expect(event).toMatchObject({
      type: 'common_follow',
      externalId: 'evt-1',
      xUserId: '12345',
      handle: 'project_alpha',
      commonFollowCount: 12,
      xPostUrl: 'https://x.com/project_alpha'
    });
    expect(buildAlphaDedupeKey(event)).toBe('alpha:common_follow:evt-1:12345');
  });

  it('marks a post containing a contract address as a CA signal', () => {
    const event = decodeAlphaWebhook({
      id: 'tweet-1',
      event: 'new_tweet',
      user_id: '12345',
      text: 'CA 0x1111111111111111111111111111111111111111'
    });

    expect(event).toMatchObject({
      type: 'ca',
      externalId: 'tweet-1',
      xUserId: '12345',
      content: 'CA 0x1111111111111111111111111111111111111111'
    });
  });

  it('uses follow_user as the project identity for Alpha new_follower payloads', () => {
    const event = decodeAlphaWebhook({
      push_type: 'new_follower',
      title: '触发账号 关注了 Project Alpha',
      content: '用户简介: infra project\n你关注的 13 个用户也关注了ta',
      user: { id_str: 'trigger-account', screen_name: 'trigger' },
      follow_user: {
        id_str: '987654321',
        screen_name: 'project_alpha',
        name: 'Project Alpha',
        profile_image_url_https: 'https://pbs.twimg.com/profile_images/project.jpg'
      }
    });

    expect(event).toMatchObject({
      type: 'common_follow',
      xUserId: '987654321',
      handle: 'project_alpha',
      avatarUrl: 'https://pbs.twimg.com/profile_images/project.jpg',
      commonFollowCount: 13
    });
  });

  it('produces the same fallback key for repeated payloads without an upstream id', () => {
    const payload = { type: 'new_tweet', user_id: '12345', text: 'hello' };
    const first = decodeAlphaWebhook(payload);
    const second = decodeAlphaWebhook({ ...payload });

    expect(buildAlphaDedupeKey(first)).toBe(buildAlphaDedupeKey(second));
  });

  it('does not collide when a reused upstream id points to different projects', () => {
    const first = decodeAlphaWebhook({ id: 'trigger-user', type: 'follow', user_id: 'project-a', content: '你关注的 8 个用户也关注了ta' });
    const second = decodeAlphaWebhook({ id: 'trigger-user', type: 'follow', user_id: 'project-b', content: '你关注的 8 个用户也关注了ta' });
    expect(buildAlphaDedupeKey(first)).not.toBe(buildAlphaDedupeKey(second));
  });

  it('decodes nested Alpha tweet payloads into historical tweet signals', () => {
    const event = decodeAlphaWebhook({ type: 'tweet', user_id: '12345', tweet: { id_str: 'tweet-1', full_text: 'testnet soon', url: 'https://x.com/project_alpha/status/1' } });
    expect(event.type).toBe('new_tweet');
    expect(event.externalId).toBe('tweet-1');
    expect(event.content).toBe('testnet soon');
    expect(event.xPostUrl).toContain('/status/1');
  });

  it('rejects non-object Hook payloads', () => {
    expect(() => decodeAlphaWebhook('not-json')).toThrow('Alpha Hook payload must be an object');
  });
});
