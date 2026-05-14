# 6551 Rug 历史分析实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在首次 Grok 分析里接入 6551 数据源，补充目标账号的删帖记录、近期推文和负面评论/提及，并输出“Rug 历史/风险”判断。

**Architecture:** 新增 `twitter-6551-client.ts` 负责调用 6551 Open API，新增 `rug-history-provider.ts` 负责把 6551 返回归一化为 Rug 风险证据。`analysis-service.ts` 只在首次分析时调用 Rug provider，重复项目不重复查询；`grok.ts` 扩展 prompt，把 Rug 证据作为结构化输入。

**Tech Stack:** TypeScript, Vitest, Node.js fetch, 6551 Open API, Grok OpenAI-compatible `/v1/chat/completions`。

---

## 文件结构

- Create `src/twitter-6551-client.ts`：6551 HTTP client，统一处理 Bearer token、base URL、POST 请求、JSON 解析和错误。
- Create `src/rug-history-provider.ts`：提取 X username，调用 6551 多个接口，归一化 Rug 风险证据。
- Create `tests/twitter-6551-client.test.ts`：6551 client 请求和错误处理测试。
- Create `tests/rug-history-provider.test.ts`：无 token、删帖样本、负面搜索、部分失败保留证据测试。
- Modify `src/config.ts`：新增 `twitterToken`、`twitterApiBaseUrl`。
- Modify `tests/config.test.ts`：覆盖 6551 配置解析。
- Modify `.env.example`：新增 `TWITTER_TOKEN`、`TWITTER_API_BASE_URL`。
- Modify `src/grok.ts`：`GrokAnalysisInput` 支持 Rug 证据，prompt 增加 `Rug 历史/风险` 行。
- Modify `tests/grok.test.ts`：覆盖 prompt 包含 Rug 证据和新增分析行。
- Modify `src/analysis-service.ts`：首次分析前查询 Rug 证据，重复项目不查询。
- Modify `tests/analysis-service.test.ts`：覆盖首次分析调用 Rug provider、重复项目不调用。
- Modify `src/service.ts`：从配置传入 `twitterToken` 和 `twitterApiBaseUrl`。
- Modify `README.md`：中文说明 6551 配置和失败兜底。

---

