# Account Classification Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 1 星开始对 alpha 关注事件进行 Grok 账号分类，拦截 KOL/个人账号，只让项目/Alpha 账号进入频道并写分析评论。

**Architecture:** 新增独立的 `account-classifier.ts` 模块负责分类提示词、JSON 解析和推送判定。`service.ts` 在发送 Telegram 主消息前调用分类；分类允许或失败才发送主消息，并对所有允许推送的星级触发分析评论。

**Tech Stack:** TypeScript, Vitest, Node.js, OpenAI-compatible `/v1/chat/completions`, Telegram Bot API.

---

## File Structure

- Create `src/account-classifier.ts`: 分类输入类型、提示词构造、JSON 解析、分类允许/拦截判断、Grok 调用封装。
- Create `tests/account-classifier.test.ts`: 分类解析、推送判定、Grok 调用成功/失败行为测试。
- Modify `src/service.ts`: 在 `processAlphaMessage()` 里加入发送前分类回调，把 `analyze` 改为发送后回调，并让所有星级都分析。
- Modify `tests/service.test.ts`: 覆盖 1 星项目推送并分析、1 星 KOL 拦截、分类失败保守推送、重复事件去重。
- Modify `README.md`: 中文说明新增从 1 星开始分类过滤、KOL/个人拦截、失败保守推送。

---

### Task 1: Account Classifier Module

**Files:**
- Create: `src/account-classifier.ts`
- Test: `tests/account-classifier.test.ts`

- [ ] **Step 1: Write failing classifier tests**

Add `tests/account-classifier.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  buildAccountClassificationPrompt,
  classifyAccount,
  parseAccountClassificationResponse,
  shouldAllowClassifiedAccount
} from '../src/account-classifier.js';

describe('account classifier', () => {
  const input = {
    title: '[重点] A 关注了 B',
    content: '用户简介: DeFi protocol for onchain liquidity',
    link: 'https://x.com/project_b',
    count: 8,
    star: 2
  };

  it('builds a prompt that asks for strict JSON classification', () => {
    const prompt = buildAccountClassificationPrompt(input);

    expect(prompt).toContain('只返回 JSON');
    expect(prompt).toContain('PROJECT');
    expect(prompt).toContain('KOL');
    expect(prompt).toContain('https://x.com/project_b');
  });

  it('parses direct JSON classification responses', () => {
    const result = parseAccountClassificationResponse(
      '{"type":"PROJECT","confidence":0.82,"reason":"官方项目账号"}'
    );

    expect(result).toEqual({
      type: 'PROJECT',
      confidence: 0.82,
      reason: '官方项目账号'
    });
  });

  it('parses JSON wrapped in a markdown code block', () => {
    const result = parseAccountClassificationResponse(
      '```json\n{"type":"KOL","confidence":0.91,"reason":"个人观点账号"}\n```'
    );

    expect(result.type).toBe('KOL');
    expect(result.confidence).toBe(0.91);
  });

  it('rejects invalid classification responses', () => {
    expect(() => parseAccountClassificationResponse('not json')).toThrow(/无法解析账号分类/);
    expect(() =>
      parseAccountClassificationResponse('{"type":"BOT","confidence":1,"reason":"x"}')
    ).toThrow(/未知账号分类/);
  });

  it('allows project, alpha, and unknown classifications', () => {
    expect(shouldAllowClassifiedAccount({ type: 'PROJECT', confidence: 0.8, reason: 'x' })).toBe(true);
    expect(shouldAllowClassifiedAccount({ type: 'ALPHA', confidence: 0.8, reason: 'x' })).toBe(true);
    expect(shouldAllowClassifiedAccount({ type: 'UNKNOWN', confidence: 0.2, reason: 'x' })).toBe(true);
  });

  it('blocks KOL and personal classifications', () => {
    expect(shouldAllowClassifiedAccount({ type: 'KOL', confidence: 0.9, reason: 'x' })).toBe(false);
    expect(shouldAllowClassifiedAccount({ type: 'PERSONAL', confidence: 0.9, reason: 'x' })).toBe(false);
  });

  it('classifies an account by calling the injected analyzer', async () => {
    const analyze = vi.fn().mockResolvedValue('{"type":"ALPHA","confidence":0.73,"reason":"早期项目线索"}');

    await expect(classifyAccount({ ...input, analyze })).resolves.toEqual({
      type: 'ALPHA',
      confidence: 0.73,
      reason: '早期项目线索'
    });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0]).toContain('只返回 JSON');
  });
});
```

