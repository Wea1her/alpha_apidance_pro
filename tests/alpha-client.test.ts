import { describe, expect, it, vi } from 'vitest';
import {
  ALPHA_LOGIN_MESSAGE,
  buildAlphaWsUrl,
  createAlphaLoginPayload,
  isAlphaHeartbeat,
  loginAlpha
} from '../src/alpha-client.js';

describe('buildAlphaWsUrl', () => {
  it('puts the token in the alpha user websocket URL', () => {
    expect(buildAlphaWsUrl('wss://alpha.apidance.pro/api', 'token value')).toBe(
      'wss://alpha.apidance.pro/api/v1/user/ws?token=token+value'
    );
  });
});

describe('createAlphaLoginPayload', () => {
  it('signs the fixed alpha login message', async () => {
    const signer = vi.fn().mockResolvedValue('0xsig');

    await expect(createAlphaLoginPayload('0xabc', signer)).resolves.toEqual({
      address: '0xabc',
      msg: ALPHA_LOGIN_MESSAGE,
      signature: '0xsig'
    });
    expect(signer).toHaveBeenCalledWith(ALPHA_LOGIN_MESSAGE);
  });
});

describe('loginAlpha', () => {
  it('returns the token from a successful alpha API response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ code: 1, data: 'alpha-token' })
    });

    await expect(
      loginAlpha({
        baseUrl: 'https://alpha.apidance.pro/api',
        payload: { address: '0xabc', msg: ALPHA_LOGIN_MESSAGE, signature: '0xsig' },
        fetch: fetchMock
      })
    ).resolves.toBe('alpha-token');

    expect(fetchMock).toHaveBeenCalledWith('https://alpha.apidance.pro/api/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '0xabc', msg: ALPHA_LOGIN_MESSAGE, signature: '0xsig' })
    });
  });

  it('throws the alpha API message on a rejected login', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ code: 0, msg: 'not whitelist address' })
    });

    await expect(
      loginAlpha({
        baseUrl: 'https://alpha.apidance.pro/api',
        payload: { address: '0xabc', msg: ALPHA_LOGIN_MESSAGE, signature: '0xsig' },
        fetch: fetchMock
      })
    ).rejects.toThrow('not whitelist address');
  });
});

describe('isAlphaHeartbeat', () => {
  it('detects alpha heartbeat messages', () => {
    expect(isAlphaHeartbeat({ channel: 'heartbeat' })).toBe(true);
    expect(isAlphaHeartbeat({ channel: 'new_tweet' })).toBe(false);
    expect(isAlphaHeartbeat(null)).toBe(false);
  });
});
