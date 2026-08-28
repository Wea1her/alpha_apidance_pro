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

interface ResearchProjectPayload { projectId: string; }
interface ProjectRow { id: string; current_handle: string; display_name: string; status: string; profile_summary?: string; }
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
function normalizeReport(raw: Record<string, unknown>, fallbackProject?: ProjectRow) {
  const projectValue = first(raw, ['project', 'coreInfo', 'project_info', '项目核心信息', '核心信息']);
  const project = typeof projectValue === 'string' ? {} : record(projectValue);
  const focus = record(first(raw, ['focusReason', 'key_focus', 'focus_reason', 'focus', '关注理由', '重点关注理由']));
  const focusNarrative = typeof first(raw, ['focusReason', 'focus']) === 'string' ? stripSectionPrefix(text(first(raw, ['focusReason', 'focus']))) : '';
  const summaryCandidate = first(raw, ['abstract', 'summary', 'description', '项目摘要', '项目描述']) ?? first(project, ['summary', 'abstract', 'description', '摘要', '项目摘要', '项目描述']);
  const summaryValue = sectionValue(summaryCandidate, '项目核心信息', fallbackProject?.profile_summary ? `公开简介显示${fallbackProject.profile_summary}；具体产品机制、用户参与方式和当前交付仍需结合近期帖子核验。` : '公开定位资料不足，暂无法确认具体产品机制和参与方式。');
  const summary = isTemplateEcho(summaryValue)
    ? (fallbackProject?.profile_summary ? `公开简介显示${fallbackProject.profile_summary}；具体产品机制、用户参与方式和当前交付仍需结合近期帖子核验。` : '公开定位资料不足，暂无法确认具体产品机制和参与方式；后续需结合账号近期帖子、官方链接和实际交付进一步判断。')
    : summaryValue;
  const rawStrengths = strings(first(focus, ['strengths', 'advantages', '优点', '优势'])).map((item) => sectionValue(item, '优点')).filter((item) => item && !isTemplateEcho(item) && !/暂无(?:明确)?优势|暂无正向证据/u.test(item));
  const rawWeaknesses = strings(first(focus, ['weaknesses', 'risks', '缺点', '不足'])).map((item) => sectionValue(item, '缺点')).filter((item) => item && !isTemplateEcho(item) && !/暂无(?:明确)?缺点|暂无负向证据/u.test(item));
  const normalizedStrengths = rawStrengths.length ? rawStrengths : [fallbackProject?.profile_summary ? `公开简介已明确提出${fallbackProject.profile_summary}，说明账号至少形成了清晰的产品叙事和目标用户方向；若近期帖子能证明真实交付或用户参与，该定位具备早期传播与试错价值。` : '当前仅能确认账号围绕一个明确主题或产品方向展开；若后续出现可验证交付与用户反馈，可能形成早期差异化。'];
  const normalizedWeaknesses = rawWeaknesses.length ? rawWeaknesses : [fallbackProject?.profile_summary ? `公开资料目前主要停留在简介层面（${fallbackProject.profile_summary}），缺少产品演示、链上数据和持续更新证据，落地能力与用户留存仍无法确认；需要核对近期帖子、产品链接和实际使用记录。` : '公开资料、推文细节或用户数据仍有限，部分判断需要后续公开证据验证。', '交付验证风险：尚未形成足够的产品使用、链上活动或持续更新记录，项目持续性仍需跟踪。'];
  const progressValue = sectionValue(first(focus, ['currentProgress', 'current_progress', '当前进展', '进展']), '当前进展', focusNarrative || text(first(raw, ['monitor', '当前进展']), '当前进展依据有限，需继续跟踪公开交付。'));
  const currentProgress = sanitizeCurrentProgress(isTemplateEcho(progressValue) ? '近期帖子不可公开读取，暂无法从公开正文确认账号活跃度与项目进展；待下一条公开帖子验证。' : progressValue);
  const reasonValue = sectionValue(first(focus, ['reason', '综合判断', '判断', '理由']) ?? first(raw, ['conclusion', '综合判断']) ?? focusNarrative, '关注理由', currentProgress);
  const normalizedReason = isTemplateEcho(reasonValue)
    ? (fallbackProject?.profile_summary
      ? `持续观察。账号简介显示${fallbackProject.profile_summary}，具备明确的产品叙事线索；但近期公开帖子、真实用户使用和链上交付仍缺少可核验样本，暂不具备高确定性判断。建议优先跟踪下一条公开帖子、产品链接和用户增长变化，严格小仓参与而非重仓。`
      : '持续观察。当前公开资料和有效信号不足，暂不具备高确定性判断；建议继续跟踪近期帖子、产品交付和用户增长，在出现可验证进展前不扩大仓位。')
    : reasonValue;
  const stage = substantive(first(raw, ['stage', 'status', 'phase', '阶段', '当前阶段']) ?? first(project, ['stage', 'status', 'phase', '阶段', '当前阶段']), '早期公开构建阶段（基于当前可见信号）');
  const normalizedTags = strings(first(raw, ['tags', '标签'])).map(stripSectionPrefix).flatMap((item) => item.split(/[、,，]/u).map((tag) => tag.trim()).filter(Boolean));
  return {
    coreInfo: { projectName: text(first(project, ['projectName', 'name', 'project', '项目名称', '项目']) ?? (typeof raw.project === 'string' ? raw.project : undefined) ?? first(raw, ['project_name', '项目名称']) ?? fallbackProject?.display_name, '未命名项目'), handle: text(first(project, ['handle', 'xHandle', 'xAccount', 'account', '账号', 'X账号', 'X 账号']) ?? first(raw, ['handle', 'xHandle', 'xAccount', 'account', '账号']), fallbackProject?.current_handle ? `@${fallbackProject.current_handle.replace(/^@/, '')}` : '@unknown'), summary, stage },
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
function assertReportComplete(report: ReportDocument): void {
  const failures: string[] = [];
  const meaningful = (value: string): boolean => Boolean(value.trim()) && !PLACEHOLDER_TEXT.has(value.trim()) && !isTemplateEcho(value);
  if (!meaningful(report.coreInfo.summary)) failures.push('coreInfo.summary');
  if (!meaningful(report.focusReason.currentProgress)) failures.push('focusReason.currentProgress');
  if (!meaningful(report.focusReason.reason)) failures.push('focusReason.reason');
  if (!report.focusReason.strengths.some(meaningful)) failures.push('focusReason.strengths');
  if (!report.focusReason.weaknesses.some(meaningful)) failures.push('focusReason.weaknesses');
  if (failures.length) throw new Error(`research output incomplete: ${failures.join(', ')}`);
}

function signalExcerpt(signal: SignalRow): string {
  const count = signal.common_follow_count == null ? '' : `共同关注 ${signal.common_follow_count} 人。`;
  const data = record(signal.data);
  const candidates = [data, record(data.tweet), record(data.status), record(data.post), record(data.metrics), record(data.user), record(data.author)];
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
    const { projectId } = parsePayload(job);
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
       from signals where project_id = $1 order by occurred_at desc limit 12`,
      [projectId]
    )).rows;
    const enrichedProject: ProjectRow = { ...project, profile_summary: profileSummary(signals) };
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
      let completion = await router.complete({ purpose: 'research', system: prompt.system, user: prompt.user, schema: 'ReportDocumentSchema' });
      let report: ReportDocument;
      try {
        report = parseReport(completion.response.text, enrichedProject);
        assertReportComplete(report);
      } catch (firstError) {
        // A few relays return a valid JSON skeleton after tool use. Ask once
        // more with an explicit completeness constraint before failing the job.
        completion = await router.complete({
          purpose: 'research',
          system: `${prompt.system}\n不得输出占位值。每个字段必须给出基于搜索或信号的具体判断；若没有证据，写明“暂无公开证据”并解释原因。`,
          user: `${prompt.user}\n上一次输出不完整（${firstError instanceof Error ? firstError.message : '字段缺失'}）。请重新补齐 1-6 节可读中文正文，每节都要有具体事实、判断和不确定性。顶层仍只能输出 coreInfo、focusReason、tags，禁止输出核心论点、参与玩法、六赛道、独立复核、评分或风险证据链字段。`,
          schema: 'ReportDocumentSchema'
        });
        report = parseReport(completion.response.text, enrichedProject);
        assertReportComplete(report);
      }
      const citationEvidence = await ensureCitationEvidence(database, project, completion.response.citations ?? []);
      const markdown = renderReportMarkdown(report);
      await database.query(
        `update report_versions
         set status = 'ready', structured_document = $2::jsonb, rendered_markdown = $3,
             change_summary = $4::jsonb, completed_at = now()
         where id = $1`,
        [version.id, JSON.stringify(report), markdown, JSON.stringify({ provider: completion.provider.name, model: completion.response.model, xSearchCitations: citationEvidence.length })]
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
