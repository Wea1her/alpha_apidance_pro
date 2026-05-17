# Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add practical runtime hardening for xAI calls, process crashes, PM2 deployment, and project push state persistence.

**Architecture:** Keep the existing Alpha WebSocket and queue architecture. Add one focused JSON state store for project push state, extend the existing retry helper usage into xAI calls, and add deployment/runtime wrappers without changing event processing semantics.

**Tech Stack:** TypeScript ESM, Node.js 22, `ws`, `undici`, Vitest, PM2 ecosystem config, JSON file persistence.

---

## File Structure

- Create `src/project-state-store.ts`: load/save project stars, push counts, and first channel messages using atomic JSON writes.
- Create `tests/project-state-store.test.ts`: unit tests for missing files, round-trip persistence, invalid JSON fallback, and map hydration.
- Modify `src/config.ts`: add `projectStatePath` to `ServiceConfig`, parse `PROJECT_STATE_PATH`.
- Modify `tests/config.test.ts`: assert default and custom project state path.
- Modify `src/service.ts`: load persisted project state before processing, persist after successful main push and successful failed-push replay.
- Modify `tests/service.test.ts`: verify persistence callback is called on success and not called on failed main push.
- Modify `src/xai-client.ts`: wrap xAI HTTP operation with retry for network errors, 429, and 5xx.
- Modify `tests/xai-client.test.ts`: add red tests for retryable and non-retryable xAI failures.
- Create `src/fatal.ts`: install fatal process handlers in a testable helper.
- Create `tests/fatal.test.ts`: verify handler logs once and exits with code 1.
- Modify `src/main.ts`: install fatal handlers before starting the service.
- Create `ecosystem.config.cjs`: PM2 app config.
- Modify `README.md` and `.env.example`: document PM2 config and `PROJECT_STATE_PATH`.

## Task 1: xAI Short Retry

**Files:**
- Modify: `src/xai-client.ts`
- Test: `tests/xai-client.test.ts`

- [ ] **Step 1: Write failing retry tests**

Append these tests in `tests/xai-client.test.ts` inside `describe('requestGrokAnalysis', ...)`:

```ts
  it('retries retryable xAI HTTP failures before returning content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'server error'
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: 'retry ok' } }]
          })
      });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        fetch: fetchMock as unknown as typeof fetch,
        retryMinDelayMs: 0
      })
    ).resolves.toBe('retry ok');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable xAI HTTP failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request'
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        fetch: fetchMock as unknown as typeof fetch,
        retryMinDelayMs: 0
      })
    ).rejects.toThrow('xAI request failed: 400 bad request');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- tests/xai-client.test.ts
```

Expected: TypeScript/Vitest fails because `retryMinDelayMs` is not part of `RequestGrokAnalysisOptions` or because the 500 case does not retry.

- [ ] **Step 3: Implement minimal xAI retry support**

In `src/xai-client.ts`:

- Import `retry`.
- Add optional retry fields to `RequestGrokAnalysisOptions`.
- Add an `XaiHttpError` class.
- Use `retry` around the HTTP fetch/parse operation.

Implementation shape:

```ts
import { retry } from './retry.js';

class XaiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function isRetryableXaiError(error: unknown): boolean {
  if (error instanceof XaiHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}
```

Extend options:

```ts
  retryAttempts?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
```

Wrap the existing request body:

```ts
  return retry(
    async () => {
      const response = await fetchImpl(...);
      const body = await response.text();
      if (!response.ok) {
        throw new XaiHttpError(`xAI request failed: ${response.status} ${body}`, response.status);
      }
      ...
      return content.trim();
    },
    {
      attempts: options.retryAttempts ?? 3,
      minDelayMs: options.retryMinDelayMs ?? 1_000,
      maxDelayMs: options.retryMaxDelayMs ?? 10_000,
      shouldRetry: isRetryableXaiError,
      onRetry: options.onRetry
    }
  );
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/xai-client.test.ts
```

Expected: all `xai-client` tests pass.

## Task 2: Project State Store

**Files:**
- Create: `src/project-state-store.ts`
- Create: `tests/project-state-store.test.ts`

- [ ] **Step 1: Write failing project state store tests**

