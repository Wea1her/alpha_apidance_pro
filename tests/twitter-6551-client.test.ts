import { describe, expect, it, vi } from 'vitest';
import { createTwitter6551Client } from '../src/twitter-6551-client.js';

describe('twitter 6551 client', () => {
  it('posts to 6551 open endpoints with bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ data: [{ text: 'hello' }] })
    });
    const client = createTwitter6551Client({
      token: 'token',
      baseUrl: 'https://ai.6551.io',
      fetch: fetchMock as unknown as typeof fetch
    });

    await expect(client.postOpen('twitter_user_info', { username: 'abc' })).resolves.toEqual({
      data: [{ text: 'hello' }]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ai.6551.io/open/twitter_user_info',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username: 'abc' })
      })
    );
  });

  it('throws a useful error when 6551 returns a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited'
    });
    const client = createTwitter6551Client({
      token: 'token',
      baseUrl: 'https://ai.6551.io',
      fetch: fetchMock as unknown as typeof fetch
    });

    await expect(client.postOpen('twitter_user_info', { username: 'abc' })).rejects.toThrow(
      '6551 request failed: 429 rate limited'
    );
  });
});
