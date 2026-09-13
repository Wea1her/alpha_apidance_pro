import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_ANALYSIS_SKILL = `# 项目/Alpha 账号分析 Skill

## 目标
用小资金试错、低成本试错、高赔率机会优先的交易风格，判断该 X 账号是否值得作为打新、空投、链上热点跟踪目标。重点看“投入很小但潜在收益很大”的不对称机会，避免把早期账号简单按大项目成熟度否定。

## 分析原则
- 热度和背书优先：优先看是否被知名项目方、蓝 V、KOL、交易所、基金、生态官方关注，其次看帖子浏览量、评论量、转发量、点赞量、讨论密度和监控池共同关注数。
- 背书账号必须基于检索：第 2 节优先使用可用的检索工具，用 x_search 查该账号在 X 上被哪些知名项目方、交易所、VC、基金、生态官方关注、互动、转发或联合公告，用 web_search 查官网、融资、合作、媒体报道；只写确实检索到的账号并说明依据，不得编造；未检索到或未启用检索时，必须明确写“未检索到知名 Crypto 背书账号”或“无法确认知名 Crypto 背书账号”。
- 背书排序优先级：项目方、协议官方、产品官方、交易所、VC、基金、生态官方、公链、Foundation、Labs 优先；这些不足 10 个时，再补充知名 Crypto KOL、媒体或社区号。
- follower 基数、follower 增长、互动率只作为辅助：不要因为 follower 基数小就直接写“不值得作为主要打新/链上热点跟踪目标”；早期账号应重点判断是否值得小资金试错。
- 信息不足时不要模糊乐观：缺少知名账号背书、帖子热度或链上关联时，要明确写“缺少硬数据支撑”，但结论应围绕小资金试错价值，而不是默认否定。
- 低成本参与优先：只要出现知名账号背书、帖子热度异常、监控池升星快或存在测试网/积分/空投/mint/白名单等早期窗口，就可以给出小仓试错或重点跟踪；只有风险证据强或热度/背书都缺失时才暂不参与。

## 分析维度
1. 项目核心信息：概括这个账号/项目的核心定位、产品或叙事。
2. 项目背景/背书账号：基于检索结果，按项目方/协议官方/产品官方、交易所、VC/基金、生态官方/公链/Foundation/Labs、知名 Crypto KOL、媒体/社区号的优先级，最多列 10 个账号，并说明背书含义和检索依据；如果只有 KOL 或媒体关注，必须说明“主要是 KOL 关注，不等同于项目方/VC/生态背书”；如果未检索到或未启用检索，必须明示“未检索到知名 Crypto 背书账号”或“无法确认知名 Crypto 背书账号”，不得写成有背书。
3. 当前进展：概括目前阶段、动作和热度；必须优先写知名项目方/蓝 V/KOL 等关注背书是否可见、帖子浏览量/评论量/转发量等热度是否异常、链上关联是否可见，follower 增长和互动率只作为辅助信息。
4. 优点：从增长、产品、叙事、资源、传播性等角度提炼 1-2 点。
5. 缺点：从真实性、落地性、可持续性、估值泡沫、信息不足等角度提炼 1-2 点。
6. 关注理由：必须从“小资金博高收益”的角度给出是否值得小资金试错/重点跟踪/暂不参与，操作只能从“小仓试错、重点跟踪、暂不参与”中选择；优先结合知名项目方/蓝 V/KOL 关注、帖子浏览量、评论量、转发量、互动热度、监控池关注数和升星速度说明理由，follower 基数不得作为主要否定理由。
7. 标签：给出 2-4 个中文短标签，用顿号分隔。

## 输出要求
- 严格按分析维度输出 7 个章节，每个章节都必须有内容。
- 章节标题单独一行，正文必须另起下一行输出，不要把正文接在标题同一行。
- 章节标题格式固定为 \`1. 项目核心信息\`、\`2. 项目背景/背书账号\`、\`3. 当前进展\`、\`4. 优点\`、\`5. 缺点\`、\`6. 关注理由\`、\`7. 标签\`。
- 不要写前言，不要写总结。
- 全部使用中文。
- 风格专业、克制、信息密度高。
- 每行可以扩充到接近 100 字，优先保证具体、全面、可执行，不要为了短而省略关键判断。
- 不要使用 Markdown 加粗或斜体，不要输出 * 号。
- 不要输出 Source、来源、参考来源、数据来源或引用列表。`;

export interface LoadAnalysisSkillOptions {
  name?: string;
  directory?: string;
}

export const DEFAULT_DEEP_ANALYSIS_SKILL = `# 5 星项目深度投研 Skill

## 目标
面向小资金试错、高赔率机会优先的打新投资者，对已达到最高星级的 X 账号/项目产出一份可以照着执行的深度投研报告。深度来自证据密度：每个关键结论都要有检索到的来源支撑，不做无依据的判断。

## 报告结构（6 个章节，章节标题单独一行，正文另起一行）
1. 项目定位与玩法：产品/协议到底做什么、代币或积分机制、参与路径和门槛；具体到策略参数、存入门槛、积分倍数、APR 等可执行细节。
2. 当前热度：X 上的具体证据——官方帖的互动数据（likes/reposts/views）、社区讨论内容、KOL 或合作账号的提及（带粉丝数），每条附来源链接。
3. 背书与合作关系：与哪些项目方、交易所、生态官方有可验证的联合动作或互动，说明依据；无法检索到 X 平台内部关注关系时必须明示。
4. 风险：合约/资金风险、积分与空投不确定性、流动性、团队透明度、叙事可持续性等，逐条给出依据。
5. 机遇：早期窗口、生态增长、不对称收益路径，说明触发条件。
6. 结论：是否值得小资金参与，给出具体仓位建议（总资金百分比或金额区间）和参与路径；高风险点必须同时列出。

## 证据要求
- 启用检索工具时，作答前必须先充分检索；未启用时明确说明信息未经检索确认。
- 每个关键结论在句末用裸链接标注来源（例如 https://x.com/xxx/status/123 或 https://defillama.com/xxx），不要输出 [1]、[[1]](url) 之类的引用标记格式。
- 数字尽量精确（TVL、粉丝数、互动量、APR、积分测算），并注明数据来源网站。
- 检索不到的信息明确写“未经检索确认”，不得编造；引用的推文链接必须是真实检索到的，不确定时明确说明。

## 输出要求
- 严格输出 6 个章节，每章都必须有内容。
- 不要写前言和总结。
- 全部使用中文。
- 风格专业、克制、信息密度高，可执行细节优先。
- 不要使用 Markdown 加粗或斜体，不要输出 * 号。`;

export async function loadAnalysisSkill(options: LoadAnalysisSkillOptions = {}): Promise<string> {
  return loadSkillFile(options.name ?? 'project-alpha', options.directory ?? join(process.cwd(), 'analysis-skills'), DEFAULT_ANALYSIS_SKILL);
}

export async function loadDeepAnalysisSkill(options: LoadAnalysisSkillOptions = {}): Promise<string> {
  return loadSkillFile(options.name ?? 'project-deep', options.directory ?? join(process.cwd(), 'analysis-skills'), DEFAULT_DEEP_ANALYSIS_SKILL);
}

async function loadSkillFile(name: string, directory: string, fallback: string): Promise<string> {
  try {
    const content = await readFile(join(directory, `${name}.md`), 'utf8');
    return content.trim();
  } catch {
    return fallback;
  }
}