Create `tests/project-state-store.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectStateStore,
  hydrateProjectStateMaps,
  serializeProjectStateMaps
} from '../src/project-state-store.js';

async function tempPath(name = 'project-state.json') {
  const dir = await mkdtemp(join(tmpdir(), 'project-state-'));
  return join(dir, name);
}

describe('ProjectStateStore', () => {
  it('returns empty state when the file does not exist', async () => {
    const warn = vi.fn();
    const store = new ProjectStateStore({ filePath: await tempPath(), warn });

    await expect(store.load()).resolves.toEqual({ version: 1, projects: {} });
    expect(warn).not.toHaveBeenCalled();
  });

  it('persists and reloads project state', async () => {
    const filePath = await tempPath();
    const store = new ProjectStateStore({ filePath });

    await store.save({
      version: 1,
      projects: {
        b: {
          star: 2,
          pushCount: 2,
          firstChannelMessage: { chatId: -1001234567890, messageId: 321 },
          updatedAt: '2026-05-17T00:00:00.000Z'
        }
      }
    });

    await expect(store.load()).resolves.toEqual({
      version: 1,
      projects: {
        b: {
          star: 2,
          pushCount: 2,
          firstChannelMessage: { chatId: -1001234567890, messageId: 321 },
          updatedAt: '2026-05-17T00:00:00.000Z'
        }
      }
    });
  });

  it('falls back to empty state when JSON is invalid', async () => {
    const filePath = await tempPath();
    await writeFile(filePath, '{bad json', 'utf8');
    const warn = vi.fn();
    const store = new ProjectStateStore({ filePath, warn });

    await expect(store.load()).resolves.toEqual({ version: 1, projects: {} });
    expect(warn.mock.calls[0][0]).toContain('读取项目状态失败');
  });
});

describe('project state map helpers', () => {
  it('hydrates and serializes service maps', () => {
    const stars = new Map<string, number>();
    const pushCounts = new Map<string, number>();
    const firstMessages = new Map<string, { chatId: number; messageId: number }>();

    hydrateProjectStateMaps(
      {
        version: 1,
        projects: {
          b: {
            star: 3,
            pushCount: 3,
            firstChannelMessage: { chatId: -1001, messageId: 10 },
            updatedAt: '2026-05-17T00:00:00.000Z'
          }
        }
      },
      stars,
      pushCounts,
      firstMessages
    );

    expect(stars.get('b')).toBe(3);
    expect(pushCounts.get('b')).toBe(3);
    expect(firstMessages.get('b')).toEqual({ chatId: -1001, messageId: 10 });

    expect(serializeProjectStateMaps(stars, pushCounts, firstMessages, new Date('2026-05-17T01:00:00.000Z'))).toEqual({
      version: 1,
      projects: {
        b: {
          star: 3,
          pushCount: 3,
          firstChannelMessage: { chatId: -1001, messageId: 10 },
          updatedAt: '2026-05-17T01:00:00.000Z'
        }
      }
    });
  });
});
```

- [ ] **Step 2: Run store tests and verify RED**

Run:

```bash
npm test -- tests/project-state-store.test.ts
```

Expected: FAIL because `src/project-state-store.ts` does not exist.

- [ ] **Step 3: Implement project state store**

