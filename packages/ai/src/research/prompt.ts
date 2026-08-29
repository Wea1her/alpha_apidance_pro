import type { ReportDocument } from './report-schema.js';

export interface ResearchPromptInput {
  project: { name: string; handle: string; stage?: string; summary?: string };
  signals: readonly string[];
  evidence: readonly string[];
  webSearch?: readonly string[];
}

/** 正式报告模板版本。数据库中的 version 仍表示同一项目的内部修订序号。 */
export const REPORT_TEMPLATE_VERSION = 3 as const;

/** 固定写作模板：每次请求都会同时注入 user 和 system prompt，确保主/备用 Grok 一致。 */
export const REPORT_STYLE_TEMPLATE = [
  'coreInfo.summary：{项目名} (@{账号}) 定位为{核心定位/叙事}，通过{产品机制与用户参与方式}服务{目标用户}；项目覆盖{链/生态}，以{收入或激励机制}形成参与动力；当前{集成、上线或测试进展}，关键窗口是{主网、campaign、白名单、NFT mint 或首发 meme 等}，后续需验证{具体交付与增长指标}。',
  'focusReason.strengths：作为{赛道}的早期布局者，{具体事实}带来{优势逻辑}，适合{短期投机/创业参与方式}；{第二项事实}提升{传播、用户或生态价值}，但必须绑定公开证据。',
  'focusReason.weaknesses：{团队、审计、产品、数据或竞争方面的缺口}导致{对落地、留存或流动性的影响}；若{叙事/流量/交付条件}不成立，{下行风险}会放大，后续需验证{具体检查动作}。',
  'focusReason.reason：值得小仓试错。该账号获得{实际监控/Alpha 信号}，叠加{早期窗口}，存在{白名单、NFT mint、首发 meme、campaign 等}机会；尽管{硬数据、背书或热度证据缺口}，从小资金博高赔率角度仍具备{不对称价值}，建议跟踪{具体动作}，严格小仓参与而非重仓。'
].join('\n');

