# Alpha Caller 账号筛出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Grok account classification treat personal Alpha caller / calls / signals / gem hunter / 100x / 喊单 / 带单 accounts as `KOL`, team core member personal accounts as `PERSONAL`, and core technical contributor personal accounts as `DEV`, so existing filtering blocks them.

**Architecture:** Reuse the existing account classification enum and filtering rules. Update only the classification prompt in `src/account-classifier.ts`, and guard the wording with focused tests in `tests/account-classifier.test.ts`.

**Tech Stack:** TypeScript, Vitest, existing Grok account classifier.

---

## File Structure

- `src/account-classifier.ts`: Owns account classification prompt construction, response parsing, and allow/block decision. This change only updates `buildAccountClassificationPrompt()`.
- `tests/account-classifier.test.ts`: Owns prompt, parser, and allow/block tests. Add prompt assertions for Alpha caller, team core member, and technical contributor wording, and keep existing `KOL` / `PERSONAL` / `DEV` blocking coverage.

No new classification type, local keyword prefilter, service flow change, environment variable, queue, or Telegram behavior is needed.

### Task 1: Add Prompt Coverage for Alpha Caller Classification

**Files:**
- Modify: `tests/account-classifier.test.ts`

- [ ] **Step 1: Extend the existing prompt test**

In `tests/account-classifier.test.ts`, inside `it('builds a prompt that asks for strict JSON classification', () => { ... })`, add these assertions after the existing meme/speculator assertions:

```ts
    expect(prompt).toContain('alpha caller');
    expect(prompt).toContain('alpha calls');
    expect(prompt).toContain('signals');
    expect(prompt).toContain('gem hunter');
    expect(prompt).toContain('100x');
    expect(prompt).toContain('喊单');
    expect(prompt).toContain('带单');
    expect(prompt).toContain('归为 KOL');
    expect(prompt).toContain('Alpha 工具');
    expect(prompt).toContain('数据平台');
    expect(prompt).toContain('不应因为出现 alpha 一词就归为 KOL');
    expect(prompt).toContain('founder');
    expect(prompt).toContain('co-founder');
    expect(prompt).toContain('core team');
    expect(prompt).toContain('team member');
    expect(prompt).toContain('core contributor');
    expect(prompt).toContain('community lead');
    expect(prompt).toContain('核心成员');
    expect(prompt).toContain('归为 PERSONAL');
    expect(prompt).toContain('core developer');
    expect(prompt).toContain('technical contributor');
    expect(prompt).toContain('技术贡献者');
    expect(prompt).toContain('归为 DEV');
    expect(prompt).toContain('不应仅凭这些词归为 PERSONAL 或 DEV');
```

- [ ] **Step 2: Add a focused allow/block guard**

After the existing `it('blocks KOL, personal, media, and dev classifications', ...)` test, add this test:

```ts
  it('continues to block alpha caller accounts once classified as KOL', () => {
    expect(shouldAllowClassifiedAccount({
      type: 'KOL',
      confidence: 0.92,
      reason: '个人 alpha caller / signals 喊单账号'
    })).toBe(false);
  });

  it('continues to block team core member accounts once classified as PERSONAL', () => {
    expect(shouldAllowClassifiedAccount({
      type: 'PERSONAL',
      confidence: 0.91,
      reason: '项目 founder / core team 成员个人账号'
    })).toBe(false);
  });

  it('continues to block core technical contributor accounts once classified as DEV', () => {
    expect(shouldAllowClassifiedAccount({
      type: 'DEV',
      confidence: 0.9,
      reason: 'core developer / technical contributor 个人账号'
    })).toBe(false);
  });
```

- [ ] **Step 3: Run the focused test and verify failure**

Run:

```bash
npm test -- tests/account-classifier.test.ts
```

Expected: FAIL because the prompt does not yet include the new Alpha caller, team core member, technical contributor, and false-positive boundary wording.

### Task 2: Update Account Classification Prompt

**Files:**
- Modify: `src/account-classifier.ts`
- Test: `tests/account-classifier.test.ts`

- [ ] **Step 1: Update the `KOL` type description**

In `src/account-classifier.ts`, inside `buildAccountClassificationPrompt()`, replace the existing KOL type description:

```ts
    '- KOL：个人影响力账号、交易员、研究员、博主、资讯号主、Meme Degen、memer、speculator 等个人投机/喊单身份账号',
```

with:

