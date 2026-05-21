# CA/合约相关删帖风险提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When 6551 returns CA/contract-related deleted tweet samples for a pushed X account, make the Grok prompt explicitly require the analysis to say “发现 CA/合约相关删帖” while keeping the conclusion neutral.

**Architecture:** Reuse the existing `RugHistoryEvidence.contractDeletedTweetSamples` array. Add explicit CA/contract deleted-tweet status lines in `src/grok.ts`, keep 6551 collection unchanged, and lightly align the default analysis skill text so the model instructions are consistent.

**Tech Stack:** TypeScript, Vitest, existing 6551 Rug evidence provider, existing Grok prompt builder.

---

## File Structure

- `src/grok.ts`: Owns Grok prompt construction. Add a small helper that turns `contractDeletedTweetSamples` into explicit status and instruction lines.
- `tests/grok.test.ts`: Covers prompt behavior for both found and not-found CA/contract deleted-tweet states.
- `src/analysis-skill.ts`: Owns default output instructions for Grok. Align the Rug section wording with the explicit CA/contract deleted-tweet requirement.
- `tests/analysis-skill.test.ts`: Guards the default skill text so future edits do not drop the CA/contract deleted-tweet requirement.

No new API clients, queues, environment variables, Telegram behavior, or data model fields are needed.

### Task 1: Add Failing Prompt Tests

**Files:**
- Modify: `tests/grok.test.ts`

- [ ] **Step 1: Add tests for CA/contract deleted-tweet prompt behavior**

Insert these two test cases inside `describe('buildGrokPrompt', () => { ... })`, after the existing `includes rug history evidence when provided` test:

```ts
  it('marks contract-related deleted tweets as an explicit CA risk signal', () => {
    const prompt = buildGrokPrompt({
      title: 'A 关注了 B',
      content: '用户简介: builder',
      link: 'https://x.com/b',
      count: 12,
      star: 3,
      rugHistory: {
        source: '6551',
        available: true,
        deletedTweetCount: 1,
        negativeMentionCount: 0,
        recentTweetCount: 5,
        commentNegativeCount: 0,
        checkedTweetCount: 3,
        negativeNoiseCount: 0,
        deletedTweetSamples: ['CA: 0x1234567890abcdef1234567890abcdef12345678'],
        contractDeletedTweetSamples: ['CA: 0x1234567890abcdef1234567890abcdef12345678'],
        negativeMentionSamples: [],
        commentNegativeSamples: [],
        negativeNoiseSamples: [],
        recentRiskSignals: [],
        warnings: []
      }
    });

    expect(prompt).toContain('CA/合约相关删帖：发现');
    expect(prompt).toContain(
      '要求：第 7 节必须明确写“发现 CA/合约相关删帖”，并引用合约相关删帖原文；但不得仅凭这一点直接判定跑路，需结合删帖数量、负面提及、评论区样本和其他证据判断。'
    );
    expect(prompt).toContain('合约相关删帖原文：');
    expect(prompt).toContain('CA: 0x1234567890abcdef1234567890abcdef12345678');
  });

  it('marks missing contract-related deleted tweets as not found without forcing finding wording', () => {
    const prompt = buildGrokPrompt({
      title: 'A 关注了 B',
      content: '用户简介: builder',
      link: 'https://x.com/b',
      count: 12,
      star: 3,
      rugHistory: {
        source: '6551',
        available: true,
        deletedTweetCount: 0,
        negativeMentionCount: 0,
        recentTweetCount: 5,
        commentNegativeCount: 0,
        checkedTweetCount: 3,
        negativeNoiseCount: 0,
        deletedTweetSamples: [],
        contractDeletedTweetSamples: [],
        negativeMentionSamples: [],
        commentNegativeSamples: [],
        negativeNoiseSamples: [],
        recentRiskSignals: [],
        warnings: []
      }
    });

    expect(prompt).toContain('CA/合约相关删帖：未发现');
    expect(prompt).not.toContain('第 7 节必须明确写“发现 CA/合约相关删帖”');
  });
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -- tests/grok.test.ts
```

Expected: FAIL because `CA/合约相关删帖：发现` and `CA/合约相关删帖：未发现` are not emitted yet.

### Task 2: Implement Structured CA/Contract Deleted-Tweet Prompt Lines

**Files:**
- Modify: `src/grok.ts`
- Test: `tests/grok.test.ts`