### Task 1: 配置 6551 环境变量

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.ts` 的第一个测试里增加 6551 配置断言：

```ts
expect(
  parseServiceConfig({
    ALPHA_WALLET_PRIVATE_KEY: '0xabc',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: '-100123',
    COMMON_FOLLOW_STAR_LEVELS: '5,8,12,15,20',
    TWITTER_TOKEN: 'twitter-token',
    TWITTER_API_BASE_URL: 'https://example.6551'
  })
).toMatchObject({
  alphaWalletPrivateKey: '0xabc',
  telegramBotToken: 'bot-token',
  telegramChatId: '-100123',
  commonFollowStarLevels: [5, 8, 12, 15, 20],
  twitterToken: 'twitter-token',
  twitterApiBaseUrl: 'https://example.6551'
});
```

新增默认值测试：

```ts
it('defaults twitter api base url for 6551', () => {
  expect(
    parseServiceConfig({
      ALPHA_WALLET_PRIVATE_KEY: '0xabc',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '-100123'
    })
  ).toMatchObject({
    twitterToken: undefined,
    twitterApiBaseUrl: 'https://ai.6551.io'
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/config.test.ts`

Expected: FAIL，因为 `ServiceConfig` 还没有 `twitterToken` 和 `twitterApiBaseUrl`。

- [ ] **Step 3: 实现配置**

在 `src/config.ts` 的 `ServiceConfig` 增加：

```ts
twitterToken?: string;
twitterApiBaseUrl: string;
```

在 `parseServiceConfig()` 返回值里增加：

```ts
twitterToken: env.TWITTER_TOKEN?.trim() || undefined,
twitterApiBaseUrl: env.TWITTER_API_BASE_URL?.trim() || 'https://ai.6551.io',
```

在 `.env.example` 增加：

```env
TWITTER_TOKEN=
TWITTER_API_BASE_URL=https://ai.6551.io
```

- [ ] **Step 4: 验证配置测试通过**

Run: `npm test -- tests/config.test.ts`

Expected: PASS。

---

### Task 2: 6551 HTTP Client

**Files:**
- Create: `src/twitter-6551-client.ts`
- Create: `tests/twitter-6551-client.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/twitter-6551-client.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/twitter-6551-client.test.ts`

Expected: FAIL，因为 client 文件还不存在。

- [ ] **Step 3: 实现 client**

创建 `src/twitter-6551-client.ts`：

```ts
import { ProxyAgent } from 'undici';

type FetchWithDispatcher = (
  input: string,
  init?: RequestInit & { dispatcher?: ProxyAgent }
) => Promise<Response>;

export interface Twitter6551ClientOptions {
  token: string;
  baseUrl?: string;
  proxyUrl?: string;
  fetch?: typeof fetch;
}

export interface Twitter6551Client {
  postOpen(endpoint: string, body: Record<string, unknown>): Promise<unknown>;
}

export function createTwitter6551Client(options: Twitter6551ClientOptions): Twitter6551Client {
  const fetchImpl = (options.fetch ?? fetch) as FetchWithDispatcher;
  const baseUrl = (options.baseUrl ?? 'https://ai.6551.io').replace(/\/+$/, '');
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;

  return {
    async postOpen(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
      const response = await fetchImpl(`${baseUrl}/open/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json'
        },
        dispatcher,
        body: JSON.stringify(body)
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`6551 request failed: ${response.status} ${text}`);
      }
      try {
        return text.length > 0 ? JSON.parse(text) : {};
      } catch (error) {
        throw new Error(`6551 response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
```

- [ ] **Step 4: 验证 client 测试通过**

Run: `npm test -- tests/twitter-6551-client.test.ts`

Expected: PASS。

---

### Task 3: Rug History Provider

**Files:**
- Create: `src/rug-history-provider.ts`
- Create: `tests/rug-history-provider.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/rug-history-provider.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { collectRugHistoryEvidence, extractUsernameFromXLink } from '../src/rug-history-provider.js';

describe('rug history provider', () => {
  it('extracts username from X links', () => {
    expect(extractUsernameFromXLink('https://x.com/project_b')).toBe('project_b');
    expect(extractUsernameFromXLink('https://twitter.com/project_b/status/1')).toBe('project_b');
    expect(extractUsernameFromXLink('')).toBeNull();
  });

  it('returns warning evidence when token is missing', async () => {
    await expect(
      collectRugHistoryEvidence({
        link: 'https://x.com/project_b',
        twitterToken: undefined,
        twitterApiBaseUrl: 'https://ai.6551.io'
      })
    ).resolves.toMatchObject({
      source: '6551',
      available: false,
      deletedTweetCount: null,
      negativeMentionCount: null,
      warnings: ['未配置 TWITTER_TOKEN，跳过 6551 Rug 历史查询']
    });
  });

  it('collects deleted tweets and negative mentions', async () => {
    const postOpen = vi.fn(async (endpoint: string) => {
      if (endpoint === 'twitter_deleted_tweets') {
        return { data: [{ text: 'old mint failed' }, { fullText: 'refund delayed' }] };
      }
      if (endpoint === 'twitter_user_tweets') {
        return { data: [{ text: 'building now' }] };
      }
      if (endpoint === 'twitter_search') {
        return { data: [{ text: '@project_b rug?' }, { text: '@project_b scam warning' }] };
      }
      return { data: { username: 'project_b' } };
    });

    const evidence = await collectRugHistoryEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.available).toBe(true);
    expect(evidence.deletedTweetCount).toBe(2);
    expect(evidence.negativeMentionCount).toBe(4);
    expect(evidence.deletedTweetSamples).toEqual(['old mint failed', 'refund delayed']);
    expect(evidence.negativeMentionSamples).toContain('@project_b rug?');
  });

  it('keeps partial evidence when one 6551 endpoint fails', async () => {
    const postOpen = vi.fn(async (endpoint: string) => {
      if (endpoint === 'twitter_deleted_tweets') throw new Error('deleted endpoint failed');
      if (endpoint === 'twitter_search') return { data: [{ text: '@project_b hacked?' }] };
      return { data: [] };
    });

    const evidence = await collectRugHistoryEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.available).toBe(true);
    expect(evidence.deletedTweetCount).toBeNull();
    expect(evidence.negativeMentionCount).toBe(2);
    expect(evidence.warnings.some((warning) => warning.includes('twitter_deleted_tweets'))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/rug-history-provider.test.ts`

Expected: FAIL，因为 provider 文件还不存在。

- [ ] **Step 3: 实现 provider**

创建 `src/rug-history-provider.ts`，包含以下公开接口：

```ts
import { createTwitter6551Client, type Twitter6551Client } from './twitter-6551-client.js';

export interface RugHistoryEvidence {
  source: '6551';
  available: boolean;
  deletedTweetCount: number | null;
  negativeMentionCount: number | null;
  recentTweetCount: number | null;
  deletedTweetSamples: string[];
  negativeMentionSamples: string[];
  recentRiskSignals: string[];
  warnings: string[];
}

export interface CollectRugHistoryEvidenceOptions {
  link: string;
  twitterToken?: string;
  twitterApiBaseUrl: string;
  proxyUrl?: string;
  client?: Twitter6551Client;
}

export function extractUsernameFromXLink(link: string): string | null {
  const matched = link.match(/^https?:\/\/(?:x|twitter)\.com\/([^/?#]+)/i);
  return matched?.[1] ?? null;
}
```

实现要点：

- `TWITTER_TOKEN` 缺失时直接返回 warning evidence。
- `link` 无法提取 username 时直接返回 warning evidence。
- 成功路径调用：
  - `twitter_user_info`
  - `twitter_deleted_tweets`
  - `twitter_user_tweets`
  - `twitter_search` 三次，分别查英文负面关键词、中文负面关键词、mention。
- 每个接口用 `try/catch` 包裹，单个失败只写入 `warnings`。
- 从未知响应中提取数组时兼容 `data`、`result`、`tweets` 三类字段。
- 样本最多取 3 条，文本字段兼容 `text`、`fullText`、`content`。
- `available` 在 token 和 username 有效时为 `true`，即使部分接口失败。

- [ ] **Step 4: 验证 provider 测试通过**

Run: `npm test -- tests/rug-history-provider.test.ts`

Expected: PASS。

---

### Task 4: Grok Prompt 增加 Rug 风险视角

**Files:**
- Modify: `src/grok.ts`
- Modify: `tests/grok.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/grok.test.ts` 的 `buildGrokPrompt` 测试里新增：

```ts
it('includes rug history evidence when provided', () => {
  const prompt = buildGrokPrompt({
    title: 'A 关注了 B',
    content: '用户简介: builder',
    link: 'https://x.com/b',
    count: 12,
    star: 3,
    rugHistory: {
      source: '6551',
      available: true,
      deletedTweetCount: 2,
      negativeMentionCount: 3,
      recentTweetCount: 10,
      deletedTweetSamples: ['old mint failed'],
      negativeMentionSamples: ['@b rug?'],
      recentRiskSignals: ['近期多次提到 mint'],
      warnings: []
    }
  });

  expect(prompt).toContain('Rug 历史/风险');
  expect(prompt).toContain('删帖数量：2');
  expect(prompt).toContain('@b rug?');
  expect(prompt).toContain('近期多次提到 mint');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/grok.test.ts`

Expected: FAIL，因为 prompt 还不支持 `rugHistory`。

- [ ] **Step 3: 扩展 prompt**

在 `src/grok.ts` 引入类型：

```ts
import type { RugHistoryEvidence } from './rug-history-provider.js';
```

扩展接口：

```ts
rugHistory?: RugHistoryEvidence;
```

新增 helper：

```ts
function formatList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `  - ${item}`).join('\n') : '  - 暂无';
}

function formatRugHistory(evidence: RugHistoryEvidence | undefined): string[] {
  if (!evidence) return ['Rug 历史数据源：未查询'];
  return [
    `Rug 历史数据源：${evidence.source}`,
    `Rug 数据可用：${evidence.available ? '是' : '否'}`,
    `删帖数量：${evidence.deletedTweetCount ?? '未知'}`,
    `负面提及数量：${evidence.negativeMentionCount ?? '未知'}`,
    `近期推文数量：${evidence.recentTweetCount ?? '未知'}`,
    '删帖样本：',
    formatList(evidence.deletedTweetSamples),
    '负面评论样本：',
    formatList(evidence.negativeMentionSamples),
    '近期风险信号：',
    formatList(evidence.recentRiskSignals),
    '数据警告：',
    formatList(evidence.warnings)
  ];
}
```

在 prompt 的已知信息后加入 `...formatRugHistory(input.rugHistory)`，并把输出要求从 6 行改为 7 行：

```text
7. Rug 历史/风险：基于删帖记录和社区评论判断是否存在跑路、骗局、严重负面历史；没有证据时明确写“暂无直接证据”。
```

- [ ] **Step 4: 验证 Grok 测试通过**

Run: `npm test -- tests/grok.test.ts`

Expected: PASS。

---

### Task 5: Analysis Service 接入 Rug Provider

**Files:**
- Modify: `src/analysis-service.ts`
- Modify: `tests/analysis-service.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/analysis-service.test.ts` 的首次分析测试中新增 `getRugHistory` mock：

```ts
const getRugHistory = vi.fn().mockResolvedValue({
  source: '6551',
  available: true,
  deletedTweetCount: 1,
  negativeMentionCount: 2,
  recentTweetCount: 3,
  deletedTweetSamples: ['deleted mint'],
  negativeMentionSamples: ['rug?'],
  recentRiskSignals: ['recent mint'],
  warnings: []
});
```

调用 `triggerAnalysisComment()` 时传入：

```ts
twitterToken: 'twitter-token',
twitterApiBaseUrl: 'https://ai.6551.io',
getRugHistory,
```

断言：

```ts
expect(getRugHistory).toHaveBeenCalledWith({
  link: 'https://x.com/b',
  twitterToken: 'twitter-token',
  twitterApiBaseUrl: 'https://ai.6551.io',
  proxyUrl: 'http://127.0.0.1:7890'
});
expect(analyze.mock.calls[0][0]).toContain('Rug 历史/风险');
expect(analyze.mock.calls[0][0]).toContain('deleted mint');
```

在重复项目测试中传入 `getRugHistory = vi.fn()` 并断言：

```ts
expect(getRugHistory).not.toHaveBeenCalled();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/analysis-service.test.ts`

Expected: FAIL，因为 `TriggerAnalysisOptions` 还没有 Rug 参数。

- [ ] **Step 3: 修改 analysis service**

在 `src/analysis-service.ts` 引入：

```ts
import { collectRugHistoryEvidence, type RugHistoryEvidence } from './rug-history-provider.js';
```

扩展 `TriggerAnalysisOptions`：

```ts
twitterToken?: string;
twitterApiBaseUrl?: string;
getRugHistory?: (options: {
  link: string;
  twitterToken?: string;
  twitterApiBaseUrl: string;
  proxyUrl?: string;
}) => Promise<RugHistoryEvidence>;
```

在首次分析路径、`buildGrokPrompt()` 前增加：

```ts
const rugHistory = await (options.getRugHistory ?? collectRugHistoryEvidence)({
  link: options.link,
  twitterToken: options.twitterToken,
  twitterApiBaseUrl: options.twitterApiBaseUrl ?? 'https://ai.6551.io',
  proxyUrl: options.proxyUrl
});
```

传入 prompt：

```ts
const prompt = buildGrokPrompt({
  title: options.title,
  content: options.content,
  link: options.link,
  count: options.count,
  star: options.star,
  rugHistory
});
```

保持重复项目分支在 Rug 查询之前返回。

- [ ] **Step 4: 验证 analysis service 测试通过**

Run: `npm test -- tests/analysis-service.test.ts`

Expected: PASS。

---

### Task 6: Service Runtime 传入 6551 配置

**Files:**
- Modify: `src/service.ts`
- Modify: `tests/service.test.ts` if TypeScript requires interface changes

- [ ] **Step 1: 修改 runtime 参数**

在 `src/service.ts` 调用 `triggerAnalysisComment()` 时增加：

```ts
twitterToken: options.config.twitterToken,
twitterApiBaseUrl: options.config.twitterApiBaseUrl,
```

- [ ] **Step 2: 运行服务相关测试**

Run:

```bash
npm test -- tests/service.test.ts tests/analysis-service.test.ts
npm run typecheck
```

Expected: PASS。

---

### Task 7: README 和最终验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新中文 README**

在配置示例里加入：

```env
TWITTER_TOKEN=
TWITTER_API_BASE_URL=https://ai.6551.io
```

新增说明：

```md
## Rug 历史分析

首次项目分析会使用 6551 查询目标账号的删帖记录、近期推文和负面评论/提及，并把证据加入 Grok 分析里的“Rug 历史/风险”行。

如果没有配置 `TWITTER_TOKEN`，或者 6551 查询失败，服务仍会正常推送和分析；Rug 历史会显示为数据源不可用或暂无直接证据。
```

- [ ] **Step 2: 全量验证**

Run:

```bash
npm test
npm run typecheck
git status --short
```

Expected:

- `npm test` 通过。
- `npm run typecheck` 通过。
- 变更文件只包含本计划列出的源码、测试、README、`.env.example` 和计划文档。

- [ ] **Step 3: 中文提交**

Run:

```bash
git add src/twitter-6551-client.ts src/rug-history-provider.ts src/config.ts src/grok.ts src/analysis-service.ts src/service.ts tests/twitter-6551-client.test.ts tests/rug-history-provider.test.ts tests/config.test.ts tests/grok.test.ts tests/analysis-service.test.ts README.md .env.example docs/superpowers/plans/2026-05-14-rug-history-analysis.md
git commit -m "新增 6551 Rug 历史分析"
```

Expected: commit succeeds。

---

## 自审

- Spec coverage: 覆盖 6551 数据源、删帖、近期推文、负面评论/提及、失败不阻塞、重复项目不重复查询、Grok 新增 Rug 风险输出。
- 空白项扫描：没有遗留空白内容或缺失任务。
- Type consistency: `RugHistoryEvidence`、`collectRugHistoryEvidence`、`createTwitter6551Client`、`twitterToken`、`twitterApiBaseUrl` 在各任务中命名一致。
