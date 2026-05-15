# Rug 评论区深挖实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 6551 Rug 历史分析中增加 quote tweets 和 `toUser` 搜索，补充目标账号近期帖子的评论区负面证据，并让 Grok 分析上下文不再展示 `source` 字样。

**Architecture:** 继续在 `rug-history-provider.ts` 内扩展证据采集，不新增运行时配置。近期推文接口返回后提取最多 3 条 tweet id，对每条调用 `twitter_quote_tweets_by_id`，同时增加两组 `toUser` 负面搜索；`grok.ts` 展示评论区证据，但不输出 `source` 或“数据源”字段。

**Tech Stack:** TypeScript, Vitest, 6551 Open API, Node.js fetch, Grok prompt。

---

## 文件结构

- Modify `src/rug-history-provider.ts`：扩展 `RugHistoryEvidence`，新增 tweet id 提取、quote tweets 查询、`toUser` 负面搜索、评论区样本去重。
- Modify `tests/rug-history-provider.test.ts`：覆盖 tweet id 提取、最多 3 条 quote 查询、评论区负面样本、单条 quote 查询失败。
- Modify `src/grok.ts`：prompt 增加评论区负面数量和样本，移除 `source` / `数据源` 文案。
- Modify `tests/grok.test.ts`：覆盖 prompt 不含 `source` / `数据源`，并包含评论区负面证据。
- Modify `README.md`：说明评论区深挖是 quote tweets + `toUser` 搜索，不是完整 replies 树。

---

### Task 1: RugHistoryEvidence 增加评论区字段

**Files:**
- Modify: `src/rug-history-provider.ts`
- Modify: `tests/rug-history-provider.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/rug-history-provider.test.ts` 新增测试：

```ts
it('collects negative quote and reply-like comment samples from recent tweets', async () => {
  const postOpen = vi.fn(async (endpoint: string, body: Record<string, unknown>) => {
    if (endpoint === 'twitter_user_tweets') {
      return {
        data: [
          { id: '1', text: 'launch update' },
          { idStr: '2', text: 'mint update' },
          { twId: '3', text: 'airdrop update' },
          { tweetId: '4', text: 'extra update' }
        ]
      };
    }
    if (endpoint === 'twitter_quote_tweets_by_id') {
      return { data: [{ text: `quote ${body.id} rug warning` }] };
    }
    if (endpoint === 'twitter_search') {
      if ('toUser' in body) return { data: [{ text: '@project_b 无法提现' }] };
      return { data: [] };
    }
    return { data: [] };
  });

  const evidence = await collectRugHistoryEvidence({
    link: 'https://x.com/project_b',
    twitterToken: 'token',
    twitterApiBaseUrl: 'https://ai.6551.io',
    client: { postOpen }
  });

  expect(evidence.checkedTweetCount).toBe(3);
  expect(evidence.commentNegativeCount).toBe(4);
  expect(evidence.commentNegativeSamples).toContain('quote 1 rug warning');
  expect(evidence.commentNegativeSamples).toContain('@project_b 无法提现');
  expect(postOpen.mock.calls.filter(([endpoint]) => endpoint === 'twitter_quote_tweets_by_id')).toHaveLength(3);
});

it('keeps comment evidence when one quote lookup fails', async () => {
  const postOpen = vi.fn(async (endpoint: string, body: Record<string, unknown>) => {
    if (endpoint === 'twitter_user_tweets') {
      return { data: [{ id: '1', text: 'one' }, { id: '2', text: 'two' }] };
    }
    if (endpoint === 'twitter_quote_tweets_by_id') {
      if (body.id === '1') throw new Error('quote failed');
      return { data: [{ text: 'second tweet scam warning' }] };
    }
    if (endpoint === 'twitter_search') return { data: [] };
    return { data: [] };
  });

  const evidence = await collectRugHistoryEvidence({
    link: 'https://x.com/project_b',
    twitterToken: 'token',
    twitterApiBaseUrl: 'https://ai.6551.io',
    client: { postOpen }
  });

  expect(evidence.checkedTweetCount).toBe(2);
  expect(evidence.commentNegativeSamples).toEqual(['second tweet scam warning']);
  expect(evidence.warnings.some((warning) => warning.includes('twitter_quote_tweets_by_id'))).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/rug-history-provider.test.ts`

Expected: FAIL，因为 `RugHistoryEvidence` 还没有 `checkedTweetCount`、`commentNegativeCount`、`commentNegativeSamples`。

- [ ] **Step 3: 实现字段和采集逻辑**

在 `src/rug-history-provider.ts` 扩展接口：

```ts
commentNegativeCount: number | null;
checkedTweetCount: number | null;
commentNegativeSamples: string[];
```

在 `emptyEvidence()` 和成功 evidence 初始值中设置：

```ts
commentNegativeCount: null,
checkedTweetCount: null,
commentNegativeSamples: [],
```

新增 helper：

