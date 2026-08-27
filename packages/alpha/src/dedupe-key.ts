import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

/** Creates a transport-independent key for payloads that do not contain an upstream id. */
export function buildAlphaPayloadDedupeKey(payload: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex')
    .slice(0, 32);
  return `alpha:payload:${digest}`;
}
