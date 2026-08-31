import { createHash } from 'node:crypto';
import {
  AiProviderRouter,
  buildResearchReportPrompt,
  renderReportMarkdown,
  ReportDocumentSchema,
  REPORT_TEMPLATE_VERSION,
  type ReportDocument
} from '@alpha-research/ai';
import { OutboxStore, type JobDatabase, type JobRecord } from '@alpha-research/db';

interface ResearchProjectPayload { projectId: string; triggerSignalId?: string; }
interface ProjectRow { id: string; current_handle: string; display_name: string; status: string; profile_summary?: string; evidence_summary?: string; }
interface SignalRow { id: string; type: string; occurred_at: string; common_follow_count: number | null; x_post_url: string | null; content: string | null; data: unknown; }
interface EvidenceRow { id: string; signal_id: string | null; url: string; excerpt: string; content_hash: string; }
interface ReportVersionRow { id: string; version: number; status: string; }

function parsePayload(job: JobRecord): ResearchProjectPayload {
  let value: unknown = job.payload;
  for (let attempt = 0; typeof value === 'string' && attempt < 2; attempt += 1) value = JSON.parse(value);
  const payload = value as ResearchProjectPayload;
  if (!payload?.projectId) throw new Error('Invalid research_project payload');
  return payload;
}

function record(value: unknown): Record<string, unknown> {
  let current = value;
  for (let attempt = 0; attempt < 2 && typeof current === 'string'; attempt += 1) {
    try { current = JSON.parse(current) as unknown; } catch { return {}; }
  }
  return current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
}
function text(value: unknown, fallback = ''): string { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function substantive(value: unknown, fallback: string): string { const result = text(value); return result && !PLACEHOLDER_TEXT.has(result) ? result : fallback; }
function isTemplateEcho(value: unknown): boolean {
  const result = text(value);
  const evidencePlaceholders = (result.match(/暂无公开证据/gu) ?? []).length;
  return /\{[^{}]+\}/u.test(result) || evidencePlaceholders >= 2 || /(?:核心定位\/叙事|产品机制与用户参与方式|收入或激励机制|具体交付与增长指标)/u.test(result);
}
function detailedNarrative(value: string, minimum = 55): boolean {
  const normalized = value.trim();
  return normalized.length >= minimum && !isTemplateEcho(normalized) && !/^(?:暂无|未知|待确认|有待)/u.test(normalized);
}
function first(value: unknown, keys: readonly string[]): unknown {
  const object = record(value);
  for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key];
  return undefined;
}
function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}
function stripSectionPrefix(value: string): string {
  return value.replace(/^\s*(?:第\s*)?[1-7８-９七六五四三二一]+\s*[\.、．]\s*(?:项目核心信息|项目背景(?:\/背书账号)?|当前进展|优点|缺点|关注理由|标签)\s*[:：]?\s*/u, '').trim();
}
function sectionValue(value: unknown, expected: string, fallback = ''): string {
  const raw = text(value);
  if (!raw || PLACEHOLDER_TEXT.has(raw)) return fallback;
  const heading = raw.match(/^\s*(?:第\s*)?([1-7一二三四五六七])\s*[\.、．]\s*(项目核心信息|项目背景(?:\/背书账号)?|当前进展|优点|缺点|关注理由|标签)\s*[:：]?/u);
  if (heading && heading[2] !== expected) return fallback;
  if (expected === '项目核心信息' && /(?:值得小仓|小仓试错|停止跟踪条件|升级观察条件|参与条件)/u.test(raw)) return fallback;
  const cleaned = stripSectionPrefix(raw);
  // Some relays concatenate several numbered sections into one JSON field.
  // Keep only the portion belonging to the requested section.
  const nextSection = cleaned.search(/\s+(?:[1-7一二三四五六七])\s*[\.、．]\s*(?:项目核心信息|项目背景(?:\/背书账号)?|当前进展|优点|缺点|关注理由|标签)\s*[:：]/u);
  return (nextSection > 0 ? cleaned.slice(0, nextSection) : cleaned).trim();
}
function sanitizeCurrentProgress(value: string): string {
  let cleaned = stripSectionPrefix(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '')
    .replace(/X\s*账号\s*@?[\w.-]+(?:简介|资料)[^；。]*[；。]?/giu, '')
    .replace(/(?:绑定|关联)?\s*(?:evidence|证据)(?:\s*(?:ID|编号))?[^；。]*[；。]?/giu, '')
    .replace(/(?:共同关注(?:人数|峰值)?|粉丝(?:数)?|Alpha\s*星级)[^；。]*[；。]?/giu, '')
    .replace(/近期推文均为\s*[🔒锁定内容]+[^；。]*[；。]?/gu, '')
    .replace(/\s*[；;，,]\s*/gu, '；')
    .replace(/(?:^；+|；+$)/gu, '')
    .replace(/；{2,}/gu, '；')
    .trim();
  return cleaned || '最近帖子分析：当前未获取到可公开读取的近期帖子正文，可能是锁定、删除或搜索结果受限；待下一条公开帖子验证。';
}
/** Remove Alpha transport metadata before narrative fields are persisted. */
function sanitizeNarrative(value: string): string {
  let cleaned = stripSectionPrefix(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '')
    .replace(/(?:账号资料|当前信号事实|用户简介|指标|时间)\s*[:：][^。]*(?:。|$)/gu, '')
    .replace(/(?:共同关注(?:人数|峰值)?|共同关注)\s*\d+\s*人?[。；;]?/gu, '')
    .replace(/你关注的\s*\d+\s*个用户也关注了ta[。；;]?/giu, '')
    .replace(/(?:绑定|关联)?\s*(?:evidence|证据)(?:\s*(?:ID|编号))?\s*[:：]?\s*[0-9a-f-]{8,}/giu, '')
    .replace(/\s*[；;，,]\s*/gu, '；')
    .replace(/(?:^；+|；+$)/gu, '')
    .replace(/；{2,}/gu, '；')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  return cleaned;
}

