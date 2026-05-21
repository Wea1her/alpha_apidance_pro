# Project Backing Followers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 6551-powered project backing evidence module so Grok analysis outputs an independent `2. 项目背景/背书账号` section with up to 10 prioritized Crypto official/project/VC/ecosystem/KOL follower accounts.

**Architecture:** Create a focused `project-backing-provider` that calls 6551 `twitter_kol_followers` and returns at most 30 normalized candidates. Inject that evidence into `buildGrokPrompt`, update the analysis skill to 8 fixed sections, and wire the provider into first-time analysis only. The model selects and orders the final 10 accounts from the provided candidate pool; code does not maintain a whitelist.

**Tech Stack:** TypeScript, Vitest, existing 6551 client, existing Grok prompt builder, existing analysis service queue.

---

## File Structure

- Create `src/project-backing-provider.ts`: collect and normalize 6551 project backing follower evidence.
- Create `tests/project-backing-provider.test.ts`: cover missing config, invalid links, endpoint errors, candidate parsing, limit 30, and invalid candidate skipping.
- Modify `src/grok.ts`: add `projectBacking` input and format prompt evidence before Rug history.
- Modify `tests/grok.test.ts`: cover successful, empty, and failed project backing prompt states.
- Modify `src/analysis-skill.ts`: update built-in default skill from 7 sections to 8 sections.
- Modify `analysis-skills/project-alpha.md`: update runtime skill from 7 sections to 8 sections.
- Modify `tests/analysis-skill.test.ts`: assert the new section and shifted Rug section requirements.
- Modify `src/analysis-service.ts`: collect project backing evidence on first analysis and pass it to `buildGrokPrompt`.
- Modify `tests/analysis-service.test.ts`: assert first analysis collects backing evidence and duplicate reminders do not.
- Modify `README.md`: document the new Grok section and 6551 dependency.

---

### Task 1: Project Backing Provider

**Files:**
- Create: `src/project-backing-provider.ts`
- Create: `tests/project-backing-provider.test.ts`

- [ ] **Step 1: Write failing provider tests**

Create `tests/project-backing-provider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  PROJECT_BACKING_CANDIDATE_LIMIT,
  collectProjectBackingEvidence,
  extractUsernameFromXLink
} from '../src/project-backing-provider.js';

describe('project backing provider', () => {
  it('extracts username from X links', () => {
    expect(extractUsernameFromXLink('https://x.com/project_b')).toBe('project_b');
    expect(extractUsernameFromXLink('https://twitter.com/project_b/status/1')).toBe('project_b');
    expect(extractUsernameFromXLink('')).toBeNull();
  });

  it('returns warning evidence when token is missing', async () => {
    await expect(
      collectProjectBackingEvidence({
        link: 'https://x.com/project_b',
        twitterToken: undefined,
        twitterApiBaseUrl: 'https://ai.6551.io'
      })
    ).resolves.toMatchObject({
      source: '6551',
      available: false,
      candidateCount: null,
      candidates: [],
      warnings: ['未配置 TWITTER_TOKEN，跳过 6551 项目背书查询']
    });
  });

  it('returns warning evidence when username cannot be extracted', async () => {
    await expect(
      collectProjectBackingEvidence({
        link: 'not-a-twitter-link',
        twitterToken: 'token',
        twitterApiBaseUrl: 'https://ai.6551.io'
      })
    ).resolves.toMatchObject({
      source: '6551',
      available: false,
      candidateCount: null,
      candidates: [],
      warnings: ['无法从 X 链接提取 username，跳过 6551 项目背书查询']
    });
  });

  it('calls twitter_kol_followers and normalizes candidate accounts', async () => {
    const postOpen = vi.fn(async (endpoint: string) => {
      if (endpoint === 'twitter_kol_followers') {
        return {
          data: [
            {
              username: 'aave',
              name: 'Aave',
              description: 'Aave Protocol official account',
              followersCount: 730000,
              verified: true,
              category: 'project'
            },
            {
              screenName: '@paradigm',
              displayName: 'Paradigm',
              bio: 'A research-driven crypto investment firm',
              followers_count: 410000,
              isBlueVerified: true,
              type: 'vc'
            }
          ]
        };
      }
      return { data: [] };
    });

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(postOpen).toHaveBeenCalledWith('twitter_kol_followers', { username: 'project_b' });
    expect(evidence).toEqual({
      source: '6551',
      available: true,
      candidateCount: 2,
      candidates: [
        {
          username: 'aave',
          displayName: 'Aave',
          description: 'Aave Protocol official account',
          followersCount: 730000,
          verified: true,
          rawCategory: 'project'
        },
        {
          username: 'paradigm',
          displayName: 'Paradigm',
          description: 'A research-driven crypto investment firm',
          followersCount: 410000,
          verified: true,
          rawCategory: 'vc'
        }
      ],
      warnings: []
    });
  });

  it('supports nested result users arrays and skips rows without username', async () => {
    const postOpen = vi.fn(async () => ({
      result: {
        users: [
          { userName: 'base', displayName: 'Base', bio: 'Ethereum L2 incubated by Coinbase' },
          { displayName: 'Missing Handle', bio: 'cannot be used' }
        ]
      }
    }));

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.candidateCount).toBe(1);
    expect(evidence.candidates).toEqual([
      {
        username: 'base',
        displayName: 'Base',
        description: 'Ethereum L2 incubated by Coinbase'
      }
    ]);
  });

  it('limits candidates to the configured prompt candidate limit', async () => {
    const postOpen = vi.fn(async () => ({
      data: Array.from({ length: PROJECT_BACKING_CANDIDATE_LIMIT + 5 }, (_, index) => ({
        username: `kol_${index + 1}`,
        name: `KOL ${index + 1}`
      }))
    }));

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.candidateCount).toBe(PROJECT_BACKING_CANDIDATE_LIMIT + 5);
    expect(evidence.candidates).toHaveLength(PROJECT_BACKING_CANDIDATE_LIMIT);
    expect(evidence.candidates[0]?.username).toBe('kol_1');
    expect(evidence.candidates.at(-1)?.username).toBe(`kol_${PROJECT_BACKING_CANDIDATE_LIMIT}`);
  });

  it('returns warning evidence when 6551 lookup fails', async () => {
    const postOpen = vi.fn(async () => {
      throw new Error('rate limited');
    });

    const evidence = await collectProjectBackingEvidence({
      link: 'https://x.com/project_b',
      twitterToken: 'token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      client: { postOpen }
    });

    expect(evidence.available).toBe(false);
    expect(evidence.candidateCount).toBeNull();
    expect(evidence.candidates).toEqual([]);
    expect(evidence.warnings).toEqual(['twitter_kol_followers 查询失败：rate limited']);
  });
});
```

