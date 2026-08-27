import { z } from 'zod';

export const AccountTypeSchema = z.enum(['PROJECT', 'ALPHA', 'UNKNOWN', 'KOL', 'PERSONAL', 'DEV', 'MEDIA', 'NFT', 'TRADFI']);
export const ScreeningOutputSchema = z.object({
  accountType: AccountTypeSchema,
  reason: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1).optional()
}).strict();
export type AccountType = z.infer<typeof AccountTypeSchema>;
export type ScreeningOutput = z.infer<typeof ScreeningOutputSchema>;
