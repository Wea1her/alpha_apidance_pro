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
    expect(buildAlphaDedupeKey(event)).toBe('alpha:evt-1');
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

  it('rejects non-object Hook payloads', () => {
    expect(() => decodeAlphaWebhook('not-json')).toThrow('Alpha Hook payload must be an object');
  });
});
