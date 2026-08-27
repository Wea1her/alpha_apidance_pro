import type { ReportDocument } from './report-schema.js';

export const L2_RESEARCH_TRACKS = [
  { key: 'product', title: '产品与需求', question: '产品解决什么问题，用户是谁，真实使用和差异化是否成立？' },
  { key: 'technology', title: '技术与交付', question: '技术路线、开发进度、可验证交付和工程风险是什么？' },
  { key: 'team', title: '团队与执行', question: '团队身份、持续交付能力和执行可信度有哪些可核验事实？' },
  { key: 'market', title: '市场与生态', question: '市场空间、用户增长、生态合作和竞争格局是否支持项目叙事？' },
  { key: 'tokenomics', title: '代币与激励', question: '代币模型、积分、空投、解锁和参与激励有哪些已确认与未知项？' },
  { key: 'catalysts', title: '催化剂与风险', question: '近期催化剂、关键时间点、失败条件和下行风险是什么？' }
] as const;

export interface ResearchPromptInput {
  project: { name: string; handle: string; stage?: string; summary?: string };
  signals: readonly string[];
  evidence: readonly string[];
  webSearch?: readonly string[];
}

export function buildResearchReportPrompt(input: ResearchPromptInput): { system: string; user: string } {
  const tracks = L2_RESEARCH_TRACKS.map((track, index) => `${index + 1}. ${track.title}（${track.key}）：${track.question}`).join('\n');
  const user = [
    `项目：${input.project.name}`,
    `X 账号：${input.project.handle}`,
    `阶段：${input.project.stage ?? '暂未确认'}`,
    `摘要：${input.project.summary ?? '暂未确认'}`,
    '',
    '请完成 L2 六赛道深挖：',
    tracks,
    '',
    '随后进行独立复核轮：把核心论点改写成可证伪假设，列出检查项、反证和最终复核结论。',
    '必须先使用 Grok X Search 搜索该账号的公开资料、近期推文和项目官方页面，再结合 Alpha 信号形成判断；无法找到的内容必须明确写“暂无公开证据”。',
    '最后输出 0-100 总分、0-1 置信度、六个维度各自 0-10 分，以及重点关注/持续观察/暂不纳入判断。',
    '所有重要判断必须绑定给定 evidenceId；没有证据就写“暂未确认”，禁止虚构来源。',
    '',
    `信号证据：\n${input.signals.length ? input.signals.map((item) => `- ${item}`).join('\n') : '- 暂无'}`,
    `\n可用 Evidence：\n${input.evidence.length ? input.evidence.map((item) => `- ${item}`).join('\n') : '- 暂无'}`,
    `\n联网搜索结果（仅作为公开资料线索，必须结合 Evidence 谨慎判断）：\n${input.webSearch?.length ? input.webSearch.map((item) => `- ${item}`).join('\n') : '- 未找到公开搜索结果，请明确标注“暂无公开资料”'}`
  ].join('\n');
  return { system: '你是严谨的中文加密项目研究员。你可以并且必须使用 X Search 搜索目标账号和项目的公开信息。只返回符合 ReportDocumentSchema 的 JSON，不要返回 Markdown 或额外解释。JSON 键名必须严格使用 Schema 定义的英文键名（例如 coreInfo、focusReason、thesis、playbook、l2Tracks、independentReview、score、risksEvidence），中文只写在字段值中，不要把章节标题当作 JSON 键名。必须完成六赛道深挖和独立复核轮证伪。', user };
}

export type ResearchReportDocument = ReportDocument;