Create `src/project-state-store.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChannelMessageReference } from './service.js';

export interface ProjectStateRecord {
  star: number;
  pushCount: number;
  firstChannelMessage?: ChannelMessageReference;
  updatedAt: string;
}

export interface ProjectStateFile {
  version: 1;
  projects: Record<string, ProjectStateRecord>;
}

export interface ProjectStateStoreOptions {
  filePath: string;
  warn?: (message: string) => void;
}

export class ProjectStateStore {
  private readonly filePath: string;
  private readonly warn: (message: string) => void;

  constructor(options: ProjectStateStoreOptions) {
    this.filePath = options.filePath;
    this.warn = options.warn ?? console.warn;
  }

  async load(): Promise<ProjectStateFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ProjectStateFile;
      if (parsed.version !== 1 || !parsed.projects || typeof parsed.projects !== 'object') {
        throw new Error('invalid project state format');
      }
      return parsed;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, projects: {} };
      }
      this.warn(`读取项目状态失败，使用空状态：${error instanceof Error ? error.message : String(error)}`);
      return { version: 1, projects: {} };
    }
  }

  async save(state: ProjectStateFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}

export function hydrateProjectStateMaps(
  state: ProjectStateFile,
  projectStars: Map<string, number>,
  projectPushCounts: Map<string, number>,
  projectFirstChannelMessages: Map<string, ChannelMessageReference>
): void {
  for (const [projectKey, record] of Object.entries(state.projects)) {
    projectStars.set(projectKey, record.star);
    projectPushCounts.set(projectKey, record.pushCount);
    if (record.firstChannelMessage) {
      projectFirstChannelMessages.set(projectKey, record.firstChannelMessage);
    }
  }
}

export function serializeProjectStateMaps(
  projectStars: Map<string, number>,
  projectPushCounts: Map<string, number>,
  projectFirstChannelMessages: Map<string, ChannelMessageReference>,
  now = new Date()
): ProjectStateFile {
  const projects: ProjectStateFile['projects'] = {};
  const keys = new Set<string>([
    ...projectStars.keys(),
    ...projectPushCounts.keys(),
    ...projectFirstChannelMessages.keys()
  ]);
  for (const key of keys) {
    projects[key] = {
      star: projectStars.get(key) ?? 0,
      pushCount: projectPushCounts.get(key) ?? 0,
      firstChannelMessage: projectFirstChannelMessages.get(key),
      updatedAt: now.toISOString()
    };
  }
  return { version: 1, projects };
}
```

- [ ] **Step 4: Run store tests and verify GREEN**

Run:

```bash
npm test -- tests/project-state-store.test.ts
```

Expected: all project state store tests pass.

## Task 3: Config And Service Integration

**Files:**
- Modify: `src/config.ts`
- Modify: `src/service.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/service.test.ts`

- [ ] **Step 1: Write failing config test**

In `tests/config.test.ts`, add `PROJECT_STATE_PATH` to the first test expected object:

```ts
projectStatePath: 'data/project-state.json'
```

Add a dedicated custom path test:

```ts
  it('parses project state path config', () => {
    expect(
      parseServiceConfig({
        ALPHA_WALLET_PRIVATE_KEY: '0xabc',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-100123',
        PROJECT_STATE_PATH: 'data/custom-project-state.json'
      })
    ).toMatchObject({
      projectStatePath: 'data/custom-project-state.json'
    });
  });
```

- [ ] **Step 2: Run config tests and verify RED**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: FAIL because `projectStatePath` is not parsed.

- [ ] **Step 3: Implement config parsing**

In `src/config.ts`:

```ts
projectStatePath: string;
```

and inside `parseServiceConfig`:

```ts
projectStatePath: env.PROJECT_STATE_PATH?.trim() || 'data/project-state.json',
```

- [ ] **Step 4: Run config tests and verify GREEN**

Run:

```bash
npm test -- tests/config.test.ts
```

Expected: all config tests pass.

- [ ] **Step 5: Write failing service persistence tests**

In `src/service.ts`, add an optional `persistProjectState?: () => Promise<void>;` to `ProcessAlphaMessageOptions` during the test step only if needed by TypeScript.

In `tests/service.test.ts`, add:

```ts
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
```

- [ ] **Step 6: Run service tests and verify RED**

Run:

```bash
npm test -- tests/service.test.ts
```

Expected: FAIL because service does not persist state after successful sends.

- [ ] **Step 7: Implement service persistence hook**

In `src/service.ts`:

- Import `ProjectStateStore`, `hydrateProjectStateMaps`, `serializeProjectStateMaps`.
- Add `persistProjectState?: () => Promise<void>;` to `ProcessAlphaMessageOptions`.
- After successful `send` and map updates, call `await options.persistProjectState?.();`.
- In `startAlphaService`, create store:

```ts
  const projectStateStore = new ProjectStateStore({
    filePath: options.config.projectStatePath,
    warn
  });
  const persistProjectState = async (): Promise<void> => {
    try {
      await projectStateStore.save(
        serializeProjectStateMaps(projectStars, projectPushCounts, projectFirstChannelMessages)
      );
    } catch (error) {
      warn(`写入项目状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
```

- Before connecting, load state:

```ts
  hydrateProjectStateMaps(
    await projectStateStore.load(),
    projectStars,
    projectPushCounts,
    projectFirstChannelMessages
  );
```

- Pass `persistProjectState` into `processAlphaMessage`.
- In `handleAfterMainSend`, after `projectFirstChannelMessages.set(...)`, call `await persistProjectState();` so failed queue replay also persists after the queue worker delivers a message.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/config.test.ts tests/service.test.ts tests/project-state-store.test.ts
```