export function buildResearchReportPrompt(input: ResearchPromptInput): { system: string; user: string } {
  const user = [
    `正式模板：V${REPORT_TEMPLATE_VERSION}（前端不展示版本号）`,
    `项目：${input.project.name}`,
    `X 账号：${input.project.handle}`,
    `阶段：${input.project.stage ?? '暂未确认'}`,
    `摘要：${input.project.summary ?? '暂未确认'}`,
    '',
    '【强制写作模板】以下模板只规定表达方式，花括号内容必须替换为该项目的真实事实；没有证据就写“暂无公开证据”，禁止照抄示例或编造：',
    REPORT_STYLE_TEMPLATE,
    '',
    '请按以下 1-6 结构输出一份详细、可直接阅读的中文投研文档；每一节都必须给出事实、证据、判断和不确定性，不得只写一句话或重复“暂未确认”。',
    '1. 项目核心信息：必须写成“项目名 (@账号) 定位为……”的完整定位段落，至少 4-7 个有信息量的句子。依次说明核心定位与叙事、产品机制/用户如何参与、覆盖的链与生态、商业模式或收入分配、当前集成/上线进展、关键时间窗口和主要验证点；把简介中的关键词转译成可验证含义。不要只写“这是一个 Web3 项目/平台”或一句泛化摘要。若某项没有公开证据，写明“暂无公开证据”，但仍要完成其余维度的分析。',
    '2. 当前进展：只围绕该账号最近可公开读取的帖子/推文进行分析，重点评估最近帖子的发布时间与内容、单帖浏览量/点赞/转发/回复等帖子热度、账号发帖频率与活跃度、讨论度（回复和引用质量）、粉丝数量及多次快照推导的粉丝增长速度。至少列出 2-3 个时间或指标维度，给出具体数值、变化方向、样本不足之处和下一步验证点；如果帖子被锁定、删除或搜索不到，只简洁说明“近期帖子不可公开读取/暂无公开正文”。本节严禁输出账号简介复述、共同关注人数、Alpha 证据 ID 串、绑定 evidence 编号或“某账号关注了该账号”等信号元数据，这些内容只能用于内部判断，不能替代最近帖子分析。不要使用“已完成事项为”或“未完成事项为”作为小标题或固定格式。',
    '3. 优点：以 1-3 段完整连贯的中文分析输出，不要写成关键词列表；每个数组元素至少 80 个中文字符，必须同时写出具体事实、优势逻辑、短期投机/创业机会意义和证据边界，参考“作为……的早期布局者，具体事实带来什么优势，并如何影响链上热点捕捉”的句式，使用分号串联相关判断。',
    '4. 缺点：以 1-3 段完整连贯的中文分析输出，不要写成关键词列表；每个数组元素至少 80 个中文字符，必须同时写出团队/审计/产品/数据/竞争方面的具体缺口、对落地/留存/流动性的影响和下一步验证动作，参考“缺口导致什么影响，若条件不成立风险如何放大”的句式，使用分号串联相关判断。',
    '5. 关注理由：用 1-3 个完整段落输出交易决策式判断，首句必须明确写“值得小仓试错”“持续观察”或“暂不纳入”。参照“该账号获得多少监控池关注/Alpha caller 跟进，叠加哪些主网、测试网 campaign、白名单、NFT mint 或首发 meme 早期窗口；尽管哪些硬数据、背书和热度证据不足，但从小资金博高赔率角度为何仍有或没有不对称价值；建议跟踪哪些具体动作、参与边界和停止条件，明确不重仓”的句式。信号数量只能使用实际证据，缺失时写“暂无公开证据”，不得编造；不要把“新股申购/传统股票研究”当作本项目的判断标准。',
    '6. 标签：输出 3-8 个具体中文标签，并覆盖生态/赛道、产品形态和阶段特征。若项目核心是 Launchpad/发射台/代币发射平台，必须单独标注 Launchpad，不要把它写成 DeFi；只有核心产品是交易、借贷或收益协议时才使用 DeFi 标签。',
    '必须先使用 Grok X Search 搜索该账号的公开资料、近期推文和项目官方页面，再结合 Alpha 信号形成判断；无法找到的内容必须明确写“暂无公开证据”。',
    '所有重要判断必须基于给定证据或联网搜索结果；没有证据就写“暂无公开证据”，禁止虚构来源。不要进行 L2 六赛道深挖、独立复核轮、评分总览或风险与证据链等额外分析环节。',
    '',
    `信号证据：\n${input.signals.length ? input.signals.map((item) => `- ${item}`).join('\n') : '- 暂无'}`,
    `\n可用 Evidence：\n${input.evidence.length ? input.evidence.map((item) => `- ${item}`).join('\n') : '- 暂无'}`,
    `\n联网搜索结果（仅作为公开资料线索，必须结合 Evidence 谨慎判断）：\n${input.webSearch?.length ? input.webSearch.map((item) => `- ${item}`).join('\n') : '- 未找到公开搜索结果，请明确标注“暂无公开资料”'}`
  ].join('\n');
  return { system: `你是严谨的中文加密项目研究员，当前使用正式的 V${REPORT_TEMPLATE_VERSION} 报告模板。你可以并且必须使用 X Search 搜索目标账号和项目的公开信息。只返回符合 ReportDocumentSchema 的 JSON，不要返回 Markdown 或额外解释。顶层只能包含 coreInfo、focusReason、tags 三个键：coreInfo 只能包含 projectName、handle、summary、stage；focusReason 只能包含 currentProgress、strengths、weaknesses、reason；tags 是字符串数组。禁止输出任何其他键。coreInfo.summary 必须采用“项目名 (@账号) 定位为……”的项目定位模板，具体展开定位、机制、用户玩法、生态、收入机制、当前进展和验证点，不能只写泛化摘要；不要生成独立的项目背景章节或背书账号名单，也不要用传统股票/新股申购研究框架替代加密项目判断。focusReason.currentProgress 只能写最近帖子分析，禁止复述简介、共同关注/粉丝数据、Alpha evidenceId 或关注事件元数据；focusReason.reason 必须是交易决策式完整段落，首句明确给出“值得小仓试错/持续观察/暂不纳入”，并说明早期窗口、证据缺口、跟踪动作和不重仓边界。以下是必须遵循的固定写作模板（花括号必须替换为真实证据）：\n${REPORT_STYLE_TEMPLATE}\n只输出模板要求的六节正文，不要进行 L2 六赛道深挖、独立复核轮、评分总览、风险与证据链、核心论点或参与玩法等额外分析环节。中文只写在字段值中，不要把章节标题当作 JSON 键名；每个字段只能填写该字段对应的正文，禁止在字符串开头加入章节编号，禁止把多个章节合并到同一个字段。`, user };
}

export type ResearchReportDocument = ReportDocument;
