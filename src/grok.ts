export interface GrokAnalysisInput {
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
}

export function shouldTriggerGrokAnalysis(star: number): boolean {
  return star >= 3;
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
    '请严格按以下 6 行输出，每一行都必须有内容，不要写前言，不要写总结：',
    '1. 项目核心信息：概括这个账号/项目的核心定位、产品或叙事。',
    '2. 当前进展：概括目前可见的阶段、动作、热度或生态进展。',
    '3. 优点：从增长、产品、叙事、资源、传播性等角度提炼 1-2 点。',
    '4. 缺点：从真实性、落地性、可持续性、估值泡沫、信息不足等角度提炼 1-2 点。',
    '5. 关注理由：说明为什么值得关注或不值得关注，结论要明确。',
    '6. 标签：给出 2-4 个中文短标签，用顿号分隔。',
    '',
    '要求：',
    '- 全部使用中文',
    '- 风格专业、克制、信息密度高',
    '- 每行尽量控制在 30-50 字'
  ].join('\n');
}
