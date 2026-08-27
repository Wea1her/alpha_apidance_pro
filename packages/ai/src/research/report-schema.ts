import { z } from 'zod';

export const EvidenceReferenceSchema = z.object({ evidenceId: z.string().uuid(), claim: z.string().min(1), sourceUrl: z.string().url().optional() }).strict();
export const L2TrackKeySchema = z.enum(['product', 'technology', 'team', 'market', 'tokenomics', 'catalysts']);
export const L2TrackSchema = z.object({
  key: L2TrackKeySchema,
  title: z.string().min(1),
  score: z.number().min(0).max(10),
  summary: z.string().min(1),
  findings: z.array(z.string().min(1)),
  evidence: z.array(EvidenceReferenceSchema)
}).strict();
export const IndependentReviewSchema = z.object({
  status: z.enum(['passed', 'challenged', 'failed']),
  hypotheses: z.array(z.string().min(1)).min(1),
  falsificationChecks: z.array(z.string().min(1)).min(1),
  counterEvidence: z.array(z.string().min(1)),
  conclusion: z.string().min(1),
  evidence: z.array(EvidenceReferenceSchema)
}).strict();
export const ScoreSummarySchema = z.object({
  overall: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  verdict: z.enum(['重点关注', '持续观察', '暂不纳入']),
  dimensions: z.array(z.object({ key: L2TrackKeySchema, score: z.number().min(0).max(10), rationale: z.string().min(1) }).strict()).length(6).superRefine((dimensions, context) => {
    if (new Set(dimensions.map((dimension) => dimension.key)).size !== 6) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Score dimensions must contain six unique track keys' });
  })
}).strict();
export const ReportDocumentSchema = z.object({
  coreInfo: z.object({ projectName: z.string().min(1), handle: z.string().min(1), summary: z.string().min(1), stage: z.string().min(1), background: z.string().min(1).optional() }).strict(),
  focusReason: z.object({ currentProgress: z.string().min(1), strengths: z.array(z.string().min(1)), weaknesses: z.array(z.string().min(1)), reason: z.string().min(1) }).strict(),
  tags: z.array(z.string().min(1)).min(1),
  thesis: z.array(z.string().min(1)).min(1),
  playbook: z.array(z.string().min(1)),
  l2Tracks: z.array(L2TrackSchema).length(6).superRefine((tracks, context) => {
    if (new Set(tracks.map((track) => track.key)).size !== 6) context.addIssue({ code: z.ZodIssueCode.custom, message: 'L2 tracks must contain six unique track keys' });
  }),
  independentReview: IndependentReviewSchema,
  score: ScoreSummarySchema,
  risksEvidence: z.array(z.object({ risk: z.string().min(1), evidence: z.array(EvidenceReferenceSchema) }).strict())
}).strict();
export type ReportDocument = z.infer<typeof ReportDocumentSchema>;

export function validateEvidenceReferences(report: ReportDocument, availableEvidenceIds: ReadonlySet<string>): void {
  for (const track of report.l2Tracks) for (const evidence of track.evidence) if (!availableEvidenceIds.has(evidence.evidenceId)) throw new Error(`Report references missing evidence: ${evidence.evidenceId}`);
  for (const evidence of report.independentReview.evidence) if (!availableEvidenceIds.has(evidence.evidenceId)) throw new Error(`Report references missing evidence: ${evidence.evidenceId}`);
  for (const item of report.risksEvidence) for (const evidence of item.evidence) if (!availableEvidenceIds.has(evidence.evidenceId)) throw new Error(`Report references missing evidence: ${evidence.evidenceId}`);
}