- [ ] **Step 2: Run provider tests and verify they fail**

Run:

```bash
npm test -- tests/project-backing-provider.test.ts
```

Expected: FAIL because `../src/project-backing-provider.js` does not exist.

- [ ] **Step 3: Implement the provider**

Create `src/project-backing-provider.ts`:

```ts
import { createTwitter6551Client, type Twitter6551Client } from './twitter-6551-client.js';

export const PROJECT_BACKING_CANDIDATE_LIMIT = 30;

export interface ProjectBackingCandidate {
  username: string;
  displayName?: string;
  description?: string;
  followersCount?: number;
  verified?: boolean;
  rawCategory?: string;
}

export interface ProjectBackingEvidence {
  source: '6551';
  available: boolean;
  candidateCount: number | null;
  candidates: ProjectBackingCandidate[];
  warnings: string[];
}

export interface CollectProjectBackingEvidenceOptions {
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

function emptyEvidence(warnings: string[] = []): ProjectBackingEvidence {
  return {
    source: '6551',
    available: false,
    candidateCount: null,
    candidates: [],
    warnings
  };
}

function responseItems(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  const record = response as Record<string, unknown>;
  for (const key of ['data', 'result', 'users']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>;
      for (const nestedKey of ['items', 'users', 'data', 'result']) {
        const nestedValue = nested[nestedKey];
        if (Array.isArray(nestedValue)) return nestedValue;
      }
    }
  }
  return [];
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

function booleanField(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function normalizeUsername(value: string | undefined): string | undefined {
  const normalized = value?.replace(/^@/, '').trim();
  return normalized && /^[A-Za-z0-9_]{1,15}$/.test(normalized) ? normalized : undefined;
}

function parseCandidate(item: unknown): ProjectBackingCandidate | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const username = normalizeUsername(stringField(record, ['username', 'screenName', 'userName', 'handle']));
  if (!username) return null;

  const candidate: ProjectBackingCandidate = { username };
  const displayName = stringField(record, ['displayName', 'name']);
  const description = stringField(record, ['description', 'bio']);
  const followersCount = numberField(record, ['followersCount', 'followers_count', 'followers']);
  const verified = booleanField(record, ['verified', 'isBlueVerified', 'blueVerified']);
  const rawCategory = stringField(record, ['rawCategory', 'category', 'type']);

  if (displayName) candidate.displayName = displayName;
  if (description) candidate.description = description;
  if (followersCount !== undefined) candidate.followersCount = followersCount;
  if (verified !== undefined) candidate.verified = verified;
  if (rawCategory) candidate.rawCategory = rawCategory;
  return candidate;
}

export async function collectProjectBackingEvidence(
  options: CollectProjectBackingEvidenceOptions
): Promise<ProjectBackingEvidence> {
  if (!options.twitterToken) {
    return emptyEvidence(['未配置 TWITTER_TOKEN，跳过 6551 项目背书查询']);
  }

  const username = extractUsernameFromXLink(options.link);
  if (!username) {
    return emptyEvidence(['无法从 X 链接提取 username，跳过 6551 项目背书查询']);
  }

  const client = options.client ?? createTwitter6551Client({
    token: options.twitterToken,
    baseUrl: options.twitterApiBaseUrl,
    proxyUrl: options.proxyUrl
  });

  try {
    const items = responseItems(await client.postOpen('twitter_kol_followers', { username }));
    const candidates = items.map(parseCandidate).filter((value): value is ProjectBackingCandidate => value !== null);
    return {
      source: '6551',
      available: true,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, PROJECT_BACKING_CANDIDATE_LIMIT),
      warnings: []
    };
  } catch (error) {
    return emptyEvidence([
      `twitter_kol_followers 查询失败：${error instanceof Error ? error.message : String(error)}`
    ]);
  }
}
```

