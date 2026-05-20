# Grok 分析归档导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从功能上线后开始归档已完成 Grok 分析，并允许授权 Telegram 聊天用中文命令导出指定小时范围内的 Markdown 复盘文档。

**Architecture:** 新增本地 JSONL 归档层保存 `analysis` 和 `hit` 记录；新增纯函数导出层负责时间解析、权限判断、项目合并和 Markdown 渲染；复用现有 Telegram updates poller 处理中文命令，避免多个 `getUpdates` 消费者互相抢 update。服务层在分析成功或重复命中提醒成功后写归档，并从归档恢复 `AnalysisTracker`。

**Tech Stack:** TypeScript、Vitest、Node fs/promises、Telegram Bot API、现有 `retry`/`fetchTelegramUpdates`/`sendTelegramMessage` 基础设施。

---

## File Structure

- Create `src/analysis-archive-store.ts`
  - 负责 `data/analysis-archive.jsonl` 的读写、坏行跳过、按 `sourceTaskKey` 幂等 upsert、查询项目是否已有分析、恢复 `AnalysisTracker` 所需映射。
- Create `tests/analysis-archive-store.test.ts`
  - 覆盖归档读写、坏行、幂等、项目分析查询。
- Create `src/analysis-export.ts`
  - 负责 `YYYY-MM-DDTHH` 上海时间解析、导出权限判断、记录筛选合并、Markdown 渲染、导出文件名生成。
- Create `tests/analysis-export.test.ts`
  - 覆盖小时范围、username/chat ID 权限、按项目合并、最高星级分组、同星级关注数排序、空结果。
- Create `src/telegram-command.ts`
  - 负责从 `message` 与 `channel_post` 中解析 `查看聊天ID`、`导出分析 ...`、`/chatid`、`/export_analysis ...`。
- Create `tests/telegram-command.test.ts`
  - 覆盖中文命令、英文别名、频道消息、普通消息、错误格式。
- Modify `src/telegram.ts`
  - 新增 `sendTelegramDocument`，复用现有 retry 参数和代理参数。
- Modify `tests/telegram.test.ts`
  - 覆盖 `sendDocument` URL、multipart body、返回 message id。
- Modify `src/config.ts`
  - 新增 `analysisArchivePath`、`exportAdminUsernames`、`exportAllowedChatIds`。
- Modify `tests/config.test.ts`
  - 覆盖默认值和自定义值。
- Modify `.env.example` and `README.md`
  - 写入新配置和中文命令说明。
- Modify `src/analysis-task-queue.ts`
  - 给分析任务增加 `mainPushedAt`，用于导出筛选。
- Modify `tests/analysis-task-queue.test.ts`
  - 覆盖任务持久化包含 `mainPushedAt`。
- Modify `src/analysis-service.ts`
  - 把返回值从 `TelegramSendResult | void` 改成结构化 union，包含首次分析正文或重复提醒消息。
- Modify `tests/analysis-service.test.ts`
  - 覆盖首次分析返回 `analysisText`，重复提醒返回 `reminder`。
- Modify `src/discussion-poller.ts`
  - 新增 `onUpdates` 回调，在同一个 `getUpdates` 循环里处理导出命令。
- Modify `tests/discussion-poller.test.ts`
  - 覆盖 `onUpdates` 被调用，并且 offset 在处理后推进。
- Modify `src/service.ts`
  - 创建归档 store，恢复 `AnalysisTracker`，记录主推送成功时间，写入分析/命中归档，处理导出命令并发送 Markdown 文件。
- Modify `tests/service.test.ts`
  - 增加局部单元测试覆盖 `afterSend` 接口带 `mainPushedAt`，避免破坏现有推送流程。

---

### Task 1: 配置与 Telegram 文件发送

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `src/telegram.ts`
- Modify: `tests/telegram.test.ts`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: 写配置失败测试**

Add to `tests/config.test.ts`:

```ts
it('parses analysis archive export config', () => {
  const config = parseServiceConfig({
    ...baseEnv,
    ANALYSIS_ARCHIVE_PATH: 'data/custom-analysis-archive.jsonl',
    EXPORT_ADMIN_USERNAMES: 'Alice,@Bob',
    EXPORT_ALLOWED_CHAT_IDS: '-1001,-1002'
  });

  expect(config.analysisArchivePath).toBe('data/custom-analysis-archive.jsonl');
  expect(config.exportAdminUsernames).toEqual(['Alice', '@Bob']);
  expect(config.exportAllowedChatIds).toEqual(['-1001', '-1002']);
});
```

Run: `npm test -- tests/config.test.ts`

Expected: FAIL because `analysisArchivePath`, `exportAdminUsernames`, and `exportAllowedChatIds` do not exist on `ServiceConfig`.

- [ ] **Step 2: 实现配置解析**

Modify `src/config.ts` by adding these fields to `ServiceConfig` immediately after `projectStatePath`:

```ts
analysisArchivePath: string;
exportAdminUsernames: string[];
exportAllowedChatIds: string[];
```

Add this helper near `parsePositiveInteger`:

```ts
function parseCsvList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
```

Add these properties at the end of the `parseServiceConfig` return object, directly after `projectStatePath`:

```ts
analysisArchivePath: env.ANALYSIS_ARCHIVE_PATH?.trim() || 'data/analysis-archive.jsonl',
exportAdminUsernames: parseCsvList(env.EXPORT_ADMIN_USERNAMES),
exportAllowedChatIds: parseCsvList(env.EXPORT_ALLOWED_CHAT_IDS)
```

- [ ] **Step 3: 运行配置测试**

Run: `npm test -- tests/config.test.ts`

Expected: PASS.

- [ ] **Step 4: 写 Telegram document 失败测试**