- [ ] **Step 1: Add a helper in `src/grok.ts`**

Insert this helper after `function count(...)`:

```ts
function formatContractDeletedTweetSignal(evidence: RugHistoryEvidence): string[] {
  if (evidence.contractDeletedTweetSamples.length === 0) {
    return ['CA/合约相关删帖：未发现'];
  }

  return [
    'CA/合约相关删帖：发现',
    '要求：第 7 节必须明确写“发现 CA/合约相关删帖”，并引用合约相关删帖原文；但不得仅凭这一点直接判定跑路，需结合删帖数量、负面提及、评论区样本和其他证据判断。'
  ];
}
```

- [ ] **Step 2: Include the helper output in Rug history formatting**

In `formatRugHistory()`, add the helper spread after the warnings section and before `合约相关删帖原文：`:

```ts
    '数据警告：',
    formatList(evidence.warnings),
    ...formatContractDeletedTweetSignal(evidence),
    '合约相关删帖原文：',
    formatList(evidence.contractDeletedTweetSamples)
```

The full tail of the returned array should look like this:

```ts
    '近期风险信号：',
    formatList(evidence.recentRiskSignals),
    '数据警告：',
    formatList(evidence.warnings),
    ...formatContractDeletedTweetSignal(evidence),
    '合约相关删帖原文：',
    formatList(evidence.contractDeletedTweetSamples)
```

- [ ] **Step 3: Run the focused Grok tests**

Run:

```bash
npm test -- tests/grok.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit the prompt behavior change**

Run:

```bash
git add src/grok.ts tests/grok.test.ts
git commit -m "fix: 强化CA删帖风险提示"
```

### Task 3: Align Default Analysis Skill Wording

**Files:**
- Modify: `src/analysis-skill.ts`
- Modify: `tests/analysis-skill.test.ts`

- [ ] **Step 1: Add default skill assertions**

In `tests/analysis-skill.test.ts`, inside `it('keeps the default skill aligned with the asymmetric trading analysis rules', () => { ... })`, add these assertions near the existing Rug-related checks:

```ts
    expect(DEFAULT_ANALYSIS_SKILL).toContain('发现 CA/合约相关删帖');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不能只凭这一点直接判定跑路');
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -- tests/analysis-skill.test.ts
```

Expected: FAIL because the default skill does not yet contain both new phrases.

- [ ] **Step 3: Update the risk principle wording**

In `src/analysis-skill.ts`, replace this sentence fragment in the “风险必须具体” bullet:

```text
如果存在“合约相关删帖原文”，必须在第 7 节最后单独引用这些原文并说明风险含义。
```

with:

```text
如果存在“合约相关删帖原文”，必须在第 7 节明确写“发现 CA/合约相关删帖”，在本节最后单独引用这些原文并说明风险含义，但不能只凭这一点直接判定跑路。
```

- [ ] **Step 4: Update the seventh dimension wording**

In `src/analysis-skill.ts`, replace this sentence fragment in `7. Rug 历史/风险`:

```text
如果有合约相关删帖原文，必须把原文放在本节最后。
```

with:

```text
如果有合约相关删帖原文，必须明确写“发现 CA/合约相关删帖”，并把原文放在本节最后；不能只凭这一点直接判定跑路。
```

- [ ] **Step 5: Run the focused analysis skill test**

Run:

```bash
npm test -- tests/analysis-skill.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the default skill wording change**

Run:

```bash
git add src/analysis-skill.ts tests/analysis-skill.test.ts
git commit -m "fix: 对齐CA删帖分析约束"
```

### Task 4: Final Verification

**Files:**
- Verify: `src/grok.ts`
- Verify: `src/analysis-skill.ts`
- Verify: `tests/grok.test.ts`
- Verify: `tests/analysis-skill.test.ts`

- [ ] **Step 1: Run focused tests together**

Run:

```bash
npm test -- tests/grok.test.ts tests/analysis-skill.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the full test suite**

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

- Spec coverage: The plan covers explicit prompt state, neutral conclusion wording, no changes to main push flow, no discussion-group extra alert, no 6551 data model change, and no ordinary historical tweet CA search.
- Placeholder scan: The plan contains concrete file paths, code snippets, commands, expected outcomes, and commit messages.
- Type consistency: The plan only uses existing `RugHistoryEvidence.contractDeletedTweetSamples` and existing `buildGrokPrompt()` tests.
