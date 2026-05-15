# 分析 Skill 模板化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Grok 项目分析的维度和输出要求从 `src/grok.ts` 的硬编码迁移到项目内中文 Markdown skill 文件。

**Architecture:** 新增运行时目录 `analysis-skills/`，默认 skill 为 `project-alpha.md`。新增 `src/analysis-skill.ts` 负责加载 skill 文本，`src/grok.ts` 继续拼接事件上下文和 Rug 证据，但分析维度、输出规则来自 skill 文档。为了保持服务稳定，读取失败时回退到内置默认 skill。

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest, Markdown prompt template。

---

## 文件结构

- Create `analysis-skills/project-alpha.md`：默认项目/Alpha 账号分析 skill。
- Create `src/analysis-skill.ts`：加载 skill 文件，提供默认 skill 回退。
- Create `tests/analysis-skill.test.ts`：覆盖读取默认 skill、读取自定义目录、缺失文件回退。
- Modify `src/grok.ts`：`buildGrokPrompt()` 接收可选 `analysisSkill` 文本，并把 skill 文本放入 prompt。
- Modify `tests/grok.test.ts`：验证 prompt 使用 skill 文本，不再硬编码分析维度。
- Modify `src/analysis-service.ts`：调用 Grok 前加载默认 skill。
- Modify `tests/analysis-service.test.ts`：验证分析服务把 skill 内容传入 prompt。
- Modify `README.md`：说明如何修改 `analysis-skills/project-alpha.md` 自定义分析格式。

---

### Task 1: 新增 Analysis Skill 加载器

**Files:**
- Create: `analysis-skills/project-alpha.md`
- Create: `src/analysis-skill.ts`
- Create: `tests/analysis-skill.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/analysis-skill.test.ts` 新增：

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadAnalysisSkill, DEFAULT_ANALYSIS_SKILL } from '../src/analysis-skill.js';

describe('loadAnalysisSkill', () => {
  it('loads a skill by name from a custom directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analysis-skill-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'custom.md'), '# 自定义分析 Skill\n\n只输出测试维度。', 'utf8');

    await expect(loadAnalysisSkill({ name: 'custom', directory: dir })).resolves.toContain('只输出测试维度');
  });

  it('falls back to the default skill when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analysis-skill-'));

    await expect(loadAnalysisSkill({ name: 'missing', directory: dir })).resolves.toBe(DEFAULT_ANALYSIS_SKILL);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/analysis-skill.test.ts`

Expected: FAIL，因为 `src/analysis-skill.ts` 还不存在。

- [ ] **Step 3: 实现默认 skill 文件**

创建 `analysis-skills/project-alpha.md`：

```md
# 项目/Alpha 账号分析 Skill

## 目标
判断该 X 账号是否值得作为打新、空投、链上热点跟踪目标。

## 分析维度
1. 项目核心信息：概括这个账号/项目的核心定位、产品或叙事。
2. 当前进展：概括目前可见的阶段、动作、热度或生态进展。
3. 优点：从增长、产品、叙事、资源、传播性等角度提炼 1-2 点。
4. 缺点：从真实性、落地性、可持续性、估值泡沫、信息不足等角度提炼 1-2 点。
5. 关注理由：说明为什么值得关注或不值得关注，结论要明确。
6. 标签：给出 2-4 个中文短标签，用顿号分隔。
7. Rug 历史/风险：基于删帖记录和社区评论判断是否存在跑路、骗局、严重负面历史；没有证据时明确写“暂无直接证据”。

## 输出要求
- 严格按分析维度输出 7 行，每一行都必须有内容。
- 不要写前言，不要写总结。
- 全部使用中文。
- 风格专业、克制、信息密度高。
- 每行尽量控制在 30-50 字。
- 不要输出 Source、来源、参考来源、数据来源或引用列表。
```

- [ ] **Step 4: 实现加载器**

创建 `src/analysis-skill.ts`：

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_ANALYSIS_SKILL = `# 项目/Alpha 账号分析 Skill

## 目标
判断该 X 账号是否值得作为打新、空投、链上热点跟踪目标。

## 分析维度
1. 项目核心信息：概括这个账号/项目的核心定位、产品或叙事。
2. 当前进展：概括目前可见的阶段、动作、热度或生态进展。
3. 优点：从增长、产品、叙事、资源、传播性等角度提炼 1-2 点。
4. 缺点：从真实性、落地性、可持续性、估值泡沫、信息不足等角度提炼 1-2 点。
5. 关注理由：说明为什么值得关注或不值得关注，结论要明确。
6. 标签：给出 2-4 个中文短标签，用顿号分隔。
7. Rug 历史/风险：基于删帖记录和社区评论判断是否存在跑路、骗局、严重负面历史；没有证据时明确写“暂无直接证据”。