Add to `tests/telegram.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replyInTelegramThread, sendTelegramDocument, sendTelegramMessage } from '../src/telegram.js';

it('sends a markdown document through Telegram', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-document-'));
  const filePath = join(dir, 'report.md');
  await writeFile(filePath, '# report\n', 'utf8');
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    text: async () =>
      JSON.stringify({
        ok: true,
        result: {
          message_id: 456,
          chat: { id: -100123 }
        }
      })
  });

  await expect(
    sendTelegramDocument({
      botToken: 'token',
      chatId: '-100123',
      filePath,
      filename: 'report.md',
      caption: '导出完成',
      fetch: fetchMock as unknown as typeof fetch
    })
  ).resolves.toEqual({ messageId: 456, chatId: -100123 });

  expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/bottoken/sendDocument');
  expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST' }));
});
```

Run: `npm test -- tests/telegram.test.ts`

Expected: FAIL because `sendTelegramDocument` is not exported.

- [ ] **Step 5: 实现 Telegram document 发送**

Modify `src/telegram.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { File, FormData, ProxyAgent } from 'undici';

export interface SendTelegramDocumentOptions {
  botToken: string;
  chatId: string;
  filePath: string;
  filename?: string;
  caption?: string;
  proxyUrl?: string;
  fetch?: typeof fetch;
  retryAttempts?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export async function sendTelegramDocument(options: SendTelegramDocumentOptions): Promise<TelegramSendResult> {
  const fetchImpl = (options.fetch ?? fetch) as FetchWithDispatcher;
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  return retry(
    async () => {
      const bytes = await readFile(options.filePath);
      const form = new FormData();
      form.set('chat_id', options.chatId);
      if (options.caption) form.set('caption', options.caption);
      form.set(
        'document',
        new File([bytes], options.filename ?? basename(options.filePath), { type: 'text/markdown; charset=utf-8' })
      );

      const response = await fetchImpl(`https://api.telegram.org/bot${options.botToken}/sendDocument`, {
        method: 'POST',
        dispatcher,
        body: form as unknown as BodyInit
      });
      const body = await response.text();
      if (!response.ok) {
        throw new TelegramHttpError(`telegram sendDocument failed: ${response.status} ${body}`, response.status);
      }
      const parsed = JSON.parse(body) as {
        ok?: boolean;
        result?: { message_id?: number; chat?: { id?: number } };
        description?: string;
      };
      if (
        !parsed.ok ||
        typeof parsed.result?.message_id !== 'number' ||
        typeof parsed.result?.chat?.id !== 'number'
      ) {
        throw new Error(parsed.description ?? 'telegram sendDocument returned invalid payload');
      }
      return { messageId: parsed.result.message_id, chatId: parsed.result.chat.id };
    },
    {
      attempts: options.retryAttempts ?? 5,
      minDelayMs: options.retryMinDelayMs ?? 1_000,
      maxDelayMs: options.retryMaxDelayMs ?? 30_000,
      shouldRetry: isRetryableTelegramError,
      onRetry: options.onRetry
    }
  );
}
```

Merge imports with the existing `ProxyAgent` import instead of duplicating it.

- [ ] **Step 6: 更新环境示例和 README**

Append to `.env.example`:

```env
ANALYSIS_ARCHIVE_PATH=
EXPORT_ADMIN_USERNAMES=
EXPORT_ALLOWED_CHAT_IDS=
```

Add to README configuration section:

```markdown
`ANALYSIS_ARCHIVE_PATH` 是 Grok 分析归档文件，默认 `data/analysis-archive.jsonl`。

`EXPORT_ADMIN_USERNAMES` 是允许触发分析导出的 Telegram 用户名列表，逗号分隔，带不带 `@` 都可以。

`EXPORT_ALLOWED_CHAT_IDS` 是允许触发分析导出的 Telegram 聊天 ID 列表，逗号分隔。频道内导出建议使用这个配置。
```

- [ ] **Step 7: 运行本任务测试并提交**

Run:

```bash
npm test -- tests/config.test.ts tests/telegram.test.ts
npm run typecheck
```

Expected: both commands exit 0.

Commit:

```bash
git add .env.example README.md src/config.ts src/telegram.ts tests/config.test.ts tests/telegram.test.ts
git commit -m "feat: add analysis export config and document sending"
```

---

### Task 2: 分析归档存储

**Files:**
- Create: `src/analysis-archive-store.ts`
- Create: `tests/analysis-archive-store.test.ts`

- [ ] **Step 1: 写归档存储失败测试**

Create `tests/analysis-archive-store.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisArchiveStore } from '../src/analysis-archive-store.js';

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), 'analysis-archive-'));
  return {
    dir,
    store: new AnalysisArchiveStore({ filePath: join(dir, 'analysis-archive.jsonl'), warn: vi.fn() })
  };
}

const analysisRecord = {
  version: 1 as const,
  recordType: 'analysis' as const,
  sourceTaskKey: '-1001:10',
  projectKey: 'project-a',
  title: 'A 关注了 Project A',
  content: '你关注的12个用户也关注了ta',
  link: 'https://x.com/project_a',
  mainPushedAt: '2026-05-20T02:00:00.000Z',
  archivedAt: '2026-05-20T02:01:00.000Z',
  analysisCreatedAt: '2026-05-20T02:01:00.000Z',
  star: 3,
  count: 12,
  channelMessage: { chatId: -1001, messageId: 10 },
  discussionAnalysisMessage: { chatId: '-1002', messageId: 20 },
  analysisText: '完整分析'
};

