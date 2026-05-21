# Alpha Upstream Gap Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Alpha upstream 502/fake-alive漏推风险 while making the current “no historical replay REST” boundary explicit.

**Architecture:** Keep the existing WebSocket processing pipeline and failed-message queue. Add a small Alpha replay provider interface with an unavailable default, wire a replay hook into WebSocket open, lower the business silence default, and strengthen retry queue tests.

**Tech Stack:** TypeScript, Vitest, Node fs/promises, existing `processAlphaMessage`, `FailedMessageQueue`, and `ServiceConfig`.

---

## File Structure

- Create `src/alpha-replay-provider.ts`: defines replay event/provider types and the unavailable provider factory.
- Create `tests/alpha-replay-provider.test.ts`: verifies unavailable provider behavior.
- Modify `src/config.ts`: add `alphaReplayLookbackMs` and change default business silence to 60000.
- Modify `tests/config.test.ts`: update default assertion and cover replay lookback override.
- Modify `src/service.ts`: add injectable `alphaReplayProvider`, exported `replayAlphaEvents`, and WebSocket open hook.
- Modify `tests/service.test.ts`: cover replay helper processing through `processAlphaMessage` and unavailable provider logging.
- Modify `tests/failed-message-queue.test.ts`: cover retry worker failure backoff.
- Modify `README.md`: document new defaults, replay limitation, and reliability behavior.

### Task 1: Config Defaults

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write the failing config test**

Change the first `parseServiceConfig` expectation in `tests/config.test.ts`:

```ts
businessSilenceTimeoutMs: 60000,
alphaReplayLookbackMs: 600000,
```

Add this test:

```ts
it('parses alpha replay lookback config', () => {
  expect(
    parseServiceConfig({
      ...baseEnv,
      ALPHA_REPLAY_LOOKBACK_MS: '300000'
    })
  ).toMatchObject({
    alphaReplayLookbackMs: 300000
  });
});
```

- [ ] **Step 2: Run the config test and confirm RED**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: FAIL because `alphaReplayLookbackMs` is missing and the default silence value is still 180000.

- [ ] **Step 3: Implement config changes**

In `src/config.ts`, add to `ServiceConfig`:

```ts
alphaReplayLookbackMs: number;
```

In `parseServiceConfig`, change:

```ts
businessSilenceTimeoutMs: parsePositiveInteger(env, 'ALPHA_BUSINESS_SILENCE_TIMEOUT_MS', 60_000),
alphaReplayLookbackMs: parsePositiveInteger(env, 'ALPHA_REPLAY_LOOKBACK_MS', 600_000),
```

- [ ] **Step 4: Run the config test and confirm GREEN**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: PASS.

### Task 2: Replay Provider Boundary

**Files:**
- Create: `src/alpha-replay-provider.ts`
- Create: `tests/alpha-replay-provider.test.ts`

- [ ] **Step 1: Write the failing provider tests**

Create `tests/alpha-replay-provider.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the provider test and confirm RED**

Run:

```bash
npm test -- tests/alpha-replay-provider.test.ts
```

Expected: FAIL because `src/alpha-replay-provider.ts` does not exist.

- [ ] **Step 3: Implement provider boundary**

Create `src/alpha-replay-provider.ts`:

```ts
export interface AlphaReplayEvent {
  raw: string;
  receivedAt?: Date;
}

export interface AlphaReplayProvider {
  available: boolean;
  reason?: string;
  replaySince(since: Date): Promise<AlphaReplayEvent[]>;
}