- [ ] **Step 2: Run classifier tests and verify failure**

Run: `npm test -- tests/account-classifier.test.ts`

Expected: FAIL because `src/account-classifier.ts` does not exist.

- [ ] **Step 3: Implement classifier module**

Create `src/account-classifier.ts`:

```ts
import { requestGrokAnalysis } from './xai-client.js';

export type AccountClassificationType = 'PROJECT' | 'ALPHA' | 'KOL' | 'PERSONAL' | 'UNKNOWN';

export interface AccountClassificationInput {
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
}

export interface AccountClassification {
  type: AccountClassificationType;
  confidence: number;
  reason: string;
}

export interface ClassifyAccountOptions extends AccountClassificationInput {
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  xaiModel: string;
  proxyUrl?: string;
  analyze?: (prompt: string) => Promise<string>;
}

const TYPES = new Set<AccountClassificationType>(['PROJECT', 'ALPHA', 'KOL', 'PERSONAL', 'UNKNOWN']);

export function buildAccountClassificationPrompt(input: AccountClassificationInput): string {
  return [
    '请判断这个 X 账号是否应该作为打新/链上热点项目进入推送频道。',
    '',
    '只返回 JSON，不要写 Markdown，不要写额外解释。JSON 格式必须是：',
    '{"type":"PROJECT","confidence":0.82,"reason":"一句中文理由"}',
    '',
    'type 只能是以下之一：',
    '- PROJECT：项目、协议、产品、应用、平台、官方账号',
    '- ALPHA：早期机会、链上热点、打新线索，信息不完整但更像项目或产品',
    '- KOL：个人影响力账号、交易员、研究员、博主、资讯号主',
    '- PERSONAL：普通个人账号、创始人个人号、团队成员个人号',
    '- UNKNOWN：信息不足，无法明确判断',
    '',
    '已知信息：',
    `- 事件：${input.title}`,
    `- 链接：${input.link}`,
    `- 监控池关注数：${input.count}`,
    `- 重要程度：${input.star} 星`,
    `- 原始内容：${input.content}`,
    '',
    '判断原则：',
    '- 项目、协议、产品、应用、平台、官方账号优先归为 PROJECT',
    '- 早期但明显像项目或机会线索的账号归为 ALPHA',
    '- 个人观点、交易观点、研究分享、博主身份明显的账号归为 KOL',
    '- 创始人或团队成员个人号归为 PERSONAL',
    '- 信息不足时归为 UNKNOWN'
  ].join('\n');
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

export function parseAccountClassificationResponse(text: string): AccountClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (error) {
    throw new Error(`无法解析账号分类 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('账号分类结果不是对象');
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.type !== 'string' || !TYPES.has(value.type as AccountClassificationType)) {
    throw new Error(`未知账号分类：${String(value.type)}`);
  }
  if (typeof value.confidence !== 'number' || Number.isNaN(value.confidence)) {
    throw new Error('账号分类 confidence 缺失或不是数字');
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    throw new Error('账号分类 reason 缺失');
  }

  return {
    type: value.type as AccountClassificationType,
    confidence: Math.max(0, Math.min(1, value.confidence)),
    reason: value.reason.trim()
  };
}

export function shouldAllowClassifiedAccount(result: AccountClassification): boolean {
  return result.type === 'PROJECT' || result.type === 'ALPHA' || result.type === 'UNKNOWN';
}