describe('AnalysisArchiveStore', () => {
  it('upserts archive records by sourceTaskKey', async () => {
    const { store } = await createStore();
    await store.upsert(analysisRecord);
    await store.upsert({ ...analysisRecord, count: 15, analysisText: '更新后的分析' });

    await expect(store.listAll()).resolves.toEqual([
      expect.objectContaining({ sourceTaskKey: '-1001:10', count: 15, analysisText: '更新后的分析' })
    ]);
  });

  it('skips invalid JSONL lines with a warning', async () => {
    const { dir, store } = await createStore();
    await writeFile(
      join(dir, 'analysis-archive.jsonl'),
      `${JSON.stringify(analysisRecord)}\n{bad json\n`,
      'utf8'
    );

    await expect(store.listAll()).resolves.toEqual([analysisRecord]);
  });

  it('finds the first analysis record for a project', async () => {
    const { store } = await createStore();
    await store.upsert(analysisRecord);
    await store.upsert({
      ...analysisRecord,
      recordType: 'hit',
      sourceTaskKey: '-1001:11',
      channelMessage: { chatId: -1001, messageId: 11 }
    });

    await expect(store.getFirstAnalysis('project-a')).resolves.toEqual(analysisRecord);
    await expect(store.hasAnalysis('project-a')).resolves.toBe(true);
  });

  it('hydrates analysis tracker entries from analysis records', async () => {
    const { store } = await createStore();
    await store.upsert(analysisRecord);

    await expect(store.listAnalysisTrackerEntries()).resolves.toEqual([
      ['project-a', { discussionChatId: '-1002', analysisMessageId: 20 }]
    ]);
  });
});
```

Run: `npm test -- tests/analysis-archive-store.test.ts`

Expected: FAIL because `src/analysis-archive-store.ts` does not exist.

- [ ] **Step 2: 实现归档存储**

Create `src/analysis-archive-store.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StoredAnalysis } from './analysis-tracker.js';

export interface AnalysisArchiveMessageRef {
  chatId: number;
  messageId: number;
}

export interface AnalysisArchiveAnalysisRecord {
  version: 1;
  recordType: 'analysis';
  sourceTaskKey: string;
  projectKey: string;
  title: string;
  content: string;
  link: string;
  mainPushedAt: string;
  archivedAt: string;
  analysisCreatedAt: string;
  star: number;
  count: number;
  channelMessage: AnalysisArchiveMessageRef;
  discussionAnalysisMessage: { chatId: string | number; messageId: number };
  analysisText: string;
}

export interface AnalysisArchiveHitRecord {
  version: 1;
  recordType: 'hit';
  sourceTaskKey: string;
  projectKey: string;
  title: string;
  content: string;
  link: string;
  mainPushedAt: string;
  archivedAt: string;
  star: number;
  count: number;
  channelMessage: AnalysisArchiveMessageRef;
  discussionAnalysisMessage: { chatId: string | number; messageId: number };
  reminderMessage?: AnalysisArchiveMessageRef;
}

export type AnalysisArchiveRecord = AnalysisArchiveAnalysisRecord | AnalysisArchiveHitRecord;

export class AnalysisArchiveStore {
  private readonly filePath: string;
  private readonly warn: (message: string) => void;

  constructor(options: { filePath: string; warn?: (message: string) => void }) {
    this.filePath = options.filePath;
    this.warn = options.warn ?? console.warn;
  }

