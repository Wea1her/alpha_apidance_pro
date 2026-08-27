import { createHash } from 'node:crypto';
import {
  AiProviderRouter,
  buildResearchReportPrompt,
  renderReportMarkdown,
  ReportDocumentSchema,
  validateEvidenceReferences
} from '@alpha-research/ai';
import type { JobDatabase, JobRecord } from '@alpha-research/db';

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
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : []; }
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
  const project = record(raw.project ?? raw.coreInfo);
  const focus = record(raw.focusReason ?? raw.key_focus);
  const review = record(raw.independentReview ?? raw.independent_review);
  const scores = record(raw.score ?? raw.scores);
  const rawTracks = Array.isArray(raw.l2Tracks)
    ? raw.l2Tracks
    : Array.isArray(raw.six_tracks)
      ? raw.six_tracks
      : Object.entries(record(raw.six_tracks)).map(([key, value]) => ({ key, ...record(value) }));
  const globalEvidence = strings(raw.evidence_ids ?? raw.evidenceIds).flatMap((item) => normalizedEvidence(item, evidenceIds));
  const tracks = TRACK_KEYS.map((key) => {
    const source = rawTracks.map(record).find((item) => trackKey(item.key ?? item.track ?? item.title ?? item.name) === key) ?? {};
    const evidence = Array.isArray(source.evidence) ? source.evidence.flatMap((item) => normalizedEvidence(item, evidenceIds)) : globalEvidence;
    const findings = strings(source.findings ?? source.key_findings ?? source.points ?? source.analysis);
    return { key, title: TRACK_TITLES[key], score: Math.max(0, Math.min(10, Number(source.score ?? source.rating ?? 0) || 0)), summary: text(source.summary ?? source.assessment ?? source.conclusion, '暂未确认。'), findings: findings.slice(0, 8).concat(findings.length ? [] : ['暂无可核验结论。']), evidence };
  });
  const reviewEvidence = Array.isArray(review.evidence) ? review.evidence.flatMap((item) => normalizedEvidence(item, evidenceIds)) : globalEvidence;
  const riskItems = Array.isArray(raw.risksEvidence) ? raw.risksEvidence : Array.isArray(raw.not_include) ? raw.not_include : [];
  return {
    coreInfo: { projectName: text(project.name ?? (typeof raw.project === 'string' ? raw.project : undefined) ?? raw.project_name ?? fallbackProject?.display_name, '未命名项目'), handle: text(project.handle ?? raw.handle, fallbackProject?.current_handle ? `@${fallbackProject.current_handle.replace(/^@/, '')}` : '@unknown'), summary: text(raw.abstract ?? raw.summary ?? project.summary ?? project.abstract, '暂无项目摘要。'), stage: text(raw.stage ?? project.stage, '暂未确认') },
    focusReason: { currentProgress: text(focus.currentProgress ?? focus.current_progress ?? raw.monitor, '暂未确认。'), strengths: strings(focus.strengths ?? focus.advantages), weaknesses: strings(focus.weaknesses ?? focus.risks), reason: text(focus.reason ?? raw.conclusion, '暂未形成综合判断。') },
    tags: strings(raw.tags).length ? strings(raw.tags) : ['待分类'],
    thesis: strings(raw.thesis ?? raw.key_focus).length ? strings(raw.thesis ?? raw.key_focus) : ['后续公开进展是关键验证点。'],
    playbook: strings(raw.playbook ?? raw.monitor ?? record(raw.monitor).steps ?? record(raw.monitor).actions),
    l2Tracks: tracks,
    independentReview: { status: ['passed', 'challenged', 'failed'].includes(text(review.status)) ? text(review.status) : 'challenged', hypotheses: strings(review.hypotheses ?? review.hypotheses_to_test).concat(strings(review.hypotheses ?? review.hypotheses_to_test).length ? [] : ['项目将继续推进并产生可验证进展。']), falsificationChecks: strings(review.falsificationChecks ?? review.falsification_checks ?? review.checks).concat(strings(review.falsificationChecks ?? review.falsification_checks ?? review.checks).length ? [] : ['检查后续版本、官方公告和实际使用情况。']), counterEvidence: strings(review.counterEvidence ?? review.counter_evidence), conclusion: text(review.conclusion, '暂未完成独立复核。'), evidence: reviewEvidence },
    score: { overall: Math.max(0, Math.min(100, Number(scores.overall ?? scores.total ?? 0) || 0)), confidence: Math.max(0, Math.min(1, Number(scores.confidence ?? 0.3) || 0.3)), verdict: ['重点关注', '持续观察', '暂不纳入'].includes(text(scores.verdict)) ? text(scores.verdict) : '持续观察', dimensions: TRACK_KEYS.map((key) => ({ key, score: tracks.find((track) => track.key === key)?.score ?? 0, rationale: tracks.find((track) => track.key === key)?.summary ?? '暂未确认。' })) },
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
      const completion = await router.complete({ purpose: 'research', system: prompt.system, user: prompt.user, schema: 'ReportDocumentSchema' });
      const citationEvidence = await ensureCitationEvidence(database, project, completion.response.citations ?? []);
      const allEvidence = [...evidence, ...citationEvidence];
      const report = parseReport(completion.response.text, allEvidence.map((item) => item.id), project);
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
    } catch (error) {
      await database.query(
        `update report_versions set status = 'failed', change_summary = $2::jsonb, completed_at = now() where id = $1`,
        [version.id, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })]
      );
      throw error;
    }
  };
}
