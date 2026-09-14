import { describe, expect, it } from 'vitest';
import {
  calculateDisplayPushCount,
  decide,
  decideBeforeClassification,
  markSendFailed,
  type DecisionContext,
  type DecisionOutcome,
  type ParsedAlphaEvent,
  type PreClassificationResult,
  type ProjectSnapshot
} from '../src/domain/decision-rules.js';

const STAR_LEVELS = [3, 8, 13, 18, 23];

/** 断言同步判定给出结论，并返回该结论。 */
function expectSkip(result: PreClassificationResult): DecisionOutcome {
  if (result.kind !== 'skip') {
    throw new Error(`期望同步判定直接给出结论，实际是 ${result.kind}`);
  }
  return result.outcome;
}

function parsed(overrides: Partial<ParsedAlphaEvent> = {}): ParsedAlphaEvent {
  return {
    channel: 'follow',
    title: 'Someone 关注了 Project',
    link: 'https://x.com/project',
    content: '你关注的 5 个用户也关注了ta',
    upstreamPushAtSec: 1_789_283_635,
    commonFollowCount: 5,
    legacyDedupeKey: 'follow|https://x.com/project|Someone 关注了 Project|1789283635',
    projectKey: 'project',
    displayName: 'Project',
    ...overrides
  };
}

function project(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return { projectId: 'p1', star: 0, displayPushCount: 0, exists: true, ...overrides };
}

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    eventId: 'e1',
    parsed: parsed(),
    project: project(),
    starLevels: STAR_LEVELS,
    isDuplicate: false,
    inFlight: false,
    configVersionId: 'cfg-1',
    decidedAt: '2026-09-14T00:00:00.000Z',
    ...overrides
  };
}

describe('同步判定分支', () => {
  it('未识别共同关注数 → COUNT_MISSING，不做任何后续动作', () => {
    const outcome = expectSkip(decideBeforeClassification(context({ parsed: parsed({ commonFollowCount: null }) })));
    expect(outcome.reasonCode).toBe('COUNT_MISSING');
    expect(outcome.shouldCreateAnalysisIntent).toBe(false);
  });

  it('未达门槛 → BELOW_THRESHOLD，星级为 0', () => {
    const outcome = expectSkip(decideBeforeClassification(context({ parsed: parsed({ commonFollowCount: 2 }) })));
    expect(outcome).toMatchObject({ reasonCode: 'BELOW_THRESHOLD', star: 0, count: 2 });
  });

  it('刚好达到第一档 → 继续走分类与推送', () => {
    expect(decideBeforeClassification(context({ parsed: parsed({ commonFollowCount: 3 }) })).kind).toBe('classify');
  });

  it('重复事件 → DEDUPE_REPEAT，且标记 isRepeat', () => {
    const outcome = expectSkip(decideBeforeClassification(context({ isDuplicate: true })));
    expect(outcome).toMatchObject({ reasonCode: 'DEDUPE_REPEAT', isRepeat: true, star: 1 });
  });

  it('并发在处理 → IN_FLIGHT', () => {
    const outcome = expectSkip(decideBeforeClassification(context({ inFlight: true })));
    expect(outcome).toMatchObject({ reasonCode: 'IN_FLIGHT', inFlight: true });
  });

  it('星级未升高 → STAR_NOT_INCREASED（与旧实现的跳过语义一致）', () => {
    const outcome = expectSkip(
      decideBeforeClassification(context({ project: project({ star: 2 }), parsed: parsed({ commonFollowCount: 8 }) }))
    );
    expect(outcome).toMatchObject({ reasonCode: 'STAR_NOT_INCREASED', star: 2, previousStar: 2 });
  });

  it('最高星不检查“星级未升高”，允许继续累加展示序号', () => {
    const outcome = decideBeforeClassification(
      context({ project: project({ star: 5, displayPushCount: 5 }), parsed: parsed({ commonFollowCount: 30 }) })
    );
    expect(outcome.kind).toBe('max_star');
  });

  it('首次达到最高星也允许继续', () => {
    const outcome = decideBeforeClassification(
      context({ project: project({ star: 4 }), parsed: parsed({ commonFollowCount: 23 }) })
    );
    expect(outcome.kind).toBe('max_star');
  });
});