export async function classifyAccount(options: ClassifyAccountOptions): Promise<AccountClassification> {
  const prompt = buildAccountClassificationPrompt(options);
  const text = options.analyze
    ? await options.analyze(prompt)
    : await requestGrokAnalysis({
        apiKey: options.xaiApiKey ?? '',
        baseUrl: options.xaiBaseUrl,
        model: options.xaiModel,
        proxyUrl: options.proxyUrl,
        prompt
      });
  return parseAccountClassificationResponse(text);
}
```

- [ ] **Step 4: Run classifier tests and verify pass**

Run: `npm test -- tests/account-classifier.test.ts`

Expected: PASS.

---

### Task 2: Service Flow Classification Before Send

**Files:**
- Modify: `src/service.ts`
- Test: `tests/service.test.ts`

- [ ] **Step 1: Write failing service tests**

Modify `tests/service.test.ts` to add `classify` expectations:

```ts
it('classifies and analyzes 1-star project events before sending', async () => {
  const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
  const afterSend = vi.fn();
  const classify = vi.fn().mockResolvedValue({ allowPush: true, type: 'PROJECT' });

  await processAlphaMessage({
    raw: JSON.stringify({
      channel: 'follow',
      title: 'A 关注了 B',
      content: '用户简介: DeFi protocol\n你关注的5个用户也关注了ta',
      link: 'https://x.com/b',
      push_at: 1778660297
    }),
    receivedAt: new Date(1778660298123),
    commonFollowStarLevels: [5, 8, 12, 15, 20],
    dedupe: new Set(),
    send,
    classify,
    afterSend
  });

  expect(classify).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(afterSend).toHaveBeenCalledTimes(1);
});

it('blocks KOL events before sending to Telegram', async () => {
  const send = vi.fn();
  const afterSend = vi.fn();
  const classify = vi.fn().mockResolvedValue({ allowPush: false, type: 'KOL' });

  await processAlphaMessage({
    raw: JSON.stringify({
      channel: 'follow',
      title: 'A 关注了 B',
      content: '用户简介: trader and researcher\n你关注的20个用户也关注了ta',
      link: 'https://x.com/b',
      push_at: 1778660297
    }),
    receivedAt: new Date(1778660298123),
    commonFollowStarLevels: [5, 8, 12, 15, 20],
    dedupe: new Set(),
    send,
    classify,
    afterSend
  });

  expect(send).not.toHaveBeenCalled();
  expect(afterSend).not.toHaveBeenCalled();
});

