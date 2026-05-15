import type { RugHistoryEvidence } from './rug-history-provider.js';

export interface GrokAnalysisInput {
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
  rugHistory?: RugHistoryEvidence;
}

export function shouldTriggerGrokAnalysis(star: number): boolean {
  return star >= 3;
}

function formatList(items: string[] | undefined): string {
  if (!items) return '  - 暂无';
  return items.length > 0 ? items.map((item) => `  - ${item}`).join('\n') : '  - 暂无';
}

function formatRugHistory(evidence: RugHistoryEvidence | undefined): string[] {
  if (!evidence) return ['Rug 历史：未查询'];
  return [
    `Rug 数据可用：${evidence.available ? '是' : '否'}`,
    `删帖数量：${evidence.deletedTweetCount ?? '未知'}`,
    `负面提及数量：${evidence.negativeMentionCount ?? '未知'}`,
    `近期推文数量：${evidence.recentTweetCount ?? '未知'}`,
    `检查推文数量：${evidence.checkedTweetCount ?? '未知'}`,
    `评论区负面数量：${evidence.commentNegativeCount ?? '未知'}`,
    '删帖样本：',
    formatList(evidence.deletedTweetSamples),
    '负面评论样本：',
    formatList(evidence.negativeMentionSamples),
    '评论区负面样本：',
    formatList(evidence.commentNegativeSamples),
    '近期风险信号：',
    formatList(evidence.recentRiskSignals),
    '数据警告：',
    formatList(evidence.warnings)
  ];
}

export function buildGrokPrompt(input: GrokAnalysisInput): string {
  return [
    '请对这个 X 账号做偏投研风格的专业中文分析，判断它是否值得作为打新/链上热点跟踪目标。',
    '',
    '已知信息：',
    `- 事件：${input.title}`,
    `- 链接：${input.link}`,
    `- 监控池关注数：${input.count}`,
    `- 重要程度：${input.star} 星`,
    `- 原始内容：${input.content}`,
    '',
    ...formatRugHistory(input.rugHistory),
    '',
    '请严格按以下 7 行输出，每一行都必须有内容，不要写前言，不要写总结：',
    '1. 项目核心信息：概括这个账号/项目的核心定位、产品或叙事。',
    '2. 当前进展：概括目前可见的阶段、动作、热度或生态进展。',
    '3. 优点：从增长、产品、叙事、资源、传播性等角度提炼 1-2 点。',
    '4. 缺点：从真实性、落地性、可持续性、估值泡沫、信息不足等角度提炼 1-2 点。',
    '5. 关注理由：说明为什么值得关注或不值得关注，结论要明确。',
    '6. 标签：给出 2-4 个中文短标签，用顿号分隔。',
    '7. Rug 历史/风险：基于删帖记录和社区评论判断是否存在跑路、骗局、严重负面历史；没有证据时明确写“暂无直接证据”。',
    '',
    '要求：',
    '- 全部使用中文',
    '- 风格专业、克制、信息密度高',
    '- 每行尽量控制在 30-50 字'
  ].join('\n');
}
