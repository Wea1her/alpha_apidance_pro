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
        negativeNoiseCount: 1,
        deletedTweetSamples: ['old mint failed'],
        negativeMentionSamples: ['@b rug?'],
        commentNegativeSamples: ['quote rug warning', '@b 无法提现'],
        negativeNoiseSamples: ['random scam coin'],
        contractDeletedTweetSamples: ['CA: 0x1234567890abcdef1234567890abcdef12345678'],
        recentRiskSignals: ['近期多次提到 mint'],
        warnings: []
      }
    });

    expect(prompt).toContain('Rug 历史/风险');
    expect(prompt).toContain('Rug 证据状态：有明确风险证据');
    expect(prompt).toContain('Rug 结论：存在明确风险证据');
    expect(prompt).toContain('删帖数量：2');
    expect(prompt).toContain('检查推文数量：3');
    expect(prompt).toContain('评论区负面数量：2');
    expect(prompt).toContain('负面噪声数量：1');
    expect(prompt).toContain('@b rug?');
    expect(prompt).toContain('quote rug warning');
    expect(prompt).toContain('random scam coin');
    expect(prompt).toContain('近期多次提到 mint');
    expect(prompt).toContain('合约相关删帖原文：');
    expect(prompt).toContain('CA: 0x1234567890abcdef1234567890abcdef12345678');
    expect(prompt.indexOf('合约相关删帖原文：')).toBeGreaterThan(prompt.indexOf('数据警告：'));
    expect(prompt.indexOf('合约相关删帖原文：')).toBeLessThan(prompt.indexOf('分析 Skill：'));
    expect(prompt).not.toContain('source');
    expect(prompt).not.toContain('数据源');
  });

  it('includes project backing evidence before rug history when provided', () => {
    const prompt = buildGrokPrompt({
      title: 'A 关注了 B',
      content: '用户简介: builder',
      link: 'https://x.com/b',
      count: 12,
      star: 3,
      projectBacking: {
        source: '6551',
        available: true,
        candidateCount: 3,
        candidates: [
          {
            username: 'aave',
            displayName: 'Aave',
            verified: true,
            followersCount: 730000,
            rawCategory: 'project',
            description: 'Aave Protocol official account'
          },
          {
            username: 'paradigm',
            displayName: 'Paradigm',
            verified: true,
            followersCount: 410000,
            rawCategory: 'vc',
            description: 'A research-driven crypto investment firm'
          },
          {
            username: 'base',
            displayName: 'Base',
            description: 'Ethereum L2',
            verified: undefined,
            followersCount: undefined
          }
        ],
        warnings: []
      },
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

    expect(prompt).toContain('项目背景/背书账号证据：');
    expect(prompt).toContain('6551 背书账号状态：查询成功');
    expect(prompt).toContain('候选账号数量：3');
    expect(prompt).toContain('只能从以下候选账号中选最多 10 个');
    expect(prompt).toContain('项目方/协议官方/产品官方、交易所官方、VC/基金、生态官方/公链/Foundation/Labs');
    expect(prompt).toContain(
      '@aave | Aave | verified=true | followers=730000 | category=project | bio=Aave Protocol official account'
    );
    expect(prompt).toContain(
      '@paradigm | Paradigm | verified=true | followers=410000 | category=vc | bio=A research-driven crypto investment firm'
    );
    expect(prompt).toContain('@base | Base | verified=未知 | followers=未知 | category=未知 | bio=Ethereum L2');
    expect(prompt.indexOf('项目背景/背书账号证据：')).toBeLessThan(prompt.indexOf('Rug 证据状态：'));
    expect(prompt).not.toContain('source');
    expect(prompt).not.toContain('数据源');
  });

  it('marks empty project backing lookup as successful without known crypto backing accounts', () => {
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
    expect(prompt).not.toContain('@aave |');
    expect(prompt).not.toContain('@paradigm |');
  });

  it('marks unavailable project backing lookup as a data gap with warnings', () => {
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
      '要求：第 8 节必须明确写“发现 CA/合约相关删帖”，并引用合约相关删帖原文；但不得仅凭这一点直接判定跑路，需结合删帖数量、负面提及、评论区样本和其他证据判断。'
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
    expect(prompt).not.toContain('第 8 节必须明确写“发现 CA/合约相关删帖”');
  });

  it('marks contract-related deleted tweets as a data gap when rug evidence has warnings', () => {
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
        recentTweetCount: 0,
        commentNegativeCount: 0,
        checkedTweetCount: 0,
        negativeNoiseCount: 0,
        deletedTweetSamples: [],
        contractDeletedTweetSamples: [],
        negativeMentionSamples: [],
        commentNegativeSamples: [],
        negativeNoiseSamples: [],
        recentRiskSignals: [],
        warnings: ['twitter_deleted_tweets 查询失败']
      }
    });

    expect(prompt).toContain('CA/合约相关删帖：未查询或查询失败');
    expect(prompt).not.toContain('CA/合约相关删帖：未发现');
  });

  it('marks successful empty rug lookup as no direct evidence', () => {
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

    expect(prompt).toContain('Rug 证据状态：查询成功但无直接证据');
    expect(prompt).toContain('Rug 结论：未发现直接证据');
  });

  it('marks unrelated negative results as low relevance noise', () => {
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
        negativeNoiseCount: 2,
        deletedTweetSamples: [],
        contractDeletedTweetSamples: [],
        negativeMentionSamples: [],
        commentNegativeSamples: [],
        negativeNoiseSamples: ['random scam coin', 'unrelated rug warning'],
        recentRiskSignals: [],
        warnings: []
      }
    });

    expect(prompt).toContain('Rug 证据状态：有负面噪声但相关性不足');
    expect(prompt).toContain('Rug 结论：有噪声但相关性不足');
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