export function createUnavailableAlphaReplayProvider(reason: string): AlphaReplayProvider {
  return {
    available: false,
    reason,
    async replaySince() {
      return [];
    }
  };
}
```

- [ ] **Step 4: Run the provider test and confirm GREEN**

Run:

```bash
npm test -- tests/alpha-replay-provider.test.ts
```

Expected: PASS.

### Task 3: Replay Hook

**Files:**
- Modify: `src/service.ts`
- Modify: `tests/service.test.ts`

- [ ] **Step 1: Write failing replay helper tests**

In `tests/service.test.ts`, import:

```ts
import { createUnavailableAlphaReplayProvider, type AlphaReplayProvider } from '../src/alpha-replay-provider.js';
```

Update the service import to include `replayAlphaEvents`.

Add tests:

```ts
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

    await replayAlphaEvents({
      provider,
      since: new Date('2026-05-21T00:00:00.000Z'),
      onEvent: (raw, receivedAt) =>
        processAlphaMessage({
          raw,
          receivedAt,
          commonFollowStarLevels: [5, 8, 12, 15, 20],
          dedupe,
          send
        }),
      info: vi.fn(),
      warn: vi.fn()
    });
    await replayAlphaEvents({
      provider,
      since: new Date('2026-05-21T00:00:00.000Z'),
      onEvent: (raw, receivedAt) =>
        processAlphaMessage({
          raw,
          receivedAt,
          commonFollowStarLevels: [5, 8, 12, 15, 20],
          dedupe,
          send
        }),
      info: vi.fn(),
      warn: vi.fn()
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('⭐⭐');
  });
});
```

- [ ] **Step 2: Run service tests and confirm RED**

Run:

```bash
npm test -- tests/service.test.ts
```

Expected: FAIL because `replayAlphaEvents` is not exported.

- [ ] **Step 3: Implement replay helper and service hook**

In `src/service.ts`:

- Import `createUnavailableAlphaReplayProvider` and `type AlphaReplayProvider`.
- Add `alphaReplayProvider?: AlphaReplayProvider` to `StartAlphaServiceOptions`.
- Add exported `replayAlphaEvents`.
- Create `processRawAlphaEvent` inside `startAlphaService` to reuse the current `processAlphaMessage` options.
- On WebSocket `open`, call `replayAlphaEvents` with `since = new Date(Date.now() - options.config.alphaReplayLookbackMs)`.

- [ ] **Step 4: Run service tests and confirm GREEN**

Run:

```bash
npm test -- tests/service.test.ts
```

Expected: PASS.

### Task 4: Failed Queue Failure Backoff Test

**Files:**
- Modify: `tests/failed-message-queue.test.ts`

- [ ] **Step 1: Write failing retry worker failure test**

Add a worker test:

```ts
it('keeps failed records pending with backoff when resend fails', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-20T08:44:00.000Z'));
  const { queue } = await createQueue({ baseDelayMs: 1000 });
  await queue.enqueue(failedRecord, new Date('2026-05-16T00:00:00.000Z'));

  const delivered = new Set<string>();
  const inFlight = new Set<string>();
  const send = vi.fn().mockRejectedValue(new Error('telegram down'));

  const stop = startFailedMessageRetryWorker({
    queue,
    delivered,
    inFlight,
    send,
    intervalMs: 60_000,
    info: vi.fn(),
    warn: vi.fn()
  });

  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledTimes(1);
  });
  stop();

  const records = await queue.listAll();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    dedupeKey: failedRecord.dedupeKey,
    retryCount: 1,
    lastError: 'telegram down',
    nextRetryAt: '2026-05-20T08:44:01.000Z'
  });
  expect(delivered.has(failedRecord.dedupeKey)).toBe(false);
  expect(inFlight.size).toBe(0);
});
```

- [ ] **Step 2: Run queue tests**

Run:

```bash
npm test -- tests/failed-message-queue.test.ts
```

Expected: PASS if current implementation already handles this; if it fails, fix `startFailedMessageRetryWorker` or `FailedMessageQueue.markFailure` minimally.

### Task 5: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update env example**

Add:

```env
ALPHA_BUSINESS_SILENCE_TIMEOUT_MS=60000
ALPHA_REPLAY_LOOKBACK_MS=600000
```

- [ ] **Step 2: Update config explanation**

Add short explanations:

```md
`ALPHA_BUSINESS_SILENCE_TIMEOUT_MS` 是业务消息静默 watchdog，默认 60 秒。超过该时间没有收到非 heartbeat 业务消息会主动重连。

`ALPHA_REPLAY_LOOKBACK_MS` 是未来 Alpha 历史回放 provider 可用时的回看窗口，默认 10 分钟。当前未发现可用历史事件 REST 接口，因此不会补回上游没有下发的事件。
```

- [ ] **Step 3: Update reliability section**

Add:

```text
业务消息静默 60 秒主动重连
Alpha 历史回放 provider 边界已预留；当前上游没有历史事件 REST 接口时不伪造补漏
```

Replace the old warning with a precise statement that upstream-not-sent events cannot be reconstructed without a real historical event API.

### Task 6: Verification and Commit

**Files:**
- All changed implementation, tests, docs.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- tests/config.test.ts tests/alpha-replay-provider.test.ts tests/failed-message-queue.test.ts tests/service.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/alpha-replay-provider.ts src/config.ts src/service.ts tests/alpha-replay-provider.test.ts tests/config.test.ts tests/failed-message-queue.test.ts tests/service.test.ts README.md docs/superpowers/plans/2026-05-21-alpha-upstream-gap-recovery.md
git commit -m "fix: 优化Alpha上游漏推恢复"
```

Expected: commit created.

## Self-Review

- Spec coverage: config default, failed queue tests, replay provider boundary, service replay hook, and README limitation are all covered.
- Completeness scan: no unfinished markers or vague steps remain.
- Type consistency: `AlphaReplayProvider`, `AlphaReplayEvent`, `alphaReplayLookbackMs`, and `replayAlphaEvents` names are consistent across tasks.