```ts
const NEGATIVE_PATTERN = /rug|scam|drain|phishing|hacked|fraud|跑路|割|骗局|诈骗|钓鱼|黑客|归零|无法提现|退款/i;

function itemId(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  for (const key of ['id', 'idStr', 'twId', 'tweetId', 'rest_id']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function negativeTexts(items: unknown[], limit = 20): string[] {
  return sampleTexts(items, limit).filter((text) => NEGATIVE_PATTERN.test(text));
}
```

在 `twitter_user_tweets` 的 collect block 中保留 `recentTweetItems`，提取最多 3 个 id：

```ts
let recentTweetItems: unknown[] = [];
...
recentTweetItems = items;
```

在近期推文查询后新增 quote 查询：

```ts
const tweetIds = [...new Set(recentTweetItems.map(itemId).filter((id): id is string => Boolean(id)))].slice(0, 3);
evidence.checkedTweetCount = tweetIds.length;
if (tweetIds.length === 0) evidence.warnings.push('近期推文缺少可查询 tweet id，跳过 quote 评论区查询');

const commentNegativeTexts = new Set<string>();
for (const id of tweetIds) {
  await collectEndpoint(evidence, 'twitter_quote_tweets_by_id', async () => {
    const items = responseItems(await client.postOpen('twitter_quote_tweets_by_id', { id, maxResults: 20 }));
    for (const text of negativeTexts(items)) commentNegativeTexts.add(text);
  });
}
```

新增两组 `toUser` 搜索并合并到 `commentNegativeTexts`：

```ts
const replySearchBodies = [
  { toUser: username, keywords: 'rug OR scam OR drain OR phishing OR hacked OR fraud', maxResults: 20, product: 'Latest' },
  { toUser: username, keywords: '跑路 OR 割 OR 骗局 OR 诈骗 OR 钓鱼 OR 黑客 OR 归零 OR 无法提现', maxResults: 20, product: 'Latest' }
];
for (const body of replySearchBodies) {
  await collectEndpoint(evidence, 'twitter_search_to_user', async () => {
    const items = responseItems(await client.postOpen('twitter_search', body));
    for (const text of negativeTexts(items)) commentNegativeTexts.add(text);
  });
}
evidence.commentNegativeCount = commentNegativeTexts.size;
evidence.commentNegativeSamples = [...commentNegativeTexts].slice(0, 3);
```

- [ ] **Step 4: 验证 provider 测试通过**

Run: `npm test -- tests/rug-history-provider.test.ts`

Expected: PASS。

---

### Task 2: Grok prompt 展示评论区证据并移除 source

**Files:**
- Modify: `src/grok.ts`
- Modify: `tests/grok.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/grok.test.ts` 的 Rug evidence 测试输入中加入：

```ts
commentNegativeCount: 2,
checkedTweetCount: 3,
commentNegativeSamples: ['quote rug warning', '@b 无法提现'],
```

新增断言：

```ts
expect(prompt).toContain('评论区负面数量：2');
expect(prompt).toContain('检查推文数量：3');
expect(prompt).toContain('quote rug warning');
expect(prompt).not.toContain('source');
expect(prompt).not.toContain('数据源');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/grok.test.ts`

Expected: FAIL，因为 prompt 现在还包含 `Rug 历史数据源`，并且没有评论区字段。

- [ ] **Step 3: 调整 prompt**

在 `src/grok.ts` 的 `formatRugHistory()` 中：

- 删除 `Rug 历史数据源：...`
- 删除 `Rug 数据可用：...` 里可能让模型输出 source 的上下文
- 增加：

```ts
`检查推文数量：${evidence.checkedTweetCount ?? '未知'}`,
`评论区负面数量：${evidence.commentNegativeCount ?? '未知'}`,
'评论区负面样本：',
formatList(evidence.commentNegativeSamples),
```

没有 evidence 时返回：

```ts
['Rug 历史：未查询']
```

不要出现英文 `source` 或中文 `数据源`。

- [ ] **Step 4: 验证 Grok 测试通过**

Run: `npm test -- tests/grok.test.ts`

Expected: PASS。

---

### Task 3: README 和最终验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新中文说明**

在 `Rug 历史分析` 小节增加：

```md
评论区深挖使用 6551 的 `twitter_quote_tweets_by_id` 拉取近期推文的引用评论，并用 `twitter_search` 的 `toUser` + 负面关键词补充回复/提及搜索。当前不是完整 replies 树，而是 quote tweets + 搜索近似。
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
- 变更文件只包含 `src/rug-history-provider.ts`、`src/grok.ts`、相关测试、`README.md` 和本计划。

- [ ] **Step 3: 提交**

Run:

```bash
git add src/rug-history-provider.ts src/grok.ts tests/rug-history-provider.test.ts tests/grok.test.ts README.md docs/superpowers/plans/2026-05-14-rug-comment-deep-dive.md
git commit -m "feat: 新增 Rug 评论区深挖"
```

Expected: commit succeeds。

---

## 自审

- 覆盖 spec：quote tweets、toUser 搜索、最多 3 条推文、单条失败 warning、prompt 展示评论区证据。
- 覆盖用户新增要求：Grok prompt 不包含英文 `source` 或中文 `数据源`。
- 空白项扫描：没有遗留空白内容或缺失任务。
