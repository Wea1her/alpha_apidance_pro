import { describe, expect, it } from 'vitest';
import { shouldTriggerGrokAnalysis, buildGrokPrompt, buildDeepAnalysisPrompt } from '../src/grok.js';

const baseInput = {
  title: 'A 关注了 B',
  content: '用户简介: builder',
  link: 'https://x.com/b',
  count: 12,
  star: 3
};

describe('shouldTriggerGrokAnalysis', () => {
  it('only triggers on 3-star and above', () => {
    expect(shouldTriggerGrokAnalysis(0)).toBe(false);
    expect(shouldTriggerGrokAnalysis(2)).toBe(false);
    expect(shouldTriggerGrokAnalysis(3)).toBe(true);
    expect(shouldTriggerGrokAnalysis(5)).toBe(true);
  });
});

describe('buildDeepAnalysisPrompt', () => {
  it('adds prior standard context to an independent six-section research report', () => {
    const prompt = buildDeepAnalysisPrompt({
      ...baseInput, star: 5, searchTools: ['web_search'], previousAnalysisText: '此前标准判断'
    });
    expect(prompt).toContain('@b');
    expect(prompt).toContain('5 星');
    expect(prompt).toContain('此前标准判断');
    expect(prompt).toContain('不要原样复述');
    expect(prompt).toContain('1. 项目定位与玩法');
    expect(prompt).toContain('6. 结论');
    expect(prompt).toContain('裸链接');
    expect(prompt).not.toContain('7. 标签');
  });

  it.each([[], ['web_search'], ['x_search'], ['web_search', 'x_search']].map((searchTools) => ({ searchTools })))('describes only the configured tools: $searchTools', ({ searchTools }) => {
    const prompt = buildDeepAnalysisPrompt({ ...baseInput, searchTools });
    if (searchTools.length === 0) {
      expect(prompt).toContain('本次未启用联网检索');
      expect(prompt).not.toContain('可用工具：');
    } else {
      expect(prompt).toContain(`可用工具：${searchTools.join('、')}`);
    }
    expect(prompt.includes('当前只启用了 web_search')).toBe(searchTools.length === 1 && searchTools[0] === 'web_search');
  });

  it('accepts a custom deep skill without requiring a previous report', () => {
    const prompt = buildDeepAnalysisPrompt({ ...baseInput, analysisSkill: '# 独立深度模板' });
    expect(prompt).toContain('# 独立深度模板');
    expect(prompt).not.toContain('此前标准分析的结论');
    expect(prompt).not.toContain('undefined');
  });
});

describe('buildGrokPrompt', () => {
  it('includes core event context for analysis', () => {
    const prompt = buildGrokPrompt(baseInput);

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
    expect(prompt).not.toContain('6551');
    expect(prompt).not.toContain('Rug 历史');
  });

  it('asks Grok to use the enabled search tools before writing project backing', () => {
    const prompt = buildGrokPrompt({ ...baseInput, searchTools: ['web_search', 'x_search'] });

    expect(prompt).toContain('检索要求：');
    expect(prompt).toContain('可用工具：web_search、x_search');
    expect(prompt).toContain('用 x_search 检索该账号在 X 上被哪些知名项目方');
    expect(prompt).toContain('用 web_search 检索官网、融资、合作、媒体报道');
    expect(prompt).toContain('未检索到知名 Crypto 背书账号');
    expect(prompt).not.toContain('未启用联网检索');
    expect(prompt.indexOf('检索要求：')).toBeGreaterThan(prompt.indexOf('已知信息：'));
    expect(prompt.indexOf('检索要求：')).toBeLessThan(prompt.indexOf('分析 Skill：'));
  });

  it('only describes the tools that are actually enabled', () => {
    const prompt = buildGrokPrompt({ ...baseInput, searchTools: ['x_search'] });

    expect(prompt).toContain('可用工具：x_search。');
    expect(prompt).toContain('用 x_search 检索');
    expect(prompt).not.toContain('用 web_search 检索');
  });

  it('explains that search is disabled when no search tools are enabled', () => {
    const prompt = buildGrokPrompt({ ...baseInput, searchTools: [] });

    expect(prompt).toContain('检索说明：');
    expect(prompt).toContain('本次未启用联网检索');
    expect(prompt).toContain('无法确认知名 Crypto 背书账号');
    expect(prompt).not.toContain('检索要求：');
    expect(buildGrokPrompt(baseInput)).toContain('本次未启用联网检索');
  });

  it('uses analysis skill text for output instructions', () => {
    const prompt = buildGrokPrompt({
      ...baseInput,
      analysisSkill: '# 自定义 Skill\n\n只输出：项目判断、风险等级。'
    });

    expect(prompt).toContain('# 自定义 Skill');
    expect(prompt).toContain('只输出：项目判断、风险等级');
  });
});
