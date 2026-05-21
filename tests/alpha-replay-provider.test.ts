import { describe, expect, it } from 'vitest';
import { createUnavailableAlphaReplayProvider } from '../src/alpha-replay-provider.js';

describe('createUnavailableAlphaReplayProvider', () => {
  it('reports replay as unavailable and returns no events', async () => {
    const provider = createUnavailableAlphaReplayProvider('no historical endpoint');

    await expect(provider.replaySince(new Date('2026-05-21T00:00:00.000Z'))).resolves.toEqual([]);
    expect(provider.available).toBe(false);
    expect(provider.reason).toBe('no historical endpoint');
  });
});