Expected: all focused tests pass.

## Task 4: Fatal Handler, PM2 Config, And Docs

**Files:**
- Create: `src/fatal.ts`
- Create: `tests/fatal.test.ts`
- Create: `ecosystem.config.cjs`
- Modify: `src/main.ts`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write failing fatal handler tests**

Create `tests/fatal.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createFatalErrorHandler } from '../src/fatal.js';

describe('createFatalErrorHandler', () => {
  it('logs and exits with code 1 once', () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const exit = vi.fn();
    const handler = createFatalErrorHandler({
      error,
      exit: exit as unknown as (code: number) => never,
      delayMs: 10
    });

    handler('uncaughtException', new Error('boom'));
    handler('unhandledRejection', new Error('again'));
    vi.advanceTimersByTime(10);
    vi.useRealTimers();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('fatal uncaughtException');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run fatal tests and verify RED**

Run:

```bash
npm test -- tests/fatal.test.ts
```

Expected: FAIL because `src/fatal.ts` does not exist.

- [ ] **Step 3: Implement fatal helper**

Create `src/fatal.ts`:

```ts
export interface FatalErrorHandlerOptions {
  error?: (message?: unknown, ...optionalParams: unknown[]) => void;
  exit?: (code: number) => never;
  delayMs?: number;
}

export function createFatalErrorHandler(options: FatalErrorHandlerOptions = {}) {
  const logError = options.error ?? console.error;
  const exit = options.exit ?? process.exit;
  const delayMs = options.delayMs ?? 100;
  let exiting = false;

  return (type: 'uncaughtException' | 'unhandledRejection', reason: unknown): void => {
    if (exiting) return;
    exiting = true;
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    logError(`[fatal ${type}] ${message}`);
    setTimeout(() => {
      exit(1);
    }, delayMs);
  };
}

export function installFatalErrorHandlers(): void {
  const handler = createFatalErrorHandler();
  process.on('uncaughtException', (error) => {
    handler('uncaughtException', error);
  });
  process.on('unhandledRejection', (reason) => {
    handler('unhandledRejection', reason);
  });
}
```

Modify `src/main.ts`:

```ts
import { installFatalErrorHandlers } from './fatal.js';

installFatalErrorHandlers();
```

- [ ] **Step 4: Run fatal tests and verify GREEN**

Run:

```bash
npm test -- tests/fatal.test.ts
```

Expected: fatal tests pass.

- [ ] **Step 5: Add PM2 config and docs**

Create `ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: 'daxinjiankong',
      script: 'npm',
      args: 'start',
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '512M',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      time: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
```

Modify README 24-hour deployment start command:

```bash
pm2 start ecosystem.config.cjs
```

Add `.env.example` line:

```env
PROJECT_STATE_PATH=
```

- [ ] **Step 6: Run docs/config static checks**

Run:

```bash
rg -n "pm2 start ecosystem.config.cjs|PROJECT_STATE_PATH|project-state" README.md .env.example ecosystem.config.cjs
```

Expected: output includes all three files.

## Task 5: Final Verification

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run TypeScript typecheck**

Run:

```bash
npm run typecheck
```

Expected: command exits 0 with no TypeScript errors.

- [ ] **Step 3: Review git diff**

Run:

```bash
git diff --stat
git diff -- src/xai-client.ts src/project-state-store.ts src/service.ts src/config.ts src/main.ts src/fatal.ts README.md .env.example ecosystem.config.cjs
```

Expected: diff only contains reliability hardening changes from this plan.

- [ ] **Step 4: Commit implementation**

Run:

```bash
git add src tests README.md .env.example ecosystem.config.cjs docs/superpowers/plans/2026-05-17-reliability-hardening.md
git commit -m "feat: harden service reliability"
```

Expected: commit succeeds.

## Self-Review

- Spec coverage: PM2 config is Task 4, fatal handlers are Task 4, xAI retry is Task 1, project state persistence is Tasks 2 and 3, verification is Task 5.
- Marker scan: no unfinished markers are present.
- Type consistency: `projectStatePath`, `ProjectStateStore`, `hydrateProjectStateMaps`, `serializeProjectStateMaps`, and `persistProjectState` names are consistent across tasks.