- [ ] **Step 4: Run provider tests and verify they pass**

Run:

```bash
npm test -- tests/project-backing-provider.test.ts
```

Expected: PASS, 7 tests passed.

- [ ] **Step 5: Commit provider**

Run:

```bash
git add src/project-backing-provider.ts tests/project-backing-provider.test.ts
git commit -m "feat: 新增项目背书账号查询"
```

---

### Task 2: Grok Prompt Evidence Injection

**Files:**
- Modify: `src/grok.ts`
- Modify: `tests/grok.test.ts`

- [ ] **Step 1: Write failing Grok prompt tests**

In `tests/grok.test.ts`, add these tests inside `describe('buildGrokPrompt', () => { ... })`, before `uses analysis skill text for output instructions`:

```ts
  it('includes project backing candidates and prioritization rules when provided', () => {
    const prompt = buildGrokPrompt({
      title: 'A 关注了 B',
      content: '用户简介: builder',
      link: 'https://x.com/b',
      count: 12,
      star: 3,
      projectBacking: {
        source: '6551',
        available: true,
        candidateCount: 2,
        candidates: [
          {
            username: 'aave',
            displayName: 'Aave',
            description: 'Aave Protocol official account',
            followersCount: 730000,
            verified: true,
            rawCategory: 'project'
          },
          {
            username: 'paradigm',
            displayName: 'Paradigm',
            description: 'A research-driven crypto investment firm',
            followersCount: 410000,
            verified: true,
            rawCategory: 'vc'
          }
        ],
        warnings: []
      }
    });

    expect(prompt).toContain('项目背景/背书账号证据：');
    expect(prompt).toContain('6551 背书账号状态：查询成功');
    expect(prompt).toContain('候选账号数量：2');
    expect(prompt).toContain('只能从以下候选账号中选最多 10 个');
    expect(prompt).toContain('项目方/协议官方/产品官方、交易所官方、VC/基金、生态官方/公链/Foundation/Labs');
    expect(prompt).toContain('@aave | Aave | verified=true | followers=730000 | category=project | bio=Aave Protocol official account');
    expect(prompt).toContain('@paradigm | Paradigm | verified=true | followers=410000 | category=vc | bio=A research-driven crypto investment firm');
    expect(prompt.indexOf('项目背景/背书账号证据：')).toBeLessThan(prompt.indexOf('Rug 历史'));
    expect(prompt).not.toContain('source');
    expect(prompt).not.toContain('数据源');
  });

  it('marks empty project backing lookup as found no known crypto backing accounts', () => {
    const prompt = buildGrokPrompt({
      title: 'A 关注了 B',
      content: '用户简介: builder',
      link: 'https://x.com/b',
      count: 12,
      star: 3,
      projectBacking: {
        source: '6551',
        available: true,
        candidateCount: 0,
        candidates: [],
        warnings: []
      }
    });

    expect(prompt).toContain('6551 背书账号状态：查询成功但未发现');
    expect(prompt).toContain('第 2 节必须说明未查询到知名 Crypto 背书账号');
    expect(prompt).not.toContain('候选账号：\n  -');
  });

  it('marks failed project backing lookup as a data gap', () => {
    const prompt = buildGrokPrompt({
      title: 'A 关注了 B',
      content: '用户简介: builder',
      link: 'https://x.com/b',
      count: 12,
      star: 3,
      projectBacking: {
        source: '6551',
        available: false,
        candidateCount: null,
        candidates: [],
        warnings: ['未配置 TWITTER_TOKEN，跳过 6551 项目背书查询']
      }
    });

    expect(prompt).toContain('6551 背书账号状态：未查询或查询失败');
    expect(prompt).toContain('第 2 节必须说明当前无法确认知名 Crypto 背书账号');
    expect(prompt).toContain('未配置 TWITTER_TOKEN，跳过 6551 项目背书查询');
  });
```

- [ ] **Step 2: Run Grok tests and verify they fail**

Run:

