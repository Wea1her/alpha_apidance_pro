import { describe, expect, it } from 'vitest';
import { buildAlphaPayloadDedupeKey } from '../src/dedupe-key.js';

describe('Alpha payload dedupe key', () => {
  it('ignores object key order', () => {
    expect(buildAlphaPayloadDedupeKey({ b: 2, a: { d: 4, c: 3 } })).toBe(
      buildAlphaPayloadDedupeKey({ a: { c: 3, d: 4 }, b: 2 })
    );
  });
});