## 输出要求
- 严格按分析维度输出 7 行，每一行都必须有内容。
- 不要写前言，不要写总结。
- 全部使用中文。
- 风格专业、克制、信息密度高。
- 每行尽量控制在 30-50 字。
- 不要输出 Source、来源、参考来源、数据来源或引用列表。`;

export interface LoadAnalysisSkillOptions {
  name?: string;
  directory?: string;
}

export async function loadAnalysisSkill(options: LoadAnalysisSkillOptions = {}): Promise<string> {
  const name = options.name ?? 'project-alpha';
  const directory = options.directory ?? join(process.cwd(), 'analysis-skills');
  try {
    const content = await readFile(join(directory, `${name}.md`), 'utf8');
    return content.trim();
  } catch {
    return DEFAULT_ANALYSIS_SKILL;
  }
}
```

- [ ] **Step 5: 验证测试通过**

Run: `npm test -- tests/analysis-skill.test.ts`

Expected: PASS。

---

### Task 2: Grok Prompt 使用 Skill 文本

**Files:**
- Modify: `src/grok.ts`
- Modify: `tests/grok.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/grok.test.ts` 新增：

```ts
it('uses analysis skill text for output instructions', () => {
  const prompt = buildGrokPrompt({
    title: 'A 关注了 B',
    content: '用户简介: builder',
    link: 'https://x.com/b',
    count: 12,
    star: 3,
    analysisSkill: '# 自定义 Skill\n\n只输出：项目判断、风险等级。'
  });

  expect(prompt).toContain('# 自定义 Skill');
  expect(prompt).toContain('只输出：项目判断、风险等级');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/grok.test.ts`

Expected: FAIL，因为 `GrokAnalysisInput` 还没有 `analysisSkill` 字段。

- [ ] **Step 3: 修改 `src/grok.ts`**

给 `GrokAnalysisInput` 增加：

```ts
analysisSkill?: string;
```

把原来的硬编码 7 行指令替换为：

```ts
'分析 Skill：',
input.analysisSkill ?? DEFAULT_ANALYSIS_SKILL,
```

并从 `analysis-skill.ts` import `DEFAULT_ANALYSIS_SKILL`。

- [ ] **Step 4: 验证 Grok 测试通过**

Run: `npm test -- tests/grok.test.ts`

Expected: PASS。

---

### Task 3: 分析服务加载默认 Skill

**Files:**
- Modify: `src/analysis-service.ts`
- Modify: `tests/analysis-service.test.ts`
- Modify: `README.md`

- [ ] **Step 1: 写失败测试**

在 `tests/analysis-service.test.ts` 首次分析测试中传入：

```ts
loadSkill: vi.fn().mockResolvedValue('# 测试 Skill\n\n只输出测试分析。')
```

并断言：

```ts
expect(analyze.mock.calls[0][0]).toContain('# 测试 Skill');
expect(loadSkill).toHaveBeenCalledOnce();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/analysis-service.test.ts`

Expected: FAIL，因为 `TriggerAnalysisOptions` 还没有 `loadSkill`。

- [ ] **Step 3: 修改服务**

在 `src/analysis-service.ts` import：

```ts
import { loadAnalysisSkill } from './analysis-skill.js';
```

给 `TriggerAnalysisOptions` 增加：

```ts
loadSkill?: () => Promise<string>;
```

构建 prompt 前新增：

```ts
const analysisSkill = await (options.loadSkill ?? loadAnalysisSkill)();
```

调用 `buildGrokPrompt()` 时传入：

```ts
analysisSkill
```

- [ ] **Step 4: 更新 README**

在“账号分析”小节新增：

```md
分析格式由 `analysis-skills/project-alpha.md` 控制。修改这个中文 Markdown 文件后，重启服务即可生效。
```

- [ ] **Step 5: 全量验证**

Run:

```bash
npm test
npm run typecheck
git status --short
```

Expected:
- 测试通过。
- 类型检查通过。
- 只包含本计划相关文件变更。

- [ ] **Step 6: 提交**

Run:

```bash
git add analysis-skills/project-alpha.md src/analysis-skill.ts src/grok.ts src/analysis-service.ts tests/analysis-skill.test.ts tests/grok.test.ts tests/analysis-service.test.ts README.md docs/superpowers/plans/2026-05-15-analysis-skill-template.md
git commit -m "feat: 新增 Grok 分析 Skill 模板"
```

Expected: commit succeeds。

---

## 自审

- 覆盖用户目标：Grok 分析按 skill 文档控制。
- 覆盖可维护性：后续改分析维度只需改中文 Markdown 并重启服务。
- 覆盖稳定性：skill 文件读取失败时回退默认模板。
- 覆盖测试：加载器、prompt 拼接、服务集成均有测试。