```ts
    '- KOL：个人影响力账号、交易员、研究员、博主、资讯号主、Meme Degen、memer、speculator、alpha caller、alpha calls、signals、gem hunter、degen calls、100x、moonshot calls、喊单、带单、土狗推荐等个人投机/喊单身份账号',
```

- [ ] **Step 2: Update the `PERSONAL` type description**

In `src/account-classifier.ts`, inside `buildAccountClassificationPrompt()`, replace the existing PERSONAL type description:

```ts
    '- PERSONAL：普通个人账号、创始人个人号、团队成员个人号',
```

with:

```ts
    '- PERSONAL：普通个人账号、创始人个人号、团队成员个人号、founder、co-founder、CEO、CTO、core team、team member、core contributor、BD、community lead、核心成员、团队成员、创始人、联创、负责人等团队核心成员个人账号',
```

- [ ] **Step 3: Update the `DEV` type description**

In `src/account-classifier.ts`, inside `buildAccountClassificationPrompt()`, replace the existing DEV type description:

```ts
    '- DEV：个人开发者、工程师、dev、builder、独立开发者、技术贡献者、开源作者等个人身份账号',
```

with:

```ts
    '- DEV：个人开发者、工程师、dev、builder、core developer、developer、engineer、technical contributor、独立开发者、技术贡献者、开源作者等个人技术身份账号',
```

- [ ] **Step 4: Update the personal caller blocking principle**

In the `判断原则` section, replace:

```ts
    '- Meme Degen、memer、speculator、trader 等如果明显是个人投机、喊单、刷屏、博主身份，应归为 KOL',
```

with:

```ts
    '- Meme Degen、memer、speculator、trader、alpha caller、alpha calls、signals、gem hunter、degen calls、100x、moonshot calls、喊单、带单、土狗推荐等如果明显是个人投机、喊单、刷屏、博主或频道主身份，应归为 KOL',
```

- [ ] **Step 5: Add the Alpha project/tool false-positive boundary**

In the `判断原则` section, add this line immediately after the personal caller blocking principle from Step 2:

```ts
    '- Alpha 工具、Alpha 数据平台、项目发现产品、研究平台、协议、官方社区或产品账号，即使文案包含 alpha，也不应因为出现 alpha 一词就归为 KOL；这类账号仍可归为 PROJECT 或 ALPHA',
```

- [ ] **Step 6: Add team core member and technical contributor principles**

In the `判断原则` section, add these lines immediately after the Alpha project/tool false-positive boundary from Step 5:

```ts
    '- founder、co-founder、CEO、CTO、core team、team member、core contributor、BD、community lead、核心成员、团队成员、创始人、联创、负责人等如果描述的是个人身份账号，应归为 PERSONAL',
    '- core developer、developer、engineer、builder、technical contributor、开发者、工程师、技术贡献者等如果描述的是个人技术贡献者账号，应归为 DEV',
    '- 项目、协议、产品、平台、官方社区、生态官方号或团队官方号，即使简介里出现 team、core、dev、developer、builder 等词，也不应仅凭这些词归为 PERSONAL 或 DEV；这类账号仍可归为 PROJECT 或 ALPHA',
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm test -- tests/account-classifier.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit the prompt change**

Run:

```bash
git add src/account-classifier.ts tests/account-classifier.test.ts docs/superpowers/specs/2026-05-21-alpha-caller-filter-design.md docs/superpowers/plans/2026-05-21-alpha-caller-filter.md
git commit -m "fix: 筛出Alpha caller和团队成员账号"
```

### Task 3: Final Verification

**Files:**
- Verify: `src/account-classifier.ts`
- Verify: `tests/account-classifier.test.ts`

- [ ] **Step 1: Run focused classifier tests**

Run:

```bash
npm test -- tests/account-classifier.test.ts
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

- [ ] **Step 4: Check git state**

Run:

```bash
git status --short
```

Expected: no unstaged or uncommitted files.

## Self-Review

- Spec coverage: The plan covers personal Alpha caller wording, team core member personal accounts, core technical contributor personal accounts, `KOL` / `PERSONAL` / `DEV` classification, false-positive boundaries for Alpha tools/platforms/projects and official team/product accounts, no new type, no local keyword hard block, no service flow changes, and existing blocking behavior.
- Placeholder scan: The plan has concrete file paths, exact code snippets, exact commands, expected outcomes, and a standard Chinese `fix:` commit message.
- Type consistency: The plan uses existing `buildAccountClassificationPrompt()` and `shouldAllowClassifiedAccount()` names and existing `KOL` / `PERSONAL` / `DEV` types without adding new classification types.
