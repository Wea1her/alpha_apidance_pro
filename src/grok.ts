import type { RugHistoryEvidence } from './rug-history-provider.js';
import { DEFAULT_ANALYSIS_SKILL } from './analysis-skill.js';

export interface GrokAnalysisInput {
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
  rugHistory?: RugHistoryEvidence;
  analysisSkill?: string;
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
    '分析 Skill：',
    input.analysisSkill ?? DEFAULT_ANALYSIS_SKILL
  ].join('\n');
}
