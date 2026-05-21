# Alpha Caller 账号筛出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Grok account classification treat personal Alpha caller / calls / signals / gem hunter / 100x / 喊单 / 带单 accounts as `KOL`, so existing KOL filtering blocks them.

**Architecture:** Reuse the existing account classification enum and filtering rules. Update only the classification prompt in `src/account-classifier.ts`, and guard the wording with focused tests in `tests/account-classifier.test.ts`.

**Tech Stack:** TypeScript, Vitest, existing Grok account classifier.

---

## File Structure

- `src/account-classifier.ts`: Owns account classification prompt construction, response parsing, and allow/block decision. This change only updates `buildAccountClassificationPrompt()`.
- `tests/account-classifier.test.ts`: Owns prompt, parser, and allow/block tests. Add prompt assertions for Alpha caller wording and keep existing KOL blocking coverage.

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
```

- [ ] **Step 3: Run the focused test and verify failure**

Run:

```bash
npm test -- tests/account-classifier.test.ts
```

Expected: FAIL because the prompt does not yet include the new Alpha caller and false-positive boundary wording.

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

- [ ] **Step 2: Update the personal caller blocking principle**

In the `判断原则` section, replace:

```ts
    '- Meme Degen、memer、speculator、trader 等如果明显是个人投机、喊单、刷屏、博主身份，应归为 KOL',
```

with:

```ts
    '- Meme Degen、memer、speculator、trader、alpha caller、alpha calls、signals、gem hunter、degen calls、100x、moonshot calls、喊单、带单、土狗推荐等如果明显是个人投机、喊单、刷屏、博主或频道主身份，应归为 KOL',
```

- [ ] **Step 3: Add the Alpha project/tool false-positive boundary**

In the `判断原则` section, add this line immediately after the personal caller blocking principle from Step 2:

```ts
    '- Alpha 工具、Alpha 数据平台、项目发现产品、研究平台、协议、官方社区或产品账号，即使文案包含 alpha，也不应因为出现 alpha 一词就归为 KOL；这类账号仍可归为 PROJECT 或 ALPHA',
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- tests/account-classifier.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the prompt change**

Run:

```bash
git add src/account-classifier.ts tests/account-classifier.test.ts
git commit -m "fix: 筛出Alpha caller账号"
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

- Spec coverage: The plan covers personal Alpha caller wording, KOL classification, false-positive boundary for Alpha tools/platforms/projects, no new type, no local keyword hard block, no service flow changes, and existing KOL blocking behavior.
- Placeholder scan: The plan has concrete file paths, exact code snippets, exact commands, expected outcomes, and a standard Chinese `fix:` commit message.
- Type consistency: The plan uses existing `buildAccountClassificationPrompt()` and `shouldAllowClassifiedAccount()` names and does not add new classification types.