  async listAll(): Promise<AnalysisArchiveRecord[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const records: AnalysisArchiveRecord[] = [];
    for (const [index, line] of content.split('\n').entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as AnalysisArchiveRecord);
      } catch (error) {
        this.warn(`跳过无效分析归档行：line=${index + 1} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return records;
  }

  async upsert(record: AnalysisArchiveRecord): Promise<void> {
    const records = await this.listAll();
    await mkdir(dirname(this.filePath), { recursive: true });
    const next = [...records.filter((existing) => existing.sourceTaskKey !== record.sourceTaskKey), record];
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${next.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }

  async getFirstAnalysis(projectKey: string): Promise<AnalysisArchiveAnalysisRecord | null> {
    const analyses = (await this.listAll())
      .filter((record): record is AnalysisArchiveAnalysisRecord => record.recordType === 'analysis' && record.projectKey === projectKey)
      .sort((a, b) => new Date(a.mainPushedAt).getTime() - new Date(b.mainPushedAt).getTime());
    return analyses[0] ?? null;
  }

  async hasAnalysis(projectKey: string): Promise<boolean> {
    return (await this.getFirstAnalysis(projectKey)) !== null;
  }

  async listAnalysisTrackerEntries(): Promise<Array<[string, StoredAnalysis]>> {
    const entries: Array<[string, StoredAnalysis]> = [];
    const seen = new Set<string>();
    for (const record of await this.listAll()) {
      if (record.recordType !== 'analysis' || seen.has(record.projectKey)) continue;
      seen.add(record.projectKey);
      entries.push([
        record.projectKey,
        {
          discussionChatId: String(record.discussionAnalysisMessage.chatId),
          analysisMessageId: record.discussionAnalysisMessage.messageId
        }
      ]);
    }
    return entries;
  }
}
```

- [ ] **Step 3: 运行归档存储测试并提交**

Run:

```bash
npm test -- tests/analysis-archive-store.test.ts
npm run typecheck
```

Expected: both commands exit 0.

Commit:

```bash
git add src/analysis-archive-store.ts tests/analysis-archive-store.test.ts
git commit -m "feat: add analysis archive store"
```

---

### Task 3: 导出纯函数与 Markdown 渲染

**Files:**
- Create: `src/analysis-export.ts`
- Create: `tests/analysis-export.test.ts`

- [ ] **Step 1: 写导出失败测试**

Create `tests/analysis-export.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildAnalysisExport,
  isExportAuthorized,
  parseShanghaiHourRange
} from '../src/analysis-export.js';
import type { AnalysisArchiveRecord } from '../src/analysis-archive-store.js';

const records: AnalysisArchiveRecord[] = [
  {
    version: 1,
    recordType: 'analysis',
    sourceTaskKey: 'a:1',
    projectKey: 'a',
    title: 'A 关注了 Project A',
    content: '你关注的12个用户也关注了ta',
    link: 'https://x.com/project_a',
    mainPushedAt: '2026-05-20T01:00:00.000Z',
    archivedAt: '2026-05-20T01:01:00.000Z',
    analysisCreatedAt: '2026-05-20T01:01:00.000Z',
    star: 3,
    count: 12,
    channelMessage: { chatId: -1001111111111, messageId: 10 },
    discussionAnalysisMessage: { chatId: '-1002222222222', messageId: 20 },
    analysisText: 'Project A 完整分析'
  },
  {
    version: 1,
    recordType: 'hit',
    sourceTaskKey: 'a:2',
    projectKey: 'a',
    title: 'A 再次命中 Project A',
    content: '你关注的20个用户也关注了ta',
    link: 'https://x.com/project_a',
    mainPushedAt: '2026-05-20T03:00:00.000Z',
    archivedAt: '2026-05-20T03:01:00.000Z',
    star: 5,
    count: 20,
    channelMessage: { chatId: -1001111111111, messageId: 11 },
    discussionAnalysisMessage: { chatId: '-1002222222222', messageId: 20 },
    reminderMessage: { chatId: -1002222222222, messageId: 21 }
  }
];

describe('parseShanghaiHourRange', () => {
  it('parses inclusive Shanghai hour range', () => {
    expect(parseShanghaiHourRange('2026-05-20T09', '2026-05-20T18')).toEqual({
      from: new Date('2026-05-20T01:00:00.000Z'),
      to: new Date('2026-05-20T10:59:59.999Z'),
      fromLabel: '2026-05-20 09:00',
      toLabel: '2026-05-20 18:59'
    });
  });
});

describe('isExportAuthorized', () => {
  it('allows matching chat id or username', () => {
    expect(isExportAuthorized({ chatId: '-1001', username: undefined }, [], ['-1001'])).toBe(true);
    expect(isExportAuthorized({ chatId: '-1002', username: '@Alice' }, ['alice'], [])).toBe(true);
    expect(isExportAuthorized({ chatId: '-1002', username: 'mallory' }, ['alice'], ['-1001'])).toBe(false);
  });
});

describe('buildAnalysisExport', () => {
  it('groups projects by highest star and keeps full analysis text', () => {
    const range = parseShanghaiHourRange('2026-05-20T09', '2026-05-20T12');
    const result = buildAnalysisExport(records, range, new Date('2026-05-20T05:40:00.000Z'));

    expect(result.projectCount).toBe(1);
    expect(result.markdown).toContain('## 5 星项目（1 个）');
    expect(result.markdown).toContain('### 1. Project A');
    expect(result.markdown).toContain('最高监控池关注数：20');
    expect(result.markdown).toContain('Project A 完整分析');
    expect(result.markdown).toContain('2026-05-20 11:00，5 星，监控池关注数 20');
  });
});
```

Run: `npm test -- tests/analysis-export.test.ts`

Expected: FAIL because `src/analysis-export.ts` does not exist.

- [ ] **Step 2: 实现导出函数**

Create `src/analysis-export.ts` with these public functions:

```ts
import type {
  AnalysisArchiveAnalysisRecord,
  AnalysisArchiveRecord
} from './analysis-archive-store.js';

export interface AnalysisExportRange {
  from: Date;
  to: Date;
  fromLabel: string;
  toLabel: string;
}

export function parseShanghaiHourRange(fromRaw: string, toRaw: string): AnalysisExportRange {
  const parse = (raw: string, endHour: boolean): Date => {
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/);
    if (!match) throw new Error('时间格式必须是 YYYY-MM-DDTHH');
    const [, year, month, day, hour] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, 0, 0, endHour ? 999 : 0));
    if (endHour) date.setUTCMinutes(59, 59, 999);
    return date;
  };
  const label = (raw: string, minute: string): string => raw.replace('T', ' ') + `:${minute}`;
  const from = parse(fromRaw, false);
  const to = parse(toRaw, true);
  if (from.getTime() > to.getTime()) throw new Error('开始时间不能晚于结束时间');
  return { from, to, fromLabel: label(fromRaw, '00'), toLabel: label(toRaw, '59') };
}

export function isExportAuthorized(
  update: { chatId: string; username?: string },
  adminUsernames: readonly string[],
  allowedChatIds: readonly string[]
): boolean {
  const normalizedUsername = update.username?.replace(/^@/, '').toLowerCase();
  const normalizedAdmins = new Set(adminUsernames.map((item) => item.replace(/^@/, '').toLowerCase()));
  return allowedChatIds.includes(update.chatId) || (!!normalizedUsername && normalizedAdmins.has(normalizedUsername));
}

function messageUrl(ref: { chatId: string | number; messageId: number }): string | null {
  const chatId = String(ref.chatId);
  if (!chatId.startsWith('-100')) return null;
  return `https://t.me/c/${chatId.slice(4)}/${ref.messageId}`;
}

function formatShanghaiMinute(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return formatter.format(date).replace(/\//g, '-');
}

export function buildAnalysisExport(
  records: readonly AnalysisArchiveRecord[],
  range: AnalysisExportRange,
  now = new Date()
): { projectCount: number; markdown: string } {
  const analysesByProject = new Map<string, AnalysisArchiveAnalysisRecord>();
  for (const record of records) {
    if (record.recordType !== 'analysis') continue;
    const existing = analysesByProject.get(record.projectKey);
    if (!existing || new Date(record.mainPushedAt).getTime() < new Date(existing.mainPushedAt).getTime()) {
      analysesByProject.set(record.projectKey, record);
    }
  }

  const inRange = records.filter((record) => {
    const time = new Date(record.mainPushedAt).getTime();
    return time >= range.from.getTime() && time <= range.to.getTime() && analysesByProject.has(record.projectKey);
  });

  const byProject = new Map<string, AnalysisArchiveRecord[]>();
  for (const record of inRange) {
    byProject.set(record.projectKey, [...(byProject.get(record.projectKey) ?? []), record]);
  }

  const projects = [...byProject.entries()].map(([projectKey, projectRecords]) => {
    const analysis = analysesByProject.get(projectKey)!;
    const highestStar = Math.max(...projectRecords.map((record) => record.star));
    const highestCount = Math.max(...projectRecords.map((record) => record.count));
    const firstPushedAt = projectRecords.map((record) => record.mainPushedAt).sort()[0];
    return { projectKey, analysis, records: projectRecords, highestStar, highestCount, firstPushedAt };
  });

  const lines = [
    '# Alpha 项目分析导出',
    '',
    `时间范围：${range.fromLabel} ~ ${range.toLabel}（Asia/Shanghai）`,
    `导出时间：${formatShanghaiMinute(now)}`,
    `项目数：${projects.length}`,
    ''
  ];

  const stars = [...new Set(projects.map((project) => project.highestStar))].sort((a, b) => b - a);
  for (const star of stars) {
    const group = projects
      .filter((project) => project.highestStar === star)
      .sort((a, b) => b.highestCount - a.highestCount || new Date(a.firstPushedAt).getTime() - new Date(b.firstPushedAt).getTime());
    lines.push(`## ${star} 星项目（${group.length} 个）`, '');
    group.forEach((project, index) => {
      const channelUrl = messageUrl(project.analysis.channelMessage);
      const discussionUrl = messageUrl(project.analysis.discussionAnalysisMessage);
      lines.push(`### ${index + 1}. ${project.analysis.title || project.projectKey}`);
      lines.push(`- 链接：${project.analysis.link}`);
      lines.push(`- 最高星级：${project.highestStar} 星`);
      lines.push(`- 最高监控池关注数：${project.highestCount}`);
      lines.push(`- 首次主推送时间：${formatShanghaiMinute(project.firstPushedAt)}`);
      if (channelUrl) lines.push(`- 主频道消息：${channelUrl}`);
      if (discussionUrl) lines.push(`- 讨论群分析消息：${discussionUrl}`);
      lines.push('', '#### Grok 分析全文', '', project.analysis.analysisText, '', '#### 时间段内命中记录', '');
      for (const record of project.records.sort((a, b) => new Date(a.mainPushedAt).getTime() - new Date(b.mainPushedAt).getTime())) {
        lines.push(`- ${formatShanghaiMinute(record.mainPushedAt)}，${record.star} 星，监控池关注数 ${record.count}`);
      }
      lines.push('');
    });
  }

  return { projectCount: projects.length, markdown: lines.join('\n').trimEnd() + '\n' };
}
```

- [ ] **Step 3: 运行导出测试并提交**

Run:

```bash
npm test -- tests/analysis-export.test.ts
npm run typecheck
```

Expected: both commands exit 0.

Commit:

```bash
git add src/analysis-export.ts tests/analysis-export.test.ts
git commit -m "feat: render analysis export markdown"
```

---

### Task 4: Telegram 中文命令解析

**Files:**
- Create: `src/telegram-command.ts`
- Create: `tests/telegram-command.test.ts`

- [ ] **Step 1: 写命令解析失败测试**

Create `tests/telegram-command.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractTelegramCommands } from '../src/telegram-command.js';

describe('extractTelegramCommands', () => {
  it('extracts Chinese export command from channel posts', () => {
    expect(
      extractTelegramCommands([
        {
          update_id: 1,
          channel_post: {
            message_id: 10,
            text: '导出分析 2026-05-20T09 2026-05-20T18',
            chat: { id: -1001, type: 'channel', title: 'Alpha' }
          }
        }
      ])
    ).toEqual([
      {
        type: 'export-analysis',
        chatId: '-1001',
        messageId: 10,
        username: undefined,
        from: '2026-05-20T09',
        to: '2026-05-20T18'
      }
    ]);
  });

  it('extracts chat id command and username from regular messages', () => {
    expect(
      extractTelegramCommands([
        {
          update_id: 2,
          message: {
            message_id: 20,
            text: '查看聊天ID',
            from: { username: 'Alice' },
            chat: { id: 123, type: 'private' }
          }
        }
      ])
    ).toEqual([
      {
        type: 'chat-id',
        chatId: '123',
        messageId: 20,
        username: 'Alice'
      }
    ]);
  });

  it('marks malformed export commands', () => {
    expect(
      extractTelegramCommands([
        {
          update_id: 3,
          message: {
            message_id: 30,
            text: '导出分析 2026-05-20',
            chat: { id: 123, type: 'private' }
          }
        }
      ])
    ).toEqual([
      {
        type: 'invalid-export-analysis',
        chatId: '123',
        messageId: 30,
        username: undefined
      }
    ]);
  });
});
```

Run: `npm test -- tests/telegram-command.test.ts`

Expected: FAIL because `src/telegram-command.ts` does not exist.

- [ ] **Step 2: 实现命令解析**

Create `src/telegram-command.ts`:

```ts
export type TelegramExportCommand =
  | { type: 'chat-id'; chatId: string; messageId: number; username?: string }
  | { type: 'export-analysis'; chatId: string; messageId: number; username?: string; from: string; to: string }
  | { type: 'invalid-export-analysis'; chatId: string; messageId: number; username?: string };

interface MessageLike {
  message_id?: number;
  text?: string;
  from?: { username?: string };
  chat?: { id?: number };
}

function commandFromMessage(message: MessageLike | undefined): TelegramExportCommand | null {
  if (!message || typeof message.message_id !== 'number' || typeof message.chat?.id !== 'number') return null;
  const text = message.text?.trim();
  if (!text) return null;
  const base = { chatId: String(message.chat.id), messageId: message.message_id, username: message.from?.username };
  if (text === '查看聊天ID' || text.startsWith('/chatid')) {
    return { type: 'chat-id', ...base };
  }
  const exportMatch = text.match(/^(?:导出分析|\/export_analysis(?:@\w+)?)\s+(\d{4}-\d{2}-\d{2}T\d{2})\s+(\d{4}-\d{2}-\d{2}T\d{2})$/);
  if (exportMatch) {
    return { type: 'export-analysis', ...base, from: exportMatch[1], to: exportMatch[2] };
  }
  if (text.startsWith('导出分析') || text.startsWith('/export_analysis')) {
    return { type: 'invalid-export-analysis', ...base };
  }
  return null;
}

export function extractTelegramCommands(updates: unknown[]): TelegramExportCommand[] {
  const commands: TelegramExportCommand[] = [];
  for (const update of updates) {
    if (!update || typeof update !== 'object') continue;
    const record = update as Record<string, unknown>;
    const command =
      commandFromMessage(record.message as MessageLike | undefined) ??
      commandFromMessage(record.channel_post as MessageLike | undefined);
    if (command) commands.push(command);
  }
  return commands;
}
```

- [ ] **Step 3: 运行命令解析测试并提交**

Run:

```bash
npm test -- tests/telegram-command.test.ts
npm run typecheck
```

Expected: both commands exit 0.

Commit:

```bash
git add src/telegram-command.ts tests/telegram-command.test.ts
git commit -m "feat: parse telegram export commands"
```

---

### Task 5: 分析任务主推送时间与结构化分析返回值

**Files:**
- Modify: `src/analysis-task-queue.ts`
- Modify: `tests/analysis-task-queue.test.ts`
- Modify: `src/analysis-service.ts`
- Modify: `tests/analysis-service.test.ts`

- [ ] **Step 1: 写分析任务 mainPushedAt 失败测试**

In `tests/analysis-task-queue.test.ts`, add `mainPushedAt` to the shared `task` fixture:

```ts
const task = {
  taskKey: '-1003903535780:88',
  projectKey: 'b',
  channelChatId: -1003903535780,
  channelMessageId: 88,
  title: 'A 关注了 B',
  content: '用户简介: builder',
  link: 'https://x.com/b',
  count: 12,
  star: 3,
  mainPushedAt: '2026-05-16T00:00:00.000Z'
};
```

Add assertion to `persists tasks and returns due items`:

```ts
await expect(queue.listDue(new Date('2026-05-16T00:00:01.000Z'))).resolves.toMatchObject([
  {
    taskKey: task.taskKey,
    retryCount: 0,
    projectKey: 'b',
    mainPushedAt: '2026-05-16T00:00:00.000Z'
  }
]);
```

Run: `npm test -- tests/analysis-task-queue.test.ts`

Expected: FAIL because `AnalysisTaskInput` and `AnalysisTaskRecord` lack `mainPushedAt`.

- [ ] **Step 2: 实现 mainPushedAt 持久化**

Modify `src/analysis-task-queue.ts`:

```ts
export interface AnalysisTaskRecord {
  version: 1;
  taskKey: string;
  projectKey: string;
  channelChatId: number;
  channelMessageId: number;
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
  mainPushedAt: string;
  retryCount: number;
  nextRetryAt: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface AnalysisTaskInput {
  taskKey: string;
  projectKey: string;
  channelChatId: number;
  channelMessageId: number;
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
  mainPushedAt: string;
  lastError?: string;
}
```

In `enqueue`, set:

```ts
mainPushedAt: input.mainPushedAt,
```

- [ ] **Step 3: 写结构化分析返回失败测试**

Modify the existing first-analysis test in `tests/analysis-service.test.ts` so the call result is assigned and asserted:

```ts
const result = await triggerAnalysisComment({
  xaiApiKey: 'key',
  xaiBaseUrl: 'https://example.com',
  xaiModel: 'grok-4.20-fast',
  discussionChatId: '-1003769834276',
  discussionStore,
  botToken: 'token',
  channelChatId: -1003903535780,
  channelMessageId: 88,
  projectKey: 'project-a',
  title: 'A 关注了 Project A',
  content: '你关注的12个用户也关注了ta',
  link: 'https://x.com/project_a',
  count: 12,
  star: 3,
  getRugHistory: async () => ({ username: 'project_a', items: [] }),
  analyze: async () => '1. 项目核心信息：Project A',
  loadSkill: async () => '# skill',
  reply
});

expect(result).toEqual({
  type: 'analysis',
  message: { chatId: -1003769834276, messageId: 99 },
  analysisText: expect.stringContaining('项目核心信息')
});
```

Modify the existing duplicate reminder test so the reply mock returns `{ chatId: -1003769834276, messageId: 100 }` and the assertion checks the structured reminder result:

```ts
await expect(
  triggerAnalysisComment({
    xaiApiKey: 'key',
    xaiBaseUrl: 'https://example.com',
    xaiModel: 'grok-4.20-fast',
    discussionChatId: '-1003769834276',
    discussionStore,
    botToken: 'token',
    channelChatId: -1003903535780,
    channelMessageId: 88,
    projectKey: 'project-a',
    existingAnalysis: { discussionChatId: '-1003769834276', analysisMessageId: 555 },
    title: 'A 关注了 Project A',
    content: '你关注的12个用户也关注了ta',
    link: 'https://x.com/project_a',
    count: 12,
    star: 3,
    reply
  })
).resolves.toEqual({
  type: 'reminder',
  message: { chatId: -1003769834276, messageId: 100 },
  existingAnalysis: { discussionChatId: '-1003769834276', analysisMessageId: 555 }
});
```

Run: `npm test -- tests/analysis-service.test.ts`

Expected: FAIL because `triggerAnalysisComment` still returns `TelegramSendResult | void`.

- [ ] **Step 4: 实现结构化返回值**

Modify `src/analysis-service.ts`:

```ts
export type TriggerAnalysisResult =
  | {
      type: 'analysis';
      message: TelegramSendResult;
      analysisText: string;
    }
  | {
      type: 'reminder';
      message: TelegramSendResult;
      existingAnalysis: StoredAnalysis;
    };

export async function triggerAnalysisComment(options: TriggerAnalysisOptions): Promise<TriggerAnalysisResult | void> {
  const info = options.info ?? console.info;
  const warn = options.warn ?? console.warn;
  const reply = options.reply ?? replyInTelegramThread;

  if (options.existingAnalysis) {
    const reminderResult = await reply({
      botToken: options.botToken,
      chatId: options.existingAnalysis.discussionChatId,
      replyToMessageId: options.existingAnalysis.analysisMessageId,
      text: `重复命中提醒\n\n${options.title}\n监控池关注数：${options.count}\n当前重要程度：${options.star} 星`,
      proxyUrl: options.proxyUrl,
      retryAttempts: options.telegramRetryAttempts,
      retryMinDelayMs: options.telegramRetryMinDelayMs,
      retryMaxDelayMs: options.telegramRetryMaxDelayMs,
      onRetry: (error, attempt, delayMs) => {
        warn(
          `Telegram 重复提醒回复失败，${delayMs}ms 后重试：attempt=${attempt} error=${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
    info(`已回复既有分析评论：${options.projectKey}`);
    return {
      type: 'reminder',
      message: reminderResult,
      existingAnalysis: options.existingAnalysis
    };
  }

  info(`已写入讨论群评论：${mapping.discussionChatId}/${mapping.discussionMessageId}`);
  return {
    type: 'analysis',
    message: replyResult,
    analysisText: cleanedAnalysis
  };
}
```

- [ ] **Step 5: 运行本任务测试并提交**

Run:

```bash
npm test -- tests/analysis-task-queue.test.ts tests/analysis-service.test.ts
npm run typecheck
```

Expected: both commands exit 0.

Commit:

```bash
git add src/analysis-task-queue.ts src/analysis-service.ts tests/analysis-task-queue.test.ts tests/analysis-service.test.ts
git commit -m "feat: return structured analysis results"
```

---

### Task 6: 单一 Telegram updates poller 中处理命令

**Files:**
- Modify: `src/discussion-poller.ts`
- Modify: `tests/discussion-poller.test.ts`

- [ ] **Step 1: 写 onUpdates 失败测试**

Add to `tests/discussion-poller.test.ts`:

```ts
it('passes updates to a command handler before scheduling the next poll', async () => {
  vi.useFakeTimers();
  const store = await createStore();
  const onUpdates = vi.fn().mockResolvedValue(undefined);
  const updates = [
    {
      update_id: 7,
      channel_post: {
        message_id: 10,
        text: '查看聊天ID',
        chat: { id: -1001, type: 'channel' }
      }
    }
  ];
  const fetchUpdates = vi.fn().mockResolvedValueOnce(updates).mockResolvedValueOnce([]);

  const stop = startDiscussionPoller({
    botToken: 'token',
    store,
    intervalMs: 1,
    info: vi.fn(),
    warn: vi.fn(),
    fetchUpdates,
    onUpdates
  });

  await vi.runOnlyPendingTimersAsync();
  await vi.runOnlyPendingTimersAsync();
  stop();

  expect(onUpdates).toHaveBeenCalledWith(updates);
  expect(fetchUpdates).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 8 }));
});
```

Run: `npm test -- tests/discussion-poller.test.ts`

Expected: FAIL because `StartDiscussionPollerOptions` lacks `onUpdates`.

- [ ] **Step 2: 实现 onUpdates**

Modify `src/discussion-poller.ts` by adding this field to `StartDiscussionPollerOptions`:

```ts
onUpdates?: (updates: unknown[]) => Promise<void>;
```

Inside `poll`, after discussion mappings and pinned fallback work succeed, call:

```ts
if (options.onUpdates) {
  await options.onUpdates(updates);
}
```

Keep the offset advancement after command handling:

```ts
const maxUpdateId = updates.reduce<number | undefined>((max, update) => {
  if (!update || typeof update !== 'object') return max;
  const current = (update as Record<string, unknown>).update_id;
  if (typeof current !== 'number') return max;
  return typeof max === 'number' ? Math.max(max, current) : current;
}, offset);

// Run mapping extraction, pinned fallback, and onUpdates before assigning offset.

if (typeof maxUpdateId === 'number') {
  offset = maxUpdateId + 1;
}
```

This ordering prevents a command-processing exception from silently advancing the offset.

- [ ] **Step 3: 运行 poller 测试并提交**

Run:

```bash
npm test -- tests/discussion-poller.test.ts
npm run typecheck
```

Expected: both commands exit 0.

Commit:

```bash
git add src/discussion-poller.ts tests/discussion-poller.test.ts
git commit -m "feat: route telegram updates to command handler"
```

---

### Task 7: 服务层归档与导出命令集成

**Files:**
- Modify: `src/service.ts`
- Modify: `tests/service.test.ts`

- [ ] **Step 1: 写 processAlphaMessage mainPushedAt 失败测试**

Add to `tests/service.test.ts`:

```ts
it('passes main push success time to afterSend', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-20T02:03:04.000Z'));
  const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
  const afterSend = vi.fn().mockResolvedValue(undefined);

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
    send,
    afterSend
  });

  expect(afterSend.mock.calls[0][4]).toEqual(new Date('2026-05-20T02:03:04.000Z'));
  vi.useRealTimers();
});
```

Run: `npm test -- tests/service.test.ts`

Expected: FAIL because `afterSend` receives only four arguments.

- [ ] **Step 2: Thread mainPushedAt through service callbacks**

Modify `src/service.ts` interfaces:

```ts
afterSend?: (
  message: Record<string, unknown>,
  count: number,
  star: number,
  sendResult: TelegramSendResult,
  mainPushedAt: Date
) => Promise<void>;
```

After `sendResult = await options.send(text);`, set:

```ts
const mainPushedAt = new Date();
```

Call:

```ts
await options.afterSend(message, count, decision.star, sendResult, mainPushedAt);
```

Update `handleAfterMainSend` to accept `mainPushedAt: Date` and enqueue:

```ts
mainPushedAt: mainPushedAt.toISOString()
```

Update failed-message retry `afterDelivered` to accept or create a replay success time:

```ts
const mainPushedAt = new Date();
await handleAfterMainSend(message, count, star, sendResult, mainPushedAt);
```

- [ ] **Step 3: Integrate archive store and analysis results**

Modify `src/service.ts` imports:

```ts
import { AnalysisArchiveStore } from './analysis-archive-store.js';
import { buildAnalysisExport, isExportAuthorized, parseShanghaiHourRange } from './analysis-export.js';
import { extractTelegramCommands } from './telegram-command.js';
import { sendTelegramDocument, sendTelegramMessage, type TelegramSendResult } from './telegram.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
```

Create archive store after `analysisTracker`:

```ts
const analysisArchive = new AnalysisArchiveStore({
  filePath: options.config.analysisArchivePath,
  warn
});
for (const [projectKey, storedAnalysis] of await analysisArchive.listAnalysisTrackerEntries()) {
  analysisTracker.set(projectKey, storedAnalysis);
}
```

In `processAnalysisTask`, after `triggerAnalysisComment`:

```ts
if (result?.type === 'analysis') {
  await analysisArchive.upsert({
    version: 1,
    recordType: 'analysis',
    sourceTaskKey: task.taskKey,
    projectKey: task.projectKey,
    title: task.title,
    content: task.content,
    link: task.link,
    mainPushedAt: task.mainPushedAt,
    archivedAt: new Date().toISOString(),
    analysisCreatedAt: new Date().toISOString(),
    star: task.star,
    count: task.count,
    channelMessage: { chatId: task.channelChatId, messageId: task.channelMessageId },
    discussionAnalysisMessage: { chatId: options.config.discussionChatId!, messageId: result.message.messageId },
    analysisText: result.analysisText
  });
  analysisTracker.set(task.projectKey, {
    discussionChatId: options.config.discussionChatId!,
    analysisMessageId: result.message.messageId
  });
  return { status: 'done' };
}

if (result?.type === 'reminder') {
  const firstAnalysis = await analysisArchive.getFirstAnalysis(task.projectKey);
  if (firstAnalysis) {
    await analysisArchive.upsert({
      version: 1,
      recordType: 'hit',
      sourceTaskKey: task.taskKey,
      projectKey: task.projectKey,
      title: task.title,
      content: task.content,
      link: task.link,
      mainPushedAt: task.mainPushedAt,
      archivedAt: new Date().toISOString(),
      star: task.star,
      count: task.count,
      channelMessage: { chatId: task.channelChatId, messageId: task.channelMessageId },
      discussionAnalysisMessage: firstAnalysis.discussionAnalysisMessage,
      reminderMessage: result.message
    });
  }
  return { status: 'done' };
}
```

Remove the older `typeof result.messageId === 'number'` branch because `triggerAnalysisComment` now returns a union.

- [ ] **Step 4: Implement Telegram export command handler in service**

Add helper inside `startAlphaService`:

```ts
const replyToCommand = (chatId: string, text: string): Promise<TelegramSendResult> =>
  sendTelegramMessage({
    botToken: options.config.telegramBotToken,
    chatId,
    text,
    proxyUrl: options.config.proxyUrl,
    retryAttempts: options.config.telegramRetryAttempts,
    retryMinDelayMs: options.config.telegramRetryMinDelayMs,
    retryMaxDelayMs: options.config.telegramRetryMaxDelayMs
  });

const handleTelegramUpdates = async (updates: unknown[]): Promise<void> => {
  for (const command of extractTelegramCommands(updates)) {
    if (command.type === 'chat-id') {
      await replyToCommand(command.chatId, `chat_id: ${command.chatId}`);
      continue;
    }
    if (command.type === 'invalid-export-analysis') {
      await replyToCommand(command.chatId, '用法：导出分析 2026-05-01T09 2026-05-20T18');
      continue;
    }
    if (!isExportAuthorized(command, options.config.exportAdminUsernames, options.config.exportAllowedChatIds)) {
      await replyToCommand(command.chatId, '无权限执行分析导出');
      continue;
    }

    try {
      const range = parseShanghaiHourRange(command.from, command.to);
      const exportResult = buildAnalysisExport(await analysisArchive.listAll(), range);
      if (exportResult.projectCount === 0) {
        await replyToCommand(command.chatId, '该时间段没有已完成 Grok 分析的项目');
        continue;
      }
      const exportDir = 'data/exports';
      await mkdir(exportDir, { recursive: true });
      const filename = `alpha-analysis-${command.from}-${command.to}.md`;
      const filePath = join(exportDir, filename);
      await writeFile(filePath, exportResult.markdown, 'utf8');
      await sendTelegramDocument({
        botToken: options.config.telegramBotToken,
        chatId: command.chatId,
        filePath,
        filename,
        caption: `分析导出：${command.from} ~ ${command.to}`,
        proxyUrl: options.config.proxyUrl,
        retryAttempts: options.config.telegramRetryAttempts,
        retryMinDelayMs: options.config.telegramRetryMinDelayMs,
        retryMaxDelayMs: options.config.telegramRetryMaxDelayMs
      });
    } catch (error) {
      warn(`处理分析导出命令失败：${error instanceof Error ? error.message : String(error)}`);
      await replyToCommand(command.chatId, '分析导出失败，请检查时间格式或稍后重试');
    }
  }
};
```

Pass it into `startDiscussionPoller`:

```ts
const stopDiscussionPoller = startDiscussionPoller({
  botToken: options.config.telegramBotToken,
  discussionChatId: options.config.discussionChatId,
  proxyUrl: options.config.proxyUrl,
  store: discussionStore,
  retryAttempts: options.config.telegramRetryAttempts,
  retryMinDelayMs: options.config.telegramRetryMinDelayMs,
  retryMaxDelayMs: options.config.telegramRetryMaxDelayMs,
  info,
  warn,
  onUpdates: handleTelegramUpdates
});
```

- [ ] **Step 5: 运行服务相关测试并提交**

Run:

```bash
npm test -- tests/service.test.ts
npm run typecheck
```

Expected: both commands exit 0.

Commit:

```bash
git add src/service.ts tests/service.test.ts
git commit -m "feat: archive completed analysis tasks"
```

---

### Task 8: README 命令说明与全量验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 添加使用说明**

Add to README near the Grok analysis section:

```markdown
### 分析归档导出

功能上线后，服务会把成功写入讨论群的 Grok 分析归档到 `ANALYSIS_ARCHIVE_PATH`。

在授权频道、群或私聊中发送：

```text
查看聊天ID
```

机器人会回复当前 `chat_id`，可用于配置 `EXPORT_ALLOWED_CHAT_IDS`。

导出指定小时范围内的 Markdown 文档：

```text
导出分析 2026-05-01T09 2026-05-20T18
```

时间按 `Asia/Shanghai` 解释，结束小时包含完整一小时。导出只包含已经完成 Grok 分析的项目；没有分析正文的推送不会出现在文档里。
```

- [ ] **Step 2: 运行全量验证**

Run:

```bash
npm test
npm run typecheck
```

Expected:

- `npm test`: all Vitest files pass.
- `npm run typecheck`: exits 0.

- [ ] **Step 3: 提交文档和最终集成**

Check status:

```bash
git status --short
```

Expected: only intended files modified.

Commit remaining changes:

```bash
git add README.md
git commit -m "docs: document analysis export commands"
```

If Task 7 left uncommitted files because additional type fixes were required, include only files directly related to this feature in the final commit.
