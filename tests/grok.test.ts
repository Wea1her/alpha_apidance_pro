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
});