function sanitizeTag(value: string): string {
  return value.replace(/`/gu, '').replace(/[\r\n]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
}

function containsRawTransportMetadata(value: string): boolean {
  return /(?:账号资料：|当前信号事实：|绑定\s*(?:evidence|证据)|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/iu.test(value);
}

function profileFacts(profile: string): { description: string; followers?: number; posts?: number } {
  const description = profile.match(/简介：([\s\S]+?)(?=；粉丝|；发帖|。|$)/u)?.[1]?.trim() ?? '';
  const followerRaw = profile.match(/粉丝\s*(\d+)/u)?.[1];
  const postsRaw = profile.match(/发帖\s*(\d+)/u)?.[1];
  return { description, followers: followerRaw ? Number(followerRaw) : undefined, posts: postsRaw ? Number(postsRaw) : undefined };
}
function normalizeReport(raw: Record<string, unknown>, fallbackProject?: ProjectRow) {
  const projectValue = first(raw, ['project', 'coreInfo', 'project_info', '项目核心信息', '核心信息']);
  const project = typeof projectValue === 'string' ? {} : record(projectValue);
  const focus = record(first(raw, ['focusReason', 'key_focus', 'focus_reason', 'focus', '关注理由', '重点关注理由']));
  const focusNarrative = typeof first(raw, ['focusReason', 'focus']) === 'string' ? stripSectionPrefix(text(first(raw, ['focusReason', 'focus']))) : '';
  const profile = fallbackProject?.profile_summary ? profileFacts(fallbackProject.profile_summary) : undefined;
  const profileDescription = profile?.description || fallbackProject?.profile_summary?.replace(/^账号资料：/u, '').trim();
  const summaryCandidate = first(raw, ['abstract', 'summary', 'description', '项目摘要', '项目描述']) ?? first(project, ['summary', 'abstract', 'description', '摘要', '项目摘要', '项目描述']);
  const summaryValue = sectionValue(summaryCandidate, '项目核心信息', fallbackProject?.profile_summary ? `公开简介显示${profileDescription || '明确产品主题'}；具体产品机制、用户参与方式和当前交付仍需结合近期帖子核验。` : '公开定位资料不足，暂无法确认具体产品机制和参与方式。');
  const summary = isTemplateEcho(summaryValue) || containsRawTransportMetadata(summaryValue)
    ? (fallbackProject?.profile_summary ? `公开简介显示${profileDescription || '明确产品主题'}；具体产品机制、用户参与方式和当前交付仍需结合近期帖子核验。` : '公开定位资料不足，暂无法确认具体产品机制和参与方式；后续需结合账号近期帖子、官方链接和实际交付进一步判断。')
    : summaryValue;
  const rawStrengths = strings(first(focus, ['strengths', 'advantages', '优点', '优势'])).map((item) => sanitizeNarrative(sectionValue(item, '优点'))).filter((item) => item && detailedNarrative(item));
  const rawWeaknesses = strings(first(focus, ['weaknesses', 'risks', '缺点', '不足'])).map((item) => sanitizeNarrative(sectionValue(item, '缺点'))).filter((item) => item && detailedNarrative(item));
  const accountMetrics = profile && (profile.followers !== undefined || profile.posts !== undefined)
    ? `账号当前约${profile.followers ?? '未知'}名粉丝、累计${profile.posts ?? '未知'}条发帖，内容规模与活跃度仍需连续样本验证`
    : '账号粉丝与发帖基数暂无公开证据，活跃度仍需连续样本验证';
  const normalizedStrengths = rawStrengths.length ? rawStrengths : [fallbackProject?.profile_summary ? `公开资料显示该账号围绕${profileDescription || '明确产品主题'}构建叙事，${accountMetrics}；如果后续公开帖子能证明产品演示、用户参与或链上交付，该方向才可能形成早期传播与短期投机窗口，当前应以低成本跟踪和小额验证为主。` : `当前仅能确认账号围绕一个明确主题或产品方向展开；若后续出现可验证交付、用户反馈和持续更新，该方向可能形成早期差异化，值得保持低成本跟踪。`];
  const normalizedWeaknesses = rawWeaknesses.length ? rawWeaknesses : [fallbackProject?.profile_summary ? `现有证据主要来自账号定位资料，${accountMetrics}，且近期公开帖子正文、产品演示、链上数据和真实用户反馈不足；这会直接限制对交付能力、留存和流动性的判断，若后续仍无持续更新或可验证使用记录，叙事落空与流动性不足风险会放大，需核对产品链接、连续发帖热度和链上活动。` : `公开资料、推文细节或用户数据仍有限，部分判断需要后续公开证据验证；在缺少连续交付、用户使用和链上活动记录前，项目持续性、流动性和叙事兑现能力都不能确认。`];
  const progressValue = sectionValue(first(focus, ['currentProgress', 'current_progress', '当前进展', '进展']), '当前进展', focusNarrative || text(first(raw, ['monitor', '当前进展']), '当前进展依据有限，需继续跟踪公开交付。'));
  const progressBase = sanitizeCurrentProgress(isTemplateEcho(progressValue) ? '近期帖子不可公开读取，暂无法从公开正文确认账号活跃度与项目进展；待下一条公开帖子验证。' : progressValue);
  const currentProgress = /近期帖子不可公开读取|暂无公开正文/u.test(progressBase) && profile
    ? `${progressBase}账号当前约${profile.followers ?? '未知'}名粉丝、累计${profile.posts ?? '未知'}条发帖，暂无法据此计算稳定发帖频率、帖子热度、讨论度或粉丝增长速度。`
    : progressBase;
  const reasonValue = sectionValue(first(focus, ['reason', '综合判断', '判断', '理由']) ?? first(raw, ['conclusion', '综合判断']) ?? focusNarrative, '关注理由', currentProgress);
  const normalizedReason = isTemplateEcho(reasonValue)
    ? (fallbackProject?.profile_summary
      ? `持续观察。公开资料显示该账号围绕${profileDescription || '明确产品主题'}展开，具备清晰的产品叙事线索；但近期公开帖子、真实用户使用和链上交付仍缺少可核验样本，暂不具备高确定性判断。建议优先跟踪下一条公开帖子、产品链接和用户增长变化，严格小仓参与而非重仓。`
      : '持续观察。当前公开资料和有效信号不足，暂不具备高确定性判断；建议继续跟踪近期帖子、产品交付和用户增长，在出现可验证进展前不扩大仓位。')
    : sanitizeNarrative(reasonValue);
  const stage = substantive(first(raw, ['stage', 'status', 'phase', '阶段', '当前阶段']) ?? first(project, ['stage', 'status', 'phase', '阶段', '当前阶段']), '早期公开构建阶段（基于当前可见信号）');
  const normalizedTags = strings(first(raw, ['tags', '标签'])).map(stripSectionPrefix).flatMap((item) => item.split(/[、,，]/u).map((tag) => sanitizeTag(tag)).filter(Boolean));
  const modelProjectName = text(first(project, ['projectName', 'name', 'project', '项目名称', '项目']) ?? (typeof raw.project === 'string' ? raw.project : undefined) ?? first(raw, ['project_name', '项目名称']));
  const projectName = fallbackProject?.display_name?.trim() || modelProjectName || '未命名项目';
  const modelHandle = text(first(project, ['handle', 'xHandle', 'xAccount', 'account', '账号', 'X账号', 'X 账号']) ?? first(raw, ['handle', 'xHandle', 'xAccount', 'account', '账号']));
  const handle = fallbackProject?.current_handle ? `@${fallbackProject.current_handle.replace(/^@/, '')}` : modelHandle || '@unknown';
  return {
    coreInfo: { projectName, handle, summary, stage },
    focusReason: { currentProgress, strengths: normalizedStrengths, weaknesses: normalizedWeaknesses, reason: normalizedReason },
    tags: normalizedTags.length ? normalizedTags : ['早期项目', '待持续验证']
  };
}

function parseReport(textValue: string, fallbackProject?: ProjectRow) {
  const cleaned = textValue.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const candidates: string[] = [];
  if (cleaned) candidates.push(cleaned);
  // Models sometimes append an explanation or emit more than one JSON object.
  // Extract balanced objects instead of relying on first/last brace positions.
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(cleaned.slice(start, index + 1));
          break;
        }
      }
    }
  }
  if (!candidates.length) throw new Error('research output does not contain a JSON object');
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      let nested: unknown = JSON.parse(candidate);
      for (let depth = 0; depth < 4; depth += 1) {
        if (typeof nested === 'string') nested = JSON.parse(nested);
        const current = record(nested);
        const wrapper = ['output', 'data', 'report', 'report_document', 'reportDocument'].find((key) => key in current);
        if (!wrapper) { nested = current; break; }
        nested = current[wrapper];
      }
      const source = record(nested);
      const requiredSections: Array<[string, readonly string[]]> = [
        ['coreInfo', ['coreInfo', 'project', 'project_info', '项目核心信息', '核心信息']],
        ['focusReason', ['focusReason', 'key_focus', 'focus_reason', 'focus', '关注理由', '重点关注理由']],
        ['tags', ['tags', '标签']]
      ];
      const missingSections = requiredSections.filter(([, keys]) => first(source, keys) === undefined).map(([name]) => name);
      if (missingSections.length) throw new Error(`research output missing V${REPORT_TEMPLATE_VERSION} sections: ${missingSections.join(', ')}`);
      return ReportDocumentSchema.parse(normalizeReport(source, fallbackProject));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('research output could not be parsed');
}

const PLACEHOLDER_TEXT = new Set([
  '暂未确认',
  '暂未确认。',
  '暂无项目摘要。',
  '暂未形成综合判断。',
  '暂未完成独立复核。',
  '后续公开进展是关键验证点。',
  '暂无可核验结论。',
  '暂无公开证据，无法确认项目摘要。',
  '暂无明确优势，需继续核实公开交付。',
  '暂无明确缺点，需继续核实公开交付。',
  // Legacy fallbacks emitted by earlier prompt/worker versions. Treat them
  // as empty so a newly normalized report can replace them with a useful
  // evidence-aware statement instead of displaying the old placeholder.
  '公开进展暂未确认，等待后续更新。',
  '当前无法确认知名 Crypto 背书账号或机构背景；现有关注信号仅作为早期线索，不等同于可验证背书。',
  '当前无法确认知名 Crypto 背书账号或机构背景。'
]);

/** Prevent a syntactically valid but empty model response being marked ready. */
function assertReportComplete(report: ReportDocument, evidenceSummary = '', profileSummary = ''): void {
  const failures: string[] = [];
  const meaningful = (value: string): boolean => Boolean(value.trim()) && !PLACEHOLDER_TEXT.has(value.trim()) && !isTemplateEcho(value);
  if (!meaningful(report.coreInfo.summary)) failures.push('coreInfo.summary');
  if (!meaningful(report.focusReason.currentProgress)) failures.push('focusReason.currentProgress');
  if (!meaningful(report.focusReason.reason)) failures.push('focusReason.reason');
  if (!report.focusReason.strengths.some(meaningful)) failures.push('focusReason.strengths');
  if (!report.focusReason.weaknesses.some(meaningful)) failures.push('focusReason.weaknesses');
  const publicText = [report.coreInfo.summary, report.focusReason.currentProgress, ...report.focusReason.strengths, ...report.focusReason.weaknesses, report.focusReason.reason].join('\n');
  if (containsRawTransportMetadata(publicText)) failures.push('raw_transport_metadata');
  const richEvidence = /(?:指标：|账号资料：|用户简介：|浏览\s*\d|点赞\s*\d|粉丝\s*\d|产品|测试网|主网|链上|交付)/u.test(evidenceSummary);
  if (richEvidence) {
    const coverage = `${report.focusReason.strengths.join(' ')} ${report.focusReason.weaknesses.join(' ')}`;
    const markers = new Set(coverage.match(/(?:帖子|浏览|点赞|转发|回复|粉丝|热度|活跃|讨论|增长|交付|链上|用户)/gu) ?? []);
    if (markers.size < 2) failures.push('focusReason.evidence_coverage');
  }
  // When a profile is available, both sides must go beyond copying its bio:
  // strengths need a project fact plus an observable activity/traction fact,
  // while weaknesses need a concrete evidence or delivery gap.
  if (profileSummary) {
    const strengths = report.focusReason.strengths.join(' ');
    const weaknesses = report.focusReason.weaknesses.join(' ');
    const projectFact = /(?:NFT|PFP|社交网络|社区|治理|Launchpad|发射台|meme|链|平台|协议|应用|产品)/iu.test(strengths);
    const tractionFact = /(?:帖子|发帖|浏览|点赞|转发|回复|粉丝|活跃|讨论|增长|用户|交付|链上|测试网|主网|热度)/u.test(strengths);
    const weaknessFact = /(?:缺少|不足|无法确认|不可公开读取|数据缺口|产品演示|链上|交付|用户|活跃|帖子|粉丝|竞争|审计|团队|留存|流动性|验证)/u.test(weaknesses);
    if (!projectFact || !tractionFact) failures.push('focusReason.strengths.comprehensive_evidence');
    if (!weaknessFact) failures.push('focusReason.weaknesses.comprehensive_evidence');
  }
  if (failures.length) throw new Error(`research output incomplete: ${failures.join(', ')}`);
}

function buildEvidenceFallbackReport(project: ProjectRow, signals: SignalRow[]): ReportDocument {
  const rawProfile = project.profile_summary?.trim();
  const profile = rawProfile ? profileFacts(rawProfile) : undefined;
  const description = profile?.description || rawProfile?.replace(/^账号资料：/u, '').trim() || '';
  const profileLower = description.toLowerCase();
  const accountMetrics = profile && (profile.followers !== undefined || profile.posts !== undefined)
    ? `账号当前约${profile.followers ?? '未知'}名粉丝、累计${profile.posts ?? '未知'}条发帖`
    : '账号粉丝与发帖规模暂无公开证据';
  const tweets = signals.filter((signal) => signal.type === 'new_tweet' && signal.content?.trim());
  const latest = tweets[0];
  const summary = description
    ? `${project.display_name || project.current_handle} (@${project.current_handle.replace(/^@/, '')}) 定位为${description}；该定位体现了明确的产品对象与参与线索，但当前尚缺少足够的公开帖子、产品演示和链上交付信息，具体机制、用户路径、收入结构与后续窗口仍需继续核验。`
    : `${project.display_name || project.current_handle} (@${project.current_handle.replace(/^@/, '')}) 的公开定位资料有限，暂无法确认具体产品机制和参与方式；后续需结合账号近期帖子、官方链接和实际交付进一步判断。`;
  const progress = latest
    ? `最近可见帖子发表于 ${latest.occurred_at}，内容为“${latest.content!.trim().slice(0, 260)}”；当前仅能依据该样本判断账号仍有公开活动，帖子热度、讨论质量和粉丝增长需要更多连续样本验证。`
    : `最近帖子不可公开读取/暂无公开正文；${accountMetrics}，因此无法可靠计算近期发帖频率、帖子热度、讨论度和粉丝增长速度，待下一条公开帖子验证。`;
  const reason = description
    ? `持续观察。公开定位显示项目围绕${description}展开，具备可继续验证的产品叙事；但${accountMetrics}，且当前缺少近期公开帖子、真实用户使用和链上交付证据，暂不具备高确定性判断。建议优先跟踪下一条公开帖子、产品链接、用户增长与可验证交付，严格小仓参与而非重仓。`
    : '持续观察。当前公开资料和有效信号不足，暂不具备高确定性判断；建议继续跟踪近期帖子、产品交付和用户增长，在出现可验证进展前不扩大仓位。';
  const tags = [
    /launchpad|launch pad|发射台|代币发射/iu.test(profileLower) || /\.fun$/iu.test(project.current_handle) ? 'Launchpad' : '',
    /nft|pfp|数字藏品|收藏品/iu.test(profileLower) ? 'NFT / 游戏' : '',
    /meme/iu.test(profileLower) ? 'Meme' : '',
    /base/iu.test(profileLower) ? 'Base' : '',
    /solana/iu.test(profileLower) ? 'Solana' : '',
    /治理|governance|投票|vote/iu.test(profileLower) ? '社区治理' : '',
    '早期项目', '待持续验证'
  ].filter(Boolean).slice(0, 8);
  return {
    coreInfo: { projectName: project.display_name || project.current_handle, handle: `@${project.current_handle.replace(/^@/, '')}`, summary, stage: '早期公开构建阶段（基于当前可见信号）' },
    focusReason: {
      currentProgress: progress,
      strengths: [description ? `公开定位围绕${description}形成了明确的产品对象和用户参与线索，降低了早期理解成本并具备一定传播辨识度；${accountMetrics}，若后续帖子能够证明产品演示、真实用户参与或链上交付，该方向可能形成早期流量与短期投机窗口，当前优势仍以低成本跟踪价值为主。` : '账号围绕一个明确主题或产品方向展开；若后续出现可验证交付与用户反馈，可能形成早期差异化。'],
      weaknesses: [description ? `现有证据仍主要来自公开定位，${accountMetrics}，近期帖子正文、产品演示、链上数据和真实用户反馈不足；这会限制对团队执行力、产品留存与流动性的判断，若后续继续缺少连续更新或可验证使用记录，叙事落空风险会放大，需核对产品链接、帖子热度、用户增长和链上活动。` : '公开资料、推文细节或用户数据仍有限，部分判断需要后续公开证据验证。', '交付验证风险：尚未形成足够的产品使用、链上活动或持续更新记录，项目持续性仍需跟踪。'],
      reason
    },
    tags
  };
}

function signalExcerpt(signal: SignalRow): string {
  const count = signal.common_follow_count == null ? '' : `共同关注 ${signal.common_follow_count} 人。`;
  const data = record(signal.data);
  const targetUser = record(data.follow_user);
  const contentCandidates = [data, record(data.tweet), record(data.status), record(data.post), record(data.metrics)];
  // In Alpha new_follower/common-follow payloads `user` is the caller who
  // followed the project, while `follow_user` is the target project itself.
  // Never present caller followers as project metrics.
  const candidates = signal.type === 'common_follow'
    ? [...contentCandidates, targetUser]
    : [...contentCandidates, targetUser, record(data.user), record(data.author)];
  const labels: Array<[string, string[]]> = [
    ['浏览', ['views', 'view_count', 'impression_count', 'impressions']],
    ['点赞', ['likes', 'like_count', 'favorite_count', 'favorites']],
    ['转发', ['retweets', 'retweet_count', 'reposts', 'repost_count']],
    ['回复', ['replies', 'reply_count', 'comment_count']],
    ['引用', ['quotes', 'quote_count']],
    ['粉丝', ['followers', 'followers_count', 'follower_count']]
  ];
  const metrics = labels.flatMap(([label, keys]) => {
    for (const candidate of candidates) {
      for (const key of keys) {
        const value = candidate[key];
        if ((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim())) return `${label} ${value}`;
      }
    }
    return [];
  });
  const metricText = metrics.length ? `指标：${metrics.join('，')}。` : '';
  const profile = profileExcerpt(signal);
  return `时间：${signal.occurred_at}。${count}${metricText}${profile}${signal.content?.trim() || `Alpha 信号类型：${signal.type}`}`.slice(0, 1200);
}

function profileExcerpt(signal: SignalRow): string {
  const data = record(signal.data);
  const candidates = [record(data.follow_user), record(data.user), record(data.author), record(data.account)];
  const profile = candidates.find((candidate) => Object.keys(candidate).length > 0);
  if (!profile) return '';
  const handle = text(profile.screen_name ?? profile.username ?? profile.handle);
  const description = text(profile.description ?? profile.bio);
  const followers = profile.followers_count ?? profile.followers;
  const posts = profile.statuses_count ?? profile.posts_count ?? profile.tweets_count;
  const pieces = [handle ? `账号 @${handle}` : '账号资料', description ? `简介：${description}` : '', followers != null ? `粉丝 ${followers}` : '', posts != null ? `发帖 ${posts}` : ''].filter(Boolean);
  return pieces.length ? `账号资料：${pieces.join('；')}。` : '';
}

function profileSummary(signals: SignalRow[]): string {
  for (const signal of signals) {
    const excerpt = profileExcerpt(signal);
    if (excerpt) return excerpt;
  }
  return '';
}

function evidenceHash(signal: SignalRow, excerpt: string): string {
  return createHash('sha256').update(`${signal.id}:${excerpt}`).digest('hex');
}

async function ensureEvidence(database: JobDatabase, project: ProjectRow, signals: SignalRow[]): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = [];
  const profileUrl = project.current_handle ? `https://x.com/${project.current_handle.replace(/^@/, '')}` : `https://x.com/i/user/${project.id}`;
  for (const signal of signals) {
    const excerpt = signalExcerpt(signal);
    const contentHash = evidenceHash(signal, excerpt);
    const url = signal.x_post_url || profileUrl;
    const inserted = await database.query<EvidenceRow>(
      `insert into evidence (project_id, signal_id, source_type, url, title, excerpt, content_hash, metadata)
       values ($1, $2, 'alpha', $3, $4, $5, $6, $7::jsonb)
       on conflict (project_id, content_hash) do update set excerpt = excluded.excerpt
       returning id, signal_id, url, excerpt, content_hash`,
      [project.id, signal.id, url, `Alpha ${signal.type} 信号`, excerpt, contentHash, JSON.stringify({ occurredAt: signal.occurred_at })]
    );
    if (inserted.rows[0]) rows.push(inserted.rows[0]);
  }
  return rows;
}

async function ensureCitationEvidence(database: JobDatabase, project: ProjectRow, citations: readonly string[]): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = [];
  for (const citation of [...new Set(citations)].slice(0, 20)) {
    let url: URL;
    try { url = new URL(citation); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const excerpt = 'Grok X Search 返回的公开资料引用。';
    const contentHash = createHash('sha256').update(`grok-x-search:${url.toString()}`).digest('hex');
    const sourceType = /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(url.hostname) ? 'x' : 'official_web';
    const inserted = await database.query<EvidenceRow>(
      `insert into evidence (project_id, signal_id, source_type, url, title, excerpt, content_hash, metadata)
       values ($1, null, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (project_id, content_hash) do update set title = excluded.title, excerpt = excluded.excerpt
       returning id, signal_id, url, excerpt, content_hash`,
      [project.id, sourceType, url.toString(), 'Grok X Search 引用', excerpt, contentHash, JSON.stringify({ source: 'grok_x_search' })]
    );
    if (inserted.rows[0]) rows.push(inserted.rows[0]);
  }
  return rows;
}

async function ensureReportVersion(database: JobDatabase, projectId: string, triggerSignalId: string | null): Promise<ReportVersionRow> {
  const latest = await database.query<ReportVersionRow>(
    `select id, version, status from report_versions where project_id = $1 and version >= ${REPORT_TEMPLATE_VERSION} order by version desc limit 1`,
    [projectId]
  );
  if (latest.rows[0] && ['queued', 'collecting', 'generating'].includes(latest.rows[0].status)) return latest.rows[0];
  // V3 is the first valid report template. Numeric versions after that are
  // immutable internal revisions of the V3 document, never a return to V1/V2.
  const version = Math.max(latest.rows[0]?.version ?? REPORT_TEMPLATE_VERSION - 1, REPORT_TEMPLATE_VERSION - 1) + 1;
  const inserted = await database.query<ReportVersionRow>(
    `insert into report_versions (project_id, version, trigger_signal_id, status)
     values ($1, $2, $3, 'queued') returning id, version, status`,
    [projectId, version, triggerSignalId]
  );
  if (!inserted.rows[0]) throw new Error('report version insert returned no row');
  return inserted.rows[0];
}

/** Generates a readable report only after the project has passed AI screening. */
export function createResearchProjectHandler(database: JobDatabase, router: AiProviderRouter) {
  return async (job: JobRecord): Promise<void> => {
    const { projectId, triggerSignalId } = parsePayload(job);
    const projectResult = await database.query<ProjectRow>(
      `select p.id, p.current_handle, p.display_name, p.status
       from projects p
       where p.id = $1 and p.status <> 'excluded'
         and exists (
           select 1 from screening_decisions sd
           where sd.project_id = p.id
             and sd.decision in ('allowed', 'manual_allowed')
              and sd.account_type not in ('KOL', 'PERSONAL', 'DEV', 'MEDIA', 'TRADFI', 'CORPORATE', 'CAPITAL', 'CHAIN', 'EXCHANGE', 'FOUNDATION', 'AFFILIATE')
             and sd.created_at = (select max(sd2.created_at) from screening_decisions sd2 where sd2.project_id = p.id)
         )`,
      [projectId]
    );
    // A project can be excluded while a queued research job is waiting. Treat
    // that as a successful no-op so it is never retried or analyzed.
    const project = projectResult.rows[0];
    if (!project) return;

    const signals = (await database.query<SignalRow>(
      `select id, type, occurred_at, common_follow_count, x_post_url, content, data
       from signals where project_id = $1 order by occurred_at desc, id desc limit 12`,
      [projectId]
    )).rows;
    // Signal jobs are immutable and uniquely keyed. When several pushes arrive
    // before research catches up, only the newest job should call the model;
    // older jobs become successful no-ops instead of producing stale versions.
    if (triggerSignalId && signals[0]?.id !== triggerSignalId) return;
    const enrichedProject: ProjectRow = { ...project, profile_summary: profileSummary(signals), evidence_summary: signals.map(signalExcerpt).join('；').slice(0, 1800) };
    const evidence = await ensureEvidence(database, project, signals);
    const version = await ensureReportVersion(database, projectId, signals[0]?.id ?? null);
    await database.query(`update report_versions set status = 'collecting' where id = $1`, [version.id]);
    try {
      await database.query(`update report_versions set status = 'generating' where id = $1`, [version.id]);
      const prompt = buildResearchReportPrompt({
        project: { name: project.display_name || project.current_handle, handle: project.current_handle, summary: enrichedProject.profile_summary || undefined },
        signals: signals.map((signal) => `${signal.id}｜${signalExcerpt(signal)}`),
        evidence: evidence.map((item) => `${item.id}｜${item.excerpt}｜来源：${item.url}`)
      });
      let completion: Awaited<ReturnType<AiProviderRouter['complete']>> | undefined;
      let report: ReportDocument;
      let fallbackError: string | undefined;
      try {
        completion = await router.complete({ purpose: 'research', system: prompt.system, user: prompt.user, schema: 'ReportDocumentSchema' });
        try {
          report = parseReport(completion.response.text, enrichedProject);
          assertReportComplete(report, enrichedProject.evidence_summary, enrichedProject.profile_summary);
        } catch (firstError) {
          // A few relays return a valid JSON skeleton after tool use. Ask once
          // more with an explicit completeness constraint before using evidence fallback.
          completion = await router.complete({
            purpose: 'research',
            system: `${prompt.system}\n不得输出占位值。每个字段必须给出基于搜索或信号的具体判断；若没有证据，写明“暂无公开证据”并解释原因。`,
            user: `${prompt.user}\n上一次输出不完整（${firstError instanceof Error ? firstError.message : '字段缺失'}）。请重新补齐 1-6 节可读中文正文，每节都要有具体事实、判断和不确定性。顶层仍只能输出 coreInfo、focusReason、tags，禁止输出核心论点、参与玩法、六赛道、独立复核、评分或风险证据链字段。`,
            schema: 'ReportDocumentSchema'
          });
          report = parseReport(completion.response.text, enrichedProject);
          assertReportComplete(report, enrichedProject.evidence_summary, enrichedProject.profile_summary);
        }
      } catch (error) {
        fallbackError = error instanceof Error ? error.message : String(error);
        report = buildEvidenceFallbackReport(enrichedProject, signals);
        assertReportComplete(report, enrichedProject.evidence_summary, enrichedProject.profile_summary);
      }
      const citationEvidence = await ensureCitationEvidence(database, project, completion?.response.citations ?? []);
      const markdown = renderReportMarkdown(report);
      await database.query(
        `update report_versions
         set status = 'ready', structured_document = $2::jsonb, rendered_markdown = $3,
             change_summary = $4::jsonb, completed_at = now()
         where id = $1`,
        [version.id, JSON.stringify(report), markdown, JSON.stringify(completion ? { provider: completion.provider.name, model: completion.response.model, xSearchCitations: citationEvidence.length } : { source: 'evidence_fallback', error: fallbackError, xSearchCitations: 0 })]
      );
      await new OutboxStore(database).append({
        type: 'report.ready', aggregateType: 'project', aggregateId: projectId, version: version.version,
        payload: { projectId, reportVersionId: version.id, version: version.version },
        idempotencyKey: `report:${version.id}:ready`
      });
    } catch (error) {
      await database.query(
        `update report_versions set status = 'failed', change_summary = $2::jsonb, completed_at = now() where id = $1`,
        [version.id, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })]
      );
      await new OutboxStore(database).append({
        type: 'report.failed', aggregateType: 'project', aggregateId: projectId, version: version.version,
        payload: { projectId, reportVersionId: version.id, version: version.version },
        idempotencyKey: `report:${version.id}:failed`
      });
      throw error;
    }
  };
}
