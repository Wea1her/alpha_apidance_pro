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
    '请按以下 1-7 结构输出一份详细、可直接阅读的中文投研文档；每一节都必须给出事实、证据、判断和不确定性，不得只写一句话或重复“暂未确认”。',
    '1. 项目核心信息：至少 2-4 个完整句子，说明账号对应的项目、核心定位、产品/叙事、目标用户、所处生态和关键公开资料；把简介中的关键词解释成可验证含义。',
    '2. 项目背景：只分析项目自身背景、所属生态、产品来源、发展阶段和公开资料脉络；不要单独输出或猜测背书账号、KOL/VC关注名单。',
    '3. 当前进展：只围绕该账号最近可公开读取的帖子/推文进行分析。至少列出 2-3 个时间或内容维度，给出发帖时间、帖子原文要点、已完成事项、未完成事项和下一步验证点；如果帖子被锁定、删除或搜索不到，只简洁说明“近期帖子不可公开读取/暂无公开正文”。本节严禁输出账号简介复述、共同关注人数、粉丝数、Alpha 证据 ID 串、绑定 evidence 编号或“某账号关注了该账号”等信号元数据，这些内容只能用于内部判断，不能替代最近帖子分析。',
    '4. 优点：输出 3-5 条，每条至少包含“具体事实 → 为什么构成优势 → 对短期投机/创业机会的意义”，避免空泛形容词。',
    '5. 缺点：输出 3-5 条，每条至少包含“缺失或负面事实 → 对项目判断的影响 → 需要如何验证”，覆盖产品、执行、流动性、竞争和数据限制。',
    '6. 关注理由：用 1-3 个段落综合当前进展、优缺点和信号强度，明确是否值得跟踪、适合何种小仓试错、升级观察条件、停止跟踪条件及主要不确定性；不要把“新股申购/传统股票研究”当作本项目的判断标准。',
    '7. 标签：输出 3-8 个具体中文标签，并覆盖生态/赛道、产品形态和阶段特征。',
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
  return { system: '你是严谨的中文加密项目研究员。你可以并且必须使用 X Search 搜索目标账号和项目的公开信息。只返回符合 ReportDocumentSchema 的 JSON，不要返回 Markdown 或额外解释。JSON 键名必须严格使用 Schema 定义的英文键名（例如 coreInfo、focusReason、thesis、playbook、l2Tracks、independentReview、score、risksEvidence）；coreInfo.background 仅用于第 2 节项目背景，不要输出独立的背书账号名单，也不要用传统股票/新股申购研究框架替代加密项目判断。focusReason.currentProgress 只能写最近帖子分析，禁止复述简介、共同关注/粉丝数据、Alpha evidenceId 或关注事件元数据。中文只写在字段值中，不要把章节标题当作 JSON 键名；每个字段只能填写该字段对应的正文，禁止在字符串开头加入“4. 优点：”“5. 缺点：”等章节编号，禁止把多个章节合并到同一个字段。必须完成 1-7 节中文分析、六赛道深挖和独立复核轮证伪；正文要充分展开，每个字段优先使用完整段落和多条具体要点。', user };
}

export type ResearchReportDocument = ReportDocument;
