import { z } from 'zod';

export const ReportDocumentSchema = z.object({
  coreInfo: z.object({ projectName: z.string().min(1), handle: z.string().min(1), summary: z.string().min(1), stage: z.string().min(1) }).strict(),
  focusReason: z.object({ currentProgress: z.string().min(1), strengths: z.array(z.string().min(1)), weaknesses: z.array(z.string().min(1)), reason: z.string().min(1) }).strict(),
  tags: z.array(z.string().min(1)).min(1)
}).strict();
export type ReportDocument = z.infer<typeof ReportDocumentSchema>;