```bash
npm test -- tests/grok.test.ts
```

Expected: FAIL because `GrokAnalysisInput` does not have `projectBacking` and prompt formatting does not include backing evidence.

- [ ] **Step 3: Implement prompt formatting**

In `src/grok.ts`, add the import:

```ts
import type { ProjectBackingCandidate, ProjectBackingEvidence } from './project-backing-provider.js';
```

Add `projectBacking?: ProjectBackingEvidence;` to `GrokAnalysisInput`:

```ts
export interface GrokAnalysisInput {
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
  projectBacking?: ProjectBackingEvidence;
  rugHistory?: RugHistoryEvidence;
  analysisSkill?: string;
}
```

Add these helpers above `formatRugHistory`:

```ts
function compactText(value: string | undefined, maxLength = 180): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return '暂无';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function formatProjectBackingCandidate(candidate: ProjectBackingCandidate): string {
  return [
    `@${candidate.username}`,
    candidate.displayName ?? '未知显示名',
    `verified=${candidate.verified === undefined ? '未知' : String(candidate.verified)}`,
    `followers=${candidate.followersCount ?? '未知'}`,
    `category=${candidate.rawCategory ?? '未知'}`,
    `bio=${compactText(candidate.description)}`
  ].join(' | ');
}

function formatProjectBacking(evidence: ProjectBackingEvidence | undefined): string[] {
  if (!evidence) return ['项目背景/背书账号证据：未查询'];

  if (!evidence.available || evidence.warnings.length > 0) {
    return [
      '项目背景/背书账号证据：',
      '6551 背书账号状态：未查询或查询失败',
      '要求：第 2 节必须说明当前无法确认知名 Crypto 背书账号，不能据此推断存在背书。',
      '数据警告：',
      formatList(evidence.warnings)
    ];
  }

  if (evidence.candidates.length === 0) {
    return [
      '项目背景/背书账号证据：',
      '6551 背书账号状态：查询成功但未发现',
      `候选账号数量：${evidence.candidateCount ?? 0}`,
      '要求：第 2 节必须说明未查询到知名 Crypto 背书账号，不能把背书作为主要关注理由。'
    ];
  }

  return [
    '项目背景/背书账号证据：',
    '6551 背书账号状态：查询成功',
    `候选账号数量：${evidence.candidateCount ?? evidence.candidates.length}`,
    '筛选要求：只能从以下候选账号中选最多 10 个，优先级为项目方/协议官方/产品官方、交易所官方、VC/基金、生态官方/公链/Foundation/Labs、知名 Crypto KOL、媒体/社区号、其他。不得编造候选池外账号。',
    '候选账号：',
    evidence.candidates.map((candidate) => `  - ${formatProjectBackingCandidate(candidate)}`).join('\n')
  ];
}
```

In `buildGrokPrompt`, insert project backing before Rug history:

```ts
    ...formatProjectBacking(input.projectBacking),
    '',
    ...formatRugHistory(input.rugHistory),
```

- [ ] **Step 4: Run Grok tests and verify they pass**

Run:

