import { DEFAULT_ANALYSIS_SKILL, DEFAULT_DEEP_ANALYSIS_SKILL } from './analysis-skill.js';

export interface GrokAnalysisInput {
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
  /** 本次请求启用的 xAI 服务端检索工具，例如 web_search、x_search；为空表示未启用联网检索。 */
  searchTools?: readonly string[];
  analysisSkill?: string;
}

export function shouldTriggerGrokAnalysis(star: number): boolean {
  return star >= 3;
}

function formatSearchInstructions(searchTools: readonly string[] | undefined): string[] {
  const tools = searchTools ?? [];
  if (tools.length === 0) {
    return [
      '检索说明：',
      '本次未启用联网检索。第 2 节只能基于已知信息判断，无法确认知名 Crypto 背书账号时必须明确写“无法确认知名 Crypto 背书账号”，不得编造账号。'
    ];
  }

  const lines = ['检索要求：', `可用工具：${tools.join('、')}。作答前必须先检索，再基于检索结果写第 2 节。`];
  if (tools.includes('x_search')) {
    lines.push('- 用 x_search 检索该账号在 X 上被哪些知名项目方、交易所、VC/基金、生态官方关注、互动、转发或联合公告。');
  }
  if (tools.includes('web_search')) {
    lines.push('- 用 web_search 检索官网、融资、合作、媒体报道等公开信息。');
  }
  lines.push('- 第 2 节只写确实检索到的账号，并说明检索到的依据；未检索到就明确写“未检索到知名 Crypto 背书账号”，不得编造。');
  return lines;
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
    ...formatSearchInstructions(input.searchTools),
    '',
    '分析 Skill：',
    input.analysisSkill ?? DEFAULT_ANALYSIS_SKILL
  ].join('\n');
}

export interface DeepAnalysisInput extends GrokAnalysisInput {
  /** 该项目此前标准分析（grok-4.3）的正文，作为深投研的起点上下文；可为空。 */
  previousAnalysisText?: string;
}

export function buildDeepAnalysisPrompt(input: DeepAnalysisInput): string {
  const searchTools = input.searchTools ?? [];
  const lines = [
    `请对 X 上的 @${input.link.replace(/^https?:\/\/(?:x|twitter)\.com\//i, '').replace(/\/.*$/, '')} 做一份深度投研报告，面向打新/小资金试错的加密投资者。`,
    '',
    '已知信息：',
    `- 事件：${input.title}`,
    `- 链接：${input.link}`,
    `- 监控池关注数：${input.count}`,
    `- 重要程度：${input.star} 星（已达最高星级，触发深度投研）`,
    `- 原始内容：${input.content}`,
    ''
  ];
  if (input.previousAnalysisText) {
    lines.push('以下是此前标准分析的结论，请在其基础上深化、校正和补充，不要原样复述：', input.previousAnalysisText, '');
  }
  if (searchTools.length === 0) {
    lines.push('检索说明：', '本次未启用联网检索。仅依据已知信息和此前标准分析写报告；无法验证的数字、背书和链接必须标注“未经检索确认”，不得编造，也不得声称已完成检索。');
  } else {
    lines.push('检索要求：', `可用工具：${searchTools.join('、')}。作答前必须先检索，用来源证据支撑全部章节的关键结论。`);
    if (searchTools.includes('web_search')) {
      lines.push('- 用 web_search 检索官网、文档、链上数据、融资、合作和媒体报道。');
      if (!searchTools.includes('x_search')) {
        lines.push('- 当前只启用了 web_search：X 平台内部的关注关系无法直接检索，请用 site:x.com 检索、网页快照或镜像页获取推文证据，检索不到关注关系时明确说明。');
      }
    }
    if (searchTools.includes('x_search')) {
      lines.push('- 用 x_search 查找官方推文、互动和联合公告；未证实的关注关系不得当成背书。');
    }
  }
  lines.push('', '深度分析 Skill：', input.analysisSkill ?? DEFAULT_DEEP_ANALYSIS_SKILL);
  return lines.join('\n');
}