describe('完整判定（含分类）', () => {
  it('未配置分类器时直接放行，原因码为 CLASSIFY_ALLOWED', async () => {
    const outcome = await decide(context());
    expect(outcome.reasonCode).toBe('CLASSIFY_ALLOWED');
    expect(outcome.classification).toBeNull();
    expect(outcome.displayPushCountAfter).toBe(1);
    expect(outcome.starAfter).toBe(1);
  });

  it('分类放行时记录 type/confidence/reason', async () => {
    const outcome = await decide(
      context({
        classify: async () => ({ allowPush: true, type: 'PROJECT', confidence: 0.82, reason: '项目方账号', model: 'grok-4.3', error: null })
      })
    );
    expect(outcome.reasonCode).toBe('CLASSIFY_ALLOWED');
    expect(outcome.classification).toMatchObject({ type: 'PROJECT', confidence: 0.82, reason: '项目方账号' });
  });

  it('分类拦截时不改星级、不占展示序号，并记录拦截原因', async () => {
    const outcome = await decide(
      context({
        // 关注数 5 对应 1 星，项目当前 0 星：判定会走到分类环节。
        project: project({ star: 0, displayPushCount: 0 }),
        classify: async () => ({ allowPush: false, type: 'KOL', confidence: 0.9, reason: '个人 KOL', model: 'grok-4.3', error: null })
      })
    );
    expect(outcome).toMatchObject({
      reasonCode: 'CLASSIFY_BLOCKED',
      displayPushCountAfter: null,
      starAfter: null,
      previousStar: 0,
      star: 1
    });
    expect(outcome.classification).toMatchObject({ type: 'KOL' });
  });

  it('分类异常时保守放行，且不得伪装成模型确认（type/confidence 为空）', async () => {
    const outcome = await decide(
      context({
        classify: async () => {
          throw new Error('classification timeout');
        }
      })
    );
    expect(outcome.reasonCode).toBe('CLASSIFY_ERROR_ALLOWED');
    expect(outcome.classification).toMatchObject({ type: null, confidence: null, error: 'classification timeout' });
    expect(outcome.displayPushCountAfter).toBe(1);
  });

  it('星级上升时才创建分析任务意图', async () => {
    // 关注数 5 → 1 星：首次（0→1）不算星级变化；项目已 1 星时判定会被“星级未升高”挡下。
    const firstTime = await decide(context({ project: project({ star: 0 }) }));
    // 关注数 30 → 5 星，项目已 2 星：这才是旧实现认定的“星级变化”。
    const increase = await decide(
      context({ project: project({ star: 2, displayPushCount: 2 }), parsed: parsed({ commonFollowCount: 30 }) })
    );
    const noIncrease = expectSkip(
      decideBeforeClassification(context({ project: project({ star: 2 }), parsed: parsed({ commonFollowCount: 8 }) }))
    );

    expect(firstTime.shouldCreateAnalysisIntent).toBe(false);
    expect(increase.shouldCreateAnalysisIntent).toBe(true);
    expect(noIncrease.shouldCreateAnalysisIntent).toBe(false);
  });

  it('首次达到最高星标记 isFirstMaxStar，供深度分析使用', async () => {
    const outcome = await decide(
      context({ project: project({ star: 4, displayPushCount: 4 }), parsed: parsed({ commonFollowCount: 23 }) })
    );
    expect(outcome).toMatchObject({ isFirstMaxStar: true, star: 5, displayPushCountAfter: 5 });
  });

  it('已在最高星时展示序号继续累加', async () => {
    const outcome = await decide(
      context({ project: project({ star: 5, displayPushCount: 7 }), parsed: parsed({ commonFollowCount: 30 }) })
    );
    expect(outcome).toMatchObject({ isFirstMaxStar: true, star: 5, displayPushCountAfter: 8 });
  });

  it('推送失败后原因码变为 SEND_FAILED，且不回写展示序号与星级', async () => {
    const outcome = await decide(context());
    const failed = markSendFailed(outcome);
    expect(failed).toMatchObject({
      reasonCode: 'SEND_FAILED',
      displayPushCountAfter: null,
      starAfter: null,
      shouldCreateAnalysisIntent: false
    });
  });
});

describe('展示序号计算与旧实现一致', () => {
  it('未到最高星时序号等于星级', () => {
    expect(calculateDisplayPushCount(0, 1, 5)).toBe(1);
    expect(calculateDisplayPushCount(4, 3, 5)).toBe(3);
  });

  it('达到最高星时在上一值上累加且不低于最高星', () => {
    expect(calculateDisplayPushCount(5, 5, 5)).toBe(6);
    expect(calculateDisplayPushCount(0, 5, 5)).toBe(5);
    expect(calculateDisplayPushCount(3, 5, 5)).toBe(5);
  });
});
