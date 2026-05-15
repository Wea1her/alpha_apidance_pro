import { describe, expect, it } from 'vitest';
import { shouldTriggerGrokAnalysis, buildGrokPrompt } from '../src/grok.js';

describe('shouldTriggerGrokAnalysis', () => {
  it('only triggers on 3-star and above', () => {
    expect(shouldTriggerGrokAnalysis(0)).toBe(false);
    expect(shouldTriggerGrokAnalysis(2)).toBe(false);
    expect(shouldTriggerGrokAnalysis(3)).toBe(true);
    expect(shouldTriggerGrokAnalysis(5)).toBe(true);
  });
});

describe('buildGrokPrompt', () => {
  it('includes core event context for analysis', () => {
    const prompt = buildGrokPrompt({
      title: 'A 关注了 B',
      content: '用户简介: builder',
      link: 'https://x.com/b',
      count: 12,
      star: 3
    });

    expect(prompt).toContain('A 关注了 B');
    expect(prompt).toContain('https://x.com/b');
    expect(prompt).toContain('监控池关注数：12');
    expect(prompt).toContain('重要程度：3 星');
    expect(prompt).toContain('项目核心信息');
    expect(prompt).toContain('当前进展');
    expect(prompt).toContain('优点');
    expect(prompt).toContain('缺点');
    expect(prompt).toContain('关注理由');
    expect(prompt).toContain('标签');
  });

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
        commentNegativeCount: 2,
        checkedTweetCount: 3,
        deletedTweetSamples: ['old mint failed'],
        negativeMentionSamples: ['@b rug?'],
        commentNegativeSamples: ['quote rug warning', '@b 无法提现'],
        recentRiskSignals: ['近期多次提到 mint'],
        warnings: []
      }
    });

    expect(prompt).toContain('Rug 历史/风险');
    expect(prompt).toContain('删帖数量：2');
    expect(prompt).toContain('检查推文数量：3');
    expect(prompt).toContain('评论区负面数量：2');
    expect(prompt).toContain('@b rug?');
    expect(prompt).toContain('quote rug warning');
    expect(prompt).toContain('近期多次提到 mint');
    expect(prompt).not.toContain('source');
    expect(prompt).not.toContain('数据源');
  });

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
});