```bash
npm test -- tests/grok.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit prompt changes**

Run:

```bash
git add src/grok.ts tests/grok.test.ts
git commit -m "feat: 注入项目背书账号证据"
```

---

### Task 3: Analysis Skill 8-Section Output

**Files:**
- Modify: `src/analysis-skill.ts`
- Modify: `analysis-skills/project-alpha.md`
- Modify: `tests/analysis-skill.test.ts`

- [ ] **Step 1: Write failing analysis skill tests**

In `tests/analysis-skill.test.ts`, extend `keeps the default skill aligned with the asymmetric trading analysis rules` with these assertions:

```ts
    expect(DEFAULT_ANALYSIS_SKILL).toContain('项目背景/背书账号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('项目背景/背书账号证据');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('最多列 10 个账号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不得编造未出现在候选池中的账号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('项目方、交易所、VC、基金、生态官方');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('主要是 KOL 关注，不等同于项目方/VC/生态背书');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('8. Rug 历史/风险');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('第 8 节明确写“发现 CA/合约相关删帖”');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('`1. 项目核心信息`、`2. 项目背景/背书账号`、`3. 当前进展`、`4. 优点`、`5. 缺点`、`6. 关注理由`、`7. 标签`、`8. Rug 历史/风险`');
```

Also change the old fixed title assertion expectation from 7 sections to 8 sections if it exists in the test after implementation.

- [ ] **Step 2: Run analysis skill tests and verify they fail**

Run:

```bash
npm test -- tests/analysis-skill.test.ts
```

Expected: FAIL because the default skill still describes 7 sections and Rug is still section 7.

- [ ] **Step 3: Update built-in default skill**

In `src/analysis-skill.ts`, replace `DEFAULT_ANALYSIS_SKILL` with this complete 8-section string:

```ts
export const DEFAULT_ANALYSIS_SKILL = `# 项目/Alpha 账号分析 Skill

## 目标
用小资金试错、低成本试错、高赔率机会优先的交易风格，判断该 X 账号是否值得作为打新、空投、链上热点跟踪目标。重点看“投入很小但潜在收益很大”的不对称机会，避免把早期账号简单按大项目成熟度否定。

## 分析原则
- 热度和背书优先：优先看是否被知名项目方、蓝 V、KOL、交易所、基金、生态官方关注，其次看帖子浏览量、评论量、转发量、点赞量、讨论密度和监控池共同关注数。
- 项目背景必须基于证据：第 2 节必须优先使用“项目背景/背书账号证据”，只能从候选池中选择账号，不得编造未出现在候选池中的账号。
- 背书排序优先级：项目方、协议官方、产品官方、交易所、VC、基金、生态官方、公链、Foundation、Labs 优先；这些不足 10 个时，再补充知名 Crypto KOL、媒体、社区号或其他账号。
- follower 基数、follower 增长、互动率只作为辅助：不要因为 follower 基数小就直接写“不值得作为主要打新/链上热点跟踪目标”；早期账号应重点判断是否值得小资金试错。
- 信息不足时不要模糊乐观：缺少知名账号背书、帖子热度或链上关联时，要明确写“缺少硬数据支撑”，但结论应围绕小资金试错价值，而不是默认否定。
- 低成本参与优先：只要出现知名账号背书、帖子热度异常、监控池升星快或存在测试网/积分/空投/mint/白名单等早期窗口，就可以给出小仓试错或重点跟踪；只有风险证据强或热度/背书都缺失时才暂不参与。
- 风险必须具体：Rug 历史必须优先使用“Rug 证据状态”和“Rug 结论”；不能只写“暂无直接证据”，还要结合类似项目结局、删帖频率、评论区负面反馈判断风险等级；如果存在“合约相关删帖原文”，必须在第 8 节明确写“发现 CA/合约相关删帖”，在本节最后单独引用这些原文并说明风险含义，但不能只凭这一点直接判定跑路。

## 分析维度
1. 项目核心信息：概括这个账号/项目的核心定位、产品或叙事。
2. 项目背景/背书账号：必须优先使用“项目背景/背书账号证据”；如果查询成功且有候选账号，按项目方/协议官方/产品官方、交易所、VC/基金、生态官方/公链/Foundation/Labs、知名 Crypto KOL、媒体/社区号、其他的优先级，最多列 10 个账号，并说明背书含义；如果只有 KOL 或媒体关注，必须说明“主要是 KOL 关注，不等同于项目方/VC/生态背书”；如果查询失败或为空，必须明示“无法确认知名 Crypto 背书账号”或“未查询到知名 Crypto 背书账号”，不得写成有背书。
3. 当前进展：概括目前阶段、动作和热度；必须优先写知名项目方/蓝 V/KOL 等关注背书是否可见、帖子浏览量/评论量/转发量等热度是否异常、链上关联是否可见，follower 增长和互动率只作为辅助信息。
4. 优点：从增长、产品、叙事、资源、传播性等角度提炼 1-2 点。
5. 缺点：从真实性、落地性、可持续性、估值泡沫、信息不足等角度提炼 1-2 点。
6. 关注理由：必须从“小资金博高收益”的角度给出是否值得小资金试错/重点跟踪/暂不参与，操作只能从“小仓试错、重点跟踪、暂不参与”中选择；优先结合知名项目方/蓝 V/KOL 关注、帖子浏览量、评论量、转发量、互动热度、监控池关注数和升星速度说明理由，follower 基数不得作为主要否定理由。
7. 标签：给出 2-4 个中文短标签，用顿号分隔。
8. Rug 历史/风险：先写明 Rug 证据状态属于“未查询或查询失败 / 查询成功但无直接证据 / 有负面噪声但相关性不足 / 有明确风险证据”哪一类，再基于删帖记录、删帖频率、负面提及、评论区负面样本、类似项目结局判断是否存在跑路、骗局、严重负面历史；没有直接证据时只能写“未发现直接 Rug 证据”，不能写成“确认无 Rug 历史”；如果有合约相关删帖原文，必须明确写“发现 CA/合约相关删帖”，并把原文放在本节最后；不能只凭这一点直接判定跑路。

## 输出要求
- 严格按分析维度输出 8 个章节，每个章节都必须有内容。
- 章节标题单独一行，正文必须另起下一行输出，不要把正文接在标题同一行。
- 章节标题格式固定为 \`1. 项目核心信息\`、\`2. 项目背景/背书账号\`、\`3. 当前进展\`、\`4. 优点\`、\`5. 缺点\`、\`6. 关注理由\`、\`7. 标签\`、\`8. Rug 历史/风险\`。
- 不要写前言，不要写总结。
- 全部使用中文。
- 风格专业、克制、信息密度高。
- 每行可以扩充到接近 100 字，优先保证具体、全面、可执行，不要为了短而省略关键判断。
- 不要使用 Markdown 加粗或斜体，不要输出 * 号。
- 不要输出 Source、来源、参考来源、数据来源或引用列表。`;
```

- [ ] **Step 4: Update runtime Markdown skill**

Replace `analysis-skills/project-alpha.md` with the same Markdown content inside the template string from Step 3, without the TypeScript export wrapper and without escaping backticks:

```markdown
# 项目/Alpha 账号分析 Skill

## 目标
用小资金试错、低成本试错、高赔率机会优先的交易风格，判断该 X 账号是否值得作为打新、空投、链上热点跟踪目标。重点看“投入很小但潜在收益很大”的不对称机会，避免把早期账号简单按大项目成熟度否定。

## 分析原则
- 热度和背书优先：优先看是否被知名项目方、蓝 V、KOL、交易所、基金、生态官方关注，其次看帖子浏览量、评论量、转发量、点赞量、讨论密度和监控池共同关注数。
- 项目背景必须基于证据：第 2 节必须优先使用“项目背景/背书账号证据”，只能从候选池中选择账号，不得编造未出现在候选池中的账号。
- 背书排序优先级：项目方、协议官方、产品官方、交易所、VC、基金、生态官方、公链、Foundation、Labs 优先；这些不足 10 个时，再补充知名 Crypto KOL、媒体、社区号或其他账号。
- follower 基数、follower 增长、互动率只作为辅助：不要因为 follower 基数小就直接写“不值得作为主要打新/链上热点跟踪目标”；早期账号应重点判断是否值得小资金试错。
- 信息不足时不要模糊乐观：缺少知名账号背书、帖子热度或链上关联时，要明确写“缺少硬数据支撑”，但结论应围绕小资金试错价值，而不是默认否定。
- 低成本参与优先：只要出现知名账号背书、帖子热度异常、监控池升星快或存在测试网/积分/空投/mint/白名单等早期窗口，就可以给出小仓试错或重点跟踪；只有风险证据强或热度/背书都缺失时才暂不参与。
- 风险必须具体：Rug 历史必须优先使用“Rug 证据状态”和“Rug 结论”；不能只写“暂无直接证据”，还要结合类似项目结局、删帖频率、评论区负面反馈判断风险等级；如果存在“合约相关删帖原文”，必须在第 8 节明确写“发现 CA/合约相关删帖”，在本节最后单独引用这些原文并说明风险含义，但不能只凭这一点直接判定跑路。

## 分析维度
1. 项目核心信息：概括这个账号/项目的核心定位、产品或叙事。
2. 项目背景/背书账号：必须优先使用“项目背景/背书账号证据”；如果查询成功且有候选账号，按项目方/协议官方/产品官方、交易所、VC/基金、生态官方/公链/Foundation/Labs、知名 Crypto KOL、媒体/社区号、其他的优先级，最多列 10 个账号，并说明背书含义；如果只有 KOL 或媒体关注，必须说明“主要是 KOL 关注，不等同于项目方/VC/生态背书”；如果查询失败或为空，必须明示“无法确认知名 Crypto 背书账号”或“未查询到知名 Crypto 背书账号”，不得写成有背书。
3. 当前进展：概括目前阶段、动作和热度；必须优先写知名项目方/蓝 V/KOL 等关注背书是否可见、帖子浏览量/评论量/转发量等热度是否异常、链上关联是否可见，follower 增长和互动率只作为辅助信息。
4. 优点：从增长、产品、叙事、资源、传播性等角度提炼 1-2 点。
5. 缺点：从真实性、落地性、可持续性、估值泡沫、信息不足等角度提炼 1-2 点。
6. 关注理由：必须从“小资金博高收益”的角度给出是否值得小资金试错/重点跟踪/暂不参与，操作只能从“小仓试错、重点跟踪、暂不参与”中选择；优先结合知名项目方/蓝 V/KOL 关注、帖子浏览量、评论量、转发量、互动热度、监控池关注数和升星速度说明理由，follower 基数不得作为主要否定理由。
7. 标签：给出 2-4 个中文短标签，用顿号分隔。
8. Rug 历史/风险：先写明 Rug 证据状态属于“未查询或查询失败 / 查询成功但无直接证据 / 有负面噪声但相关性不足 / 有明确风险证据”哪一类，再基于删帖记录、删帖频率、负面提及、评论区负面样本、类似项目结局判断是否存在跑路、骗局、严重负面历史；没有直接证据时只能写“未发现直接 Rug 证据”，不能写成“确认无 Rug 历史”；如果有合约相关删帖原文，必须明确写“发现 CA/合约相关删帖”，并把原文放在本节最后；不能只凭这一点直接判定跑路。

## 输出要求
- 严格按分析维度输出 8 个章节，每个章节都必须有内容。
- 章节标题单独一行，正文必须另起下一行输出，不要把正文接在标题同一行。
- 章节标题格式固定为 `1. 项目核心信息`、`2. 项目背景/背书账号`、`3. 当前进展`、`4. 优点`、`5. 缺点`、`6. 关注理由`、`7. 标签`、`8. Rug 历史/风险`。
- 不要写前言，不要写总结。
- 全部使用中文。
- 风格专业、克制、信息密度高。
- 每行可以扩充到接近 100 字，优先保证具体、全面、可执行，不要为了短而省略关键判断。
- 不要使用 Markdown 加粗或斜体，不要输出 * 号。
- 不要输出 Source、来源、参考来源、数据来源或引用列表。
```

- [ ] **Step 5: Run analysis skill tests and verify they pass**

Run:

```bash
npm test -- tests/analysis-skill.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit analysis skill changes**

Run:

```bash
git add src/analysis-skill.ts analysis-skills/project-alpha.md tests/analysis-skill.test.ts
git commit -m "feat: 增加项目背景背书分析章节"
```

---

### Task 4: Analysis Service Wiring

**Files:**
- Modify: `src/analysis-service.ts`
- Modify: `tests/analysis-service.test.ts`

- [ ] **Step 1: Write failing analysis service tests**

In `tests/analysis-service.test.ts`, update the first test to define and assert `getProjectBacking` is not called for duplicate reminders:

```ts
    const getProjectBacking = vi.fn();
```

Pass it into `triggerAnalysisComment` in the first test:

```ts
      getProjectBacking,
```

Add this assertion after the existing `expect(getRugHistory).not.toHaveBeenCalled();`:

```ts
    expect(getProjectBacking).not.toHaveBeenCalled();
```

In `returns the created analysis comment message on first analysis`, add this mock:

```ts
    const getProjectBacking = vi.fn().mockResolvedValue({
      source: '6551',
      available: true,
      candidateCount: 2,
      candidates: [
        {
          username: 'aave',
          displayName: 'Aave',
          description: 'Aave Protocol official account',
          followersCount: 730000,
          verified: true,
          rawCategory: 'project'
        },
        {
          username: 'paradigm',
          displayName: 'Paradigm',
          description: 'A research-driven crypto investment firm',
          followersCount: 410000,
          verified: true,
          rawCategory: 'vc'
        }
      ],
      warnings: []
    });
```

Pass it into `triggerAnalysisComment`:

```ts
        getProjectBacking,
```

Add these assertions after the existing `expect(getRugHistory).toHaveBeenCalledWith(...)` block:

```ts
    expect(getProjectBacking).toHaveBeenCalledWith({
      link: 'https://x.com/b',
      twitterToken: 'twitter-token',
      twitterApiBaseUrl: 'https://ai.6551.io',
      proxyUrl: 'http://127.0.0.1:7890'
    });
```

Add these prompt assertions near the existing `expect(analyze.mock.calls[0][0]).toContain(...)` assertions:

```ts
    expect(analyze.mock.calls[0][0]).toContain('项目背景/背书账号证据');
    expect(analyze.mock.calls[0][0]).toContain('@aave');
    expect(analyze.mock.calls[0][0]).toContain('@paradigm');
```

In `removes source blocks from the sent Grok analysis text`, add this mock:

```ts
    const getProjectBacking = vi.fn().mockResolvedValue({
      source: '6551',
      available: true,
      candidateCount: 0,
      candidates: [],
      warnings: []
    });
```

Pass it into the third `triggerAnalysisComment` call:

```ts
      getProjectBacking,
```

- [ ] **Step 2: Run analysis service tests and verify they fail**

Run:

```bash
npm test -- tests/analysis-service.test.ts
```

Expected: FAIL because `TriggerAnalysisOptions` does not have `getProjectBacking` and service does not call it.

- [ ] **Step 3: Wire provider into analysis service**

In `src/analysis-service.ts`, add this import:

```ts
import {
  collectProjectBackingEvidence,
  type ProjectBackingEvidence
} from './project-backing-provider.js';
```

Add this option to `TriggerAnalysisOptions` after `getRugHistory`:

```ts
  getProjectBacking?: (options: {
    link: string;
    twitterToken?: string;
    twitterApiBaseUrl: string;
    proxyUrl?: string;
  }) => Promise<ProjectBackingEvidence>;
```

Replace the sequential rug history and skill loading block:

```ts
  const rugHistory = await (options.getRugHistory ?? collectRugHistoryEvidence)({
    link: options.link,
    twitterToken: options.twitterToken,
    twitterApiBaseUrl: options.twitterApiBaseUrl ?? 'https://ai.6551.io',
    proxyUrl: options.proxyUrl
  });
  const analysisSkill = await (options.loadSkill ?? loadAnalysisSkill)();
```

with this parallel collection:

```ts
  const twitterApiBaseUrl = options.twitterApiBaseUrl ?? 'https://ai.6551.io';
  const [rugHistory, projectBacking, analysisSkill] = await Promise.all([
    (options.getRugHistory ?? collectRugHistoryEvidence)({
      link: options.link,
      twitterToken: options.twitterToken,
      twitterApiBaseUrl,
      proxyUrl: options.proxyUrl
    }),
    (options.getProjectBacking ?? collectProjectBackingEvidence)({
      link: options.link,
      twitterToken: options.twitterToken,
      twitterApiBaseUrl,
      proxyUrl: options.proxyUrl
    }),
    (options.loadSkill ?? loadAnalysisSkill)()
  ]);
```

Pass `projectBacking` into `buildGrokPrompt`:

```ts
    projectBacking,
    rugHistory,
    analysisSkill
```

- [ ] **Step 4: Run analysis service tests and verify they pass**

Run:

```bash
npm test -- tests/analysis-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run focused integration tests**

Run:

```bash
npm test -- tests/project-backing-provider.test.ts tests/grok.test.ts tests/analysis-skill.test.ts tests/analysis-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit service wiring**

Run:

```bash
git add src/analysis-service.ts tests/analysis-service.test.ts
git commit -m "feat: 串联项目背书账号分析"
```

---

### Task 5: README Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update Grok analysis section**

In `README.md`, find the `## Grok 分析` section and replace the 7-section list with:

```markdown
分析默认输出 8 个章节：

1. 项目核心信息
2. 项目背景/背书账号
3. 当前进展
4. 优点
5. 缺点
6. 关注理由
7. 标签
8. Rug 历史/风险
```

- [ ] **Step 2: Add project backing documentation**

After the Grok analysis section and before the Rug history section, add:

```markdown
## 项目背景/背书账号

首次 Grok 分析会使用 6551 的 `twitter_kol_followers` 查询目标 X 账号被哪些知名账号关注，并把最多 30 个候选账号注入 Grok 输入。Grok 会在 `2. 项目背景/背书账号` 中从候选池里选最多 10 个账号输出，优先展示项目方、协议官方、产品官方、交易所、VC、基金、生态官方、公链、Foundation、Labs；这些不足时再补充知名 Crypto KOL、媒体或社区号。

该功能复用 `TWITTER_TOKEN`、`TWITTER_API_BASE_URL` 和 `PROXY_URL`。如果没有配置 `TWITTER_TOKEN`，或者 6551 查询失败，主推送和 Grok 分析不会中断；第 2 节会说明“无法确认知名 Crypto 背书账号”，不能据此推断存在背书。
```

- [ ] **Step 3: Search README for stale 7-section wording**

Run:

```bash
rg -n "7\\. Rug 历史/风险|输出 7|7 个章节|第 7 节" README.md
```

Expected: no stale Grok-output lines remain. Lines about older docs under `docs/superpowers/` are not part of this README check.

- [ ] **Step 4: Commit README changes**

Run:

```bash
git add README.md
git commit -m "docs: 说明项目背书账号分析"
```

---

### Task 6: Full Verification

**Files:**
- Verify: `src/project-backing-provider.ts`
- Verify: `src/grok.ts`
- Verify: `src/analysis-skill.ts`
- Verify: `src/analysis-service.ts`
- Verify: `analysis-skills/project-alpha.md`
- Verify: `README.md`
- Verify: related tests

- [ ] **Step 1: Run all focused tests**

Run:

```bash
npm test -- tests/project-backing-provider.test.ts tests/grok.test.ts tests/analysis-skill.test.ts tests/analysis-service.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Inspect Git status and recent commits**

Run:

```bash
git status -sb
git log --oneline -8
```

Expected: working tree clean, recent commits include:

```text
feat: 新增项目背书账号查询
feat: 注入项目背书账号证据
feat: 增加项目背景背书分析章节
feat: 串联项目背书账号分析
docs: 说明项目背书账号分析
```

---

## Self-Review Notes

- Spec coverage: Task 1 covers 6551 `twitter_kol_followers`, candidate normalization, warnings, empty results, and 30-candidate cap. Task 2 covers prompt evidence injection and Grok-only final selection. Task 3 covers the new 8-section analysis shape and prioritization rules. Task 4 wires the provider into first-time analysis while preserving duplicate reminder behavior. Task 5 documents runtime behavior and env reuse. Task 6 covers final verification.
- Type consistency: `ProjectBackingEvidence`, `ProjectBackingCandidate`, `collectProjectBackingEvidence`, `projectBacking`, and `getProjectBacking` names match across provider, prompt, service, and tests.
- Scope check: This plan does not change account classification, main push thresholds, Telegram export, Rug collection, or xAI client behavior.