it('pushes and analyzes when classification fails', async () => {
  const send = vi.fn().mockResolvedValue({ chatId: -1001, messageId: 10 });
  const afterSend = vi.fn();
  const classify = vi.fn().mockRejectedValue(new Error('classification failed'));

  await processAlphaMessage({
    raw: JSON.stringify({
      channel: 'follow',
      title: 'A 关注了 B',
      content: '用户简介: unclear\n你关注的5个用户也关注了ta',
      link: 'https://x.com/b',
      push_at: 1778660297
    }),
    receivedAt: new Date(1778660298123),
    commonFollowStarLevels: [5, 8, 12, 15, 20],
    dedupe: new Set(),
    send,
    classify,
    afterSend
  });

  expect(send).toHaveBeenCalledTimes(1);
  expect(afterSend).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `npm test -- tests/service.test.ts`

Expected: FAIL because `classify` and `afterSend` do not exist on `ProcessAlphaMessageOptions`.

- [ ] **Step 3: Update `processAlphaMessage()`**

Modify `src/service.ts`:

```ts
classify?: (
  message: Record<string, unknown>,
  count: number,
  star: number
) => Promise<{ allowPush: boolean; type: string; reason?: string }>;
afterSend?: (
  message: Record<string, unknown>,
  count: number,
  star: number,
  sendResult: TelegramSendResult
) => Promise<void>;
```

Then replace the current send/analyze block with:

```ts
if (options.classify) {
  try {
    const classification = await options.classify(message, count, decision.star);
    if (!classification.allowPush) {
      info(`账号分类拦截：type=${classification.type}${classification.reason ? ` reason=${classification.reason}` : ''}`);
      return;
    }
    info(`账号分类允许：type=${classification.type}${classification.reason ? ` reason=${classification.reason}` : ''}`);
  } catch (error) {
    warn(`账号分类失败，按保守策略推送：${error instanceof Error ? error.message : String(error)}`);
  }
}

const sendResult = await options.send(
  buildForwardMessage(
    message,
    count,
    decision.stars,
    calculateReceiveLatencyMs(message, options.receivedAt)
  )
);

if (options.afterSend) {
  await options.afterSend(message, count, decision.star, sendResult);
}
```

Keep legacy `analyze` only if needed for compatibility, or replace it fully in tests and service startup.

- [ ] **Step 4: Run service tests and verify pass**

Run: `npm test -- tests/service.test.ts`

Expected: PASS.

---

### Task 3: Runtime Integration

**Files:**
- Modify: `src/service.ts`
- Modify: `src/grok.ts`
- Test: `tests/service.test.ts`

- [ ] **Step 1: Import classifier in service runtime**

Add imports in `src/service.ts`:

```ts
import { classifyAccount, shouldAllowClassifiedAccount } from './account-classifier.js';
```

- [ ] **Step 2: Replace runtime `analyze` callback**

In `startAlphaService()`, pass `classify` before `send` and pass `afterSend` for analysis:

```ts
classify: async (message, count, star) => {
  const title = messageString(message, 'title');
  const content = messageString(message, 'content');
  const link = messageString(message, 'link');
  const result = await classifyAccount({
    xaiApiKey: options.config.xaiApiKey,
    xaiBaseUrl: options.config.xaiBaseUrl,
    xaiModel: options.config.xaiModel,
    proxyUrl: options.config.proxyUrl,
    title,
    content,
    link,
    count,
    star
  });
  return {
    allowPush: shouldAllowClassifiedAccount(result),
    type: result.type,
    reason: result.reason
  };
},
afterSend: async (message, count, star, sendResult) => {
  const link = messageString(message, 'link');
  const title = messageString(message, 'title');
  const content = messageString(message, 'content');
  const handle = parseChannelHandle(link) ?? link;
  const existingAnalysis = analysisTracker.get(handle);

  const result = await triggerAnalysisComment({
    xaiApiKey: options.config.xaiApiKey,
    xaiBaseUrl: options.config.xaiBaseUrl,
    xaiModel: options.config.xaiModel,
    proxyUrl: options.config.proxyUrl,
    discussionChatId: options.config.discussionChatId,
    discussionStore,
    botToken: options.config.telegramBotToken,
    channelChatId: sendResult.chatId,
    channelMessageId: sendResult.messageId,
    projectKey: handle,
    existingAnalysis,
    title,
    content,
    link,
    count,
    star,
    info,
    warn
  });

  if (!existingAnalysis && result && typeof result.messageId === 'number') {
    analysisTracker.set(handle, {
      discussionChatId: options.config.discussionChatId!,
      analysisMessageId: result.messageId
    });
  }
}
```

- [ ] **Step 3: Remove 3-star gating**

Remove the runtime dependency on `shouldTriggerGrokAnalysis(decision.star)`. All classified-and-sent events call `afterSend`.

- [ ] **Step 4: Run service tests and full tests**

Run:

```bash
npm test
npm run typecheck
```

Expected: PASS.

---

### Task 4: README and Commit

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update Chinese README**

Add a short section:

```md
## 账号分类过滤

服务会从 1 星开始先调用 Grok 做账号分类：

- `PROJECT` / `ALPHA` / `UNKNOWN`：发送频道主消息，并在关联讨论群写分析。
- `KOL` / `PERSONAL`：不发送频道消息，也不写分析。
- 分类失败时按保守策略继续推送并分析，避免漏掉潜在项目。

分类通过后，首次项目会生成 6 行投研分析；同一项目后续重复命中时，不再重复调用 Grok 分析，而是回复第一次分析评论做提醒。
```

- [ ] **Step 2: Run final verification**

Run:

```bash
npm test
npm run typecheck
git status --short
```

Expected:

- Tests pass.
- Typecheck passes.
- Changed files are classifier module, service, tests, README, and this plan.

- [ ] **Step 3: Commit implementation**

Run:

```bash
git add src/account-classifier.ts src/service.ts tests/account-classifier.test.ts tests/service.test.ts README.md docs/superpowers/plans/2026-05-14-account-classification-filter.md
git commit -m "feat: filter pushed accounts by Grok classification"
```

Expected: commit succeeds.

---

## Self-Review

- Spec coverage: The plan covers 1-star classification, KOL/PERSONAL blocking, PROJECT/ALPHA/UNKNOWN allowing, classification failure fallback, and all-star analysis after successful push.
- Placeholder scan: No `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: `classify`, `afterSend`, `AccountClassification`, and `shouldAllowClassifiedAccount` names are consistent across tasks.
