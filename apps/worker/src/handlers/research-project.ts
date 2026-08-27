import { createHash } from 'node:crypto';
import {
  AiProviderRouter,
  buildResearchReportPrompt,
  renderReportMarkdown,
  ReportDocumentSchema,
  type ReportDocument,
  validateEvidenceReferences
} from '@alpha-research/ai';
import { OutboxStore, type JobDatabase, type JobRecord } from '@alpha-research/db';

interface ResearchProjectPayload { projectId: string; }
interface ProjectRow { id: string; current_handle: string; display_name: string; status: string; }
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

const TRACK_KEYS = ['product', 'technology', 'team', 'market', 'tokenomics', 'catalysts'] as const;
const TRACK_TITLES: Record<(typeof TRACK_KEYS)[number], string> = {
  product: '产品与需求', technology: '技术与交付', team: '团队与执行', market: '市场与生态', tokenomics: '代币与激励', catalysts: '催化剂与风险'
};

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, fallback = ''): string { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
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
function trackKey(value: unknown): (typeof TRACK_KEYS)[number] | null {
  const normalized = text(value).toLowerCase();
  if (TRACK_KEYS.includes(normalized as (typeof TRACK_KEYS)[number])) return normalized as (typeof TRACK_KEYS)[number];
  const map: Record<string, (typeof TRACK_KEYS)[number]> = { '产品与需求': 'product', '技术与交付': 'technology', '团队与执行': 'team', '市场与生态': 'market', '代币与激励': 'tokenomics', '催化剂与风险': 'catalysts', 'product': 'product', 'technology': 'technology', 'team': 'team', 'market': 'market', 'tokenomics': 'tokenomics', 'catalysts': 'catalysts' };
  return map[normalized] ?? null;
}

function normalizedEvidence(value: unknown, evidenceIds: readonly string[]) {
  const item = record(value);
  const candidate = text(item.evidenceId ?? item.evidence_id ?? item.id ?? (typeof value === 'string' ? value : ''));
  const evidenceId = evidenceIds.includes(candidate) ? candidate : evidenceIds[0];
  if (!evidenceId) return [];
  return [{ evidenceId, claim: text(item.claim ?? item.summary ?? (typeof value === 'string' && !value.match(/^[0-9a-f-]{36}$/i) ? value : ''), 'Alpha 已收到相关信号。'), ...(text(item.sourceUrl ?? item.source_url) ? { sourceUrl: text(item.sourceUrl ?? item.source_url) } : {}) }];
}

function normalizeReport(raw: Record<string, unknown>, evidenceIds: readonly string[], fallbackProject?: ProjectRow) {
  const projectValue = first(raw, ['project', 'coreInfo', 'project_info', '项目核心信息', '核心信息']);
  const project = typeof projectValue === 'string' ? {} : record(projectValue);
  const focus = record(first(raw, ['focusReason', 'key_focus', 'focus_reason', 'focus', '关注理由', '重点关注理由']));
  const review = record(first(raw, ['independentReview', 'independent_review', 'review', '独立复核轮', '独立复核', '证伪检查']));
  const scoreValue = first(raw, ['score', 'scores', '评分总览', '评分']);
  const scores = typeof scoreValue === 'number' ? { overall: scoreValue } : record(scoreValue);
  const trackValue = first(raw, ['l2Tracks', 'six_tracks', 'lanes', '六赛道', 'L2六赛道', 'L2 六赛道深挖', '赛道']);
  const rawTracks = Array.isArray(trackValue)
    ? trackValue
    : Object.entries(record(trackValue)).map(([key, value]) => ({ key, ...record(value) }));
  const globalEvidence = strings(first(raw, ['evidence_ids', 'evidenceIds', 'evidence', '证据ID', '证据编号'])).flatMap((item) => normalizedEvidence(item, evidenceIds));
  const tracks = TRACK_KEYS.map((key) => {
    const source = rawTracks.map(record).find((item) => trackKey(first(item, ['key', 'track', 'title', 'name', '赛道', '名称'])) === key)
      ?? record(rawTracks[TRACK_KEYS.indexOf(key)]);
    const evidenceValue = first(source, ['evidence', '证据', 'evidence_chain', '证据链']);
    const evidence = Array.isArray(evidenceValue) ? evidenceValue.flatMap((item) => normalizedEvidence(item, evidenceIds)) : globalEvidence;
    const findings = strings(first(source, ['findings', 'key_findings', 'points', 'analysis', '发现', '要点', '关键发现']));
    return { key, title: TRACK_TITLES[key], score: Math.max(0, Math.min(10, Number(first(source, ['score', 'rating', '评分'])) || 0)), summary: text(first(source, ['summary', 'assessment', 'conclusion', '总结', '判断', '结论', '分析']), '暂未确认。'), findings: findings.slice(0, 8).concat(findings.length ? [] : ['暂无可核验结论。']), evidence };
  });
  const reviewEvidenceValue = first(review, ['evidence', '证据', '证据链']);
  const reviewEvidence = Array.isArray(reviewEvidenceValue) ? reviewEvidenceValue.flatMap((item) => normalizedEvidence(item, evidenceIds)) : globalEvidence;
  const riskValue = first(raw, ['risksEvidence', 'not_include', '风险与证据链', '风险证据']);
  const riskItems = Array.isArray(riskValue) ? riskValue : [];
  const monitorValue = first(raw, ['monitor', '监控']);
  const playbookValue = first(raw, ['playbook', '参与玩法', '玩法', '参与方式']) ?? first(record(monitorValue), ['steps', 'actions', '步骤', '行动']);
  return {
    coreInfo: { projectName: text(first(project, ['projectName', 'name', '项目名称', '项目']) ?? (typeof raw.project === 'string' ? raw.project : undefined) ?? first(raw, ['project_name', '项目名称']) ?? fallbackProject?.display_name, '未命名项目'), handle: text(first(project, ['handle', '账号', 'X账号', 'X 账号']) ?? first(raw, ['handle', '账号']), fallbackProject?.current_handle ? `@${fallbackProject.current_handle.replace(/^@/, '')}` : '@unknown'), summary: text(first(raw, ['abstract', 'summary', 'description', '项目摘要', '项目描述']) ?? first(project, ['summary', 'abstract', 'description', '摘要', '项目摘要', '项目描述']), '暂无项目摘要。'), stage: text(first(raw, ['stage', 'status', 'phase', '阶段', '当前阶段']) ?? first(project, ['stage', 'status', 'phase', '阶段', '当前阶段']), '暂未确认') },
    focusReason: { currentProgress: text(first(focus, ['currentProgress', 'current_progress', '当前进展', '进展']) ?? first(raw, ['monitor', '当前进展']), '暂未确认。'), strengths: strings(first(focus, ['strengths', 'advantages', '优点', '优势'])), weaknesses: strings(first(focus, ['weaknesses', 'risks', '缺点', '不足'])), reason: text(first(focus, ['reason', '综合判断', '判断', '理由']) ?? first(raw, ['conclusion', '综合判断']), '暂未形成综合判断。') },
    tags: strings(first(raw, ['tags', '标签'])).length ? strings(first(raw, ['tags', '标签'])) : ['待分类'],
    thesis: strings(first(raw, ['thesis', 'key_focus', '观点', '核心观点', '核心论点', '论点'])).length ? strings(first(raw, ['thesis', 'key_focus', '观点', '核心观点', '核心论点', '论点'])) : ['后续公开进展是关键验证点。'],
    playbook: strings(playbookValue),
    l2Tracks: tracks,
    independentReview: { status: ['passed', 'challenged', 'failed'].includes(text(first(review, ['status', '状态']))) ? text(first(review, ['status', '状态'])) : 'challenged', hypotheses: strings(first(review, ['hypotheses', 'hypotheses_to_test', '假设', '待证伪假设'])).concat(strings(first(review, ['hypotheses', 'hypotheses_to_test', '假设', '待证伪假设'])).length ? [] : ['项目将继续推进并产生可验证进展。']), falsificationChecks: strings(first(review, ['falsificationChecks', 'falsification_checks', 'checks', '证伪检查项', '检查项'])).concat(strings(first(review, ['falsificationChecks', 'falsification_checks', 'checks', '证伪检查项', '检查项'])).length ? [] : ['检查后续版本、官方公告和实际使用情况。']), counterEvidence: strings(first(review, ['counterEvidence', 'counter_evidence', '反证', '反面证据'])), conclusion: text(first(review, ['conclusion', '结论']), '暂未完成独立复核。'), evidence: reviewEvidence },
    score: { overall: Math.max(0, Math.min(100, Number(first(scores, ['overall', 'total', '总分'])) || 0)), confidence: Math.max(0, Math.min(1, Number(first(scores, ['confidence', '置信度'])) || 0.3)), verdict: ['重点关注', '持续观察', '暂不纳入'].includes(text(first(scores, ['verdict', '判断']))) ? text(first(scores, ['verdict', '判断'])) : '持续观察', dimensions: TRACK_KEYS.map((key) => ({ key, score: tracks.find((track) => track.key === key)?.score ?? 0, rationale: tracks.find((track) => track.key === key)?.summary ?? '暂未确认。' })) },
    risksEvidence: riskItems.map((item) => { const value = record(item); return { risk: text(value.risk ?? value.reason ?? value, '待核实风险'), evidence: Array.isArray(value.evidence) ? value.evidence.flatMap((entry) => normalizedEvidence(entry, evidenceIds)) : [] }; })
  };
}

function parseReport(textValue: string, evidenceIds: readonly string[], fallbackProject?: ProjectRow) {
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
      return ReportDocumentSchema.parse(normalizeReport(record(nested), evidenceIds, fallbackProject));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('research output could not be parsed');
}

const PLACEHOLDER_TEXT = new Set(['暂未确认', '暂未确认。', '暂无项目摘要。', '暂未形成综合判断。', '暂未完成独立复核。', '后续公开进展是关键验证点。', '暂无可核验结论。']);

/** Prevent a syntactically valid but empty model response being marked ready. */
function assertReportComplete(report: ReportDocument): void {
  const failures: string[] = [];
  const meaningful = (value: string): boolean => Boolean(value.trim()) && !PLACEHOLDER_TEXT.has(value.trim());
  if (!meaningful(report.coreInfo.summary)) failures.push('coreInfo.summary');
  if (!meaningful(report.coreInfo.stage)) failures.push('coreInfo.stage');
  if (!meaningful(report.focusReason.currentProgress)) failures.push('focusReason.currentProgress');
  if (!meaningful(report.focusReason.reason)) failures.push('focusReason.reason');
  if (!report.focusReason.strengths.some(meaningful)) failures.push('focusReason.strengths');
  if (!report.focusReason.weaknesses.some(meaningful)) failures.push('focusReason.weaknesses');
  if (!report.thesis.some(meaningful)) failures.push('thesis');
  if (!report.playbook.some(meaningful)) failures.push('playbook');
  if (report.l2Tracks.some((track) => track.score <= 0 || !meaningful(track.summary) || !track.findings.some(meaningful))) failures.push('l2Tracks');
  if (!meaningful(report.independentReview.conclusion)) failures.push('independentReview.conclusion');
  if (report.score.overall <= 0 || report.score.dimensions.some((dimension) => dimension.score <= 0 || !meaningful(dimension.rationale))) failures.push('score');
  if (failures.length) throw new Error(`research output incomplete: ${failures.join(', ')}`);
}

function signalExcerpt(signal: SignalRow): string {
  const count = signal.common_follow_count == null ? '' : `共同关注 ${signal.common_follow_count} 人。`;
  return `${count}${signal.content?.trim() || `Alpha 信号类型：${signal.type}`}`.slice(0, 600);
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
    `select id, version, status from report_versions where project_id = $1 order by version desc limit 1`,
    [projectId]
  );
  if (latest.rows[0] && ['queued', 'collecting', 'generating'].includes(latest.rows[0].status)) return latest.rows[0];
  const version = (latest.rows[0]?.version ?? 0) + 1;
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
         and exists (select 1 from screening_decisions sd where sd.project_id = p.id and sd.decision in ('allowed', 'manual_allowed'))`,
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
    const evidence = await ensureEvidence(database, project, signals);
    const version = await ensureReportVersion(database, projectId, signals[0]?.id ?? null);
    await database.query(`update report_versions set status = 'collecting' where id = $1`, [version.id]);
    try {
      await database.query(`update report_versions set status = 'generating' where id = $1`, [version.id]);
      const prompt = buildResearchReportPrompt({
        project: { name: project.display_name || project.current_handle, handle: project.current_handle },
        signals: signals.map((signal) => `${signal.id}｜${signalExcerpt(signal)}`),
        evidence: evidence.map((item) => `${item.id}｜${item.excerpt}｜来源：${item.url}`)
      });
      let completion = await router.complete({ purpose: 'research', system: prompt.system, user: prompt.user, schema: 'ReportDocumentSchema' });
      let report: ReportDocument;
      try {
        report = parseReport(completion.response.text, evidence.map((item) => item.id), project);
        assertReportComplete(report);
      } catch (firstError) {
        // A few relays return a valid JSON skeleton after tool use. Ask once
        // more with an explicit completeness constraint before failing the job.
        completion = await router.complete({
          purpose: 'research',
          system: `${prompt.system}\n不得输出占位值。每个字段必须给出基于搜索或信号的具体判断；若没有证据，写明“暂无公开证据”并解释原因。`,
          user: `${prompt.user}\n上一次输出不完整（${firstError instanceof Error ? firstError.message : '字段缺失'}）。请重新输出完整六赛道、评分、论点、玩法、风险和独立复核 JSON。`,
          schema: 'ReportDocumentSchema'
        });
        report = parseReport(completion.response.text, evidence.map((item) => item.id), project);
        assertReportComplete(report);
      }
      const citationEvidence = await ensureCitationEvidence(database, project, completion.response.citations ?? []);
      const allEvidence = [...evidence, ...citationEvidence];
      // Citation evidence is appended after parsing; validate again against
      // the final evidence set before persisting the readable document.
      const citedReport = citationEvidence.length ? {
        ...report,
        l2Tracks: report.l2Tracks.map((track, index) => index === 0 ? { ...track, evidence: [...track.evidence, ...citationEvidence.map((item) => ({ evidenceId: item.id, claim: 'Grok X Search 公开资料引用。', sourceUrl: item.url }))] } : track),
        independentReview: { ...report.independentReview, evidence: [...report.independentReview.evidence, ...citationEvidence.map((item) => ({ evidenceId: item.id, claim: 'Grok X Search 公开资料引用。', sourceUrl: item.url }))] }
      } : report;
      validateEvidenceReferences(citedReport, new Set(allEvidence.map((item) => item.id)));
      const markdown = renderReportMarkdown(citedReport);
      await database.query(
        `update report_versions
         set status = 'ready', structured_document = $2::jsonb, rendered_markdown = $3,
             change_summary = $4::jsonb, completed_at = now()
         where id = $1`,
        [version.id, JSON.stringify(citedReport), markdown, JSON.stringify({ provider: completion.provider.name, model: completion.response.model, xSearchCitations: citationEvidence.length })]
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
