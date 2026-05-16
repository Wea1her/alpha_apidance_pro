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

function count(value: number | null | undefined): number {
  return typeof value === 'number' ? value : 0;
}

function buildRugEvidenceStatus(evidence: RugHistoryEvidence): string {
  if (!evidence.available || evidence.warnings.length > 0) return '未查询或查询失败';

  const directEvidenceCount =
    count(evidence.deletedTweetCount) + count(evidence.negativeMentionCount) + count(evidence.commentNegativeCount);
  if (directEvidenceCount > 0) return '有明确风险证据';
  if (count(evidence.negativeNoiseCount) > 0) return '有负面噪声但相关性不足';
  return '查询成功但无直接证据';
}

function buildRugConclusionConstraint(status: string): string {
  if (status === '未查询或查询失败') {
    return 'Rug 结论：数据缺口，不能判安全';
  }
  if (status === '查询成功但无直接证据') {
    return 'Rug 结论：未发现直接证据';
  }
  if (status === '有负面噪声但相关性不足') {
    return 'Rug 结论：有噪声但相关性不足';
  }
  return 'Rug 结论：存在明确风险证据';
}

function formatRugHistory(evidence: RugHistoryEvidence | undefined): string[] {
  if (!evidence) return ['Rug 历史：未查询'];
  const status = buildRugEvidenceStatus(evidence);
  return [
    `Rug 证据状态：${status}`,
    buildRugConclusionConstraint(status),
    `Rug 数据可用：${evidence.available ? '是' : '否'}`,
    `删帖数量：${evidence.deletedTweetCount ?? '未知'}`,
    `负面提及数量：${evidence.negativeMentionCount ?? '未知'}`,
    `近期推文数量：${evidence.recentTweetCount ?? '未知'}`,
    `检查推文数量：${evidence.checkedTweetCount ?? '未知'}`,
    `评论区负面数量：${evidence.commentNegativeCount ?? '未知'}`,
    `负面噪声数量：${evidence.negativeNoiseCount ?? '未知'}`,
    '删帖样本：',
    formatList(evidence.deletedTweetSamples),
    '负面评论样本：',
    formatList(evidence.negativeMentionSamples),
    '评论区负面样本：',
    formatList(evidence.commentNegativeSamples),
    '低相关负面噪声样本：',
    formatList(evidence.negativeNoiseSamples),
    '近期风险信号：',
    formatList(evidence.recentRiskSignals),
    '数据警告：',
    formatList(evidence.warnings),
    '合约相关删帖原文：',
    formatList(evidence.contractDeletedTweetSamples)
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
