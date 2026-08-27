import 'dotenv/config';
import { createPostgresDatabase, migrateDatabase } from '@alpha-research/db';
import { AccountScreeningService, AiProviderRouter, OpenAiCompatibleProvider } from '@alpha-research/ai';
import { WorkerRunner } from './runner.js';
import { createDecodeAlphaEventHandler } from './handlers/decode-alpha-event.js';
import { createScreenAccountHandler } from './handlers/screen-account.js';
import { createResearchProjectHandler } from './handlers/research-project.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const database = createPostgresDatabase(databaseUrl);
await migrateDatabase(database);
const handlers = { decode_alpha_event: createDecodeAlphaEventHandler(database) } as Record<string, (job: import('@alpha-research/db').JobRecord) => Promise<void>>;
const configuredJobTypes = process.env.WORKER_JOB_TYPES?.split(',').map((item) => item.trim()).filter(Boolean);
const needsAi = !configuredJobTypes || configuredJobTypes.some((type) => type === 'screen_account' || type === 'research_project');
const aiApiKey = process.env.AI_API_KEY;
const aiBaseUrl = process.env.AI_BASE_URL;
if (needsAi && aiApiKey && aiBaseUrl) {
  const provider = new OpenAiCompatibleProvider({
    name: process.env.AI_PROVIDER_NAME ?? 'fengshao-grok',
    baseUrl: aiBaseUrl,
    apiKey: aiApiKey,
    screeningModel: process.env.AI_SCREENING_MODEL ?? 'grok-4.20-multi-agent-0309',
    researchModel: process.env.AI_RESEARCH_MODEL ?? 'grok-4.20-multi-agent-0309',
    xSearch: process.env.AI_X_SEARCH !== 'false',
    timeoutMs: Number.parseInt(process.env.AI_TIMEOUT_MS ?? '90000', 10),
    maxOutputTokens: Number.parseInt(process.env.AI_MAX_OUTPUT_TOKENS ?? '12000', 10)
  });
  const health = await provider.healthCheck();
  provider.profile.health = health;
  console.log(`[worker] AI provider ${provider.profile.name} health=${health}`);
  const providers = [provider];
  const fallbackModel = process.env.AI_RESEARCH_FALLBACK_MODEL;
  if (fallbackModel) {
    const fallback = new OpenAiCompatibleProvider({
      name: `${process.env.AI_PROVIDER_NAME ?? 'fengshao-grok'}-fallback`,
      baseUrl: aiBaseUrl,
      apiKey: aiApiKey,
      screeningModel: process.env.AI_SCREENING_MODEL ?? 'grok-4.20-multi-agent-0309',
      researchModel: fallbackModel,
      xSearch: process.env.AI_X_SEARCH !== 'false',
      role: 'fallback',
      timeoutMs: Number.parseInt(process.env.AI_TIMEOUT_MS ?? '90000', 10),
      maxOutputTokens: Number.parseInt(process.env.AI_MAX_OUTPUT_TOKENS ?? '12000', 10)
    });
    fallback.profile.health = await fallback.healthCheck();
    console.log(`[worker] AI fallback ${fallback.profile.name} health=${fallback.profile.health}`);
    providers.push(fallback);
  }
  const router = new AiProviderRouter(providers);
  handlers.screen_account = createScreenAccountHandler(database, new AccountScreeningService(router));
  handlers.research_project = createResearchProjectHandler(database, router);
} else if (needsAi) {
  console.warn('[worker] AI provider is not configured; screen_account jobs will wait for configuration');
}
const runner = new WorkerRunner(database, {
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  concurrency: Number.parseInt(process.env.WORKER_CONCURRENCY ?? '1', 10),
  jobTypes: configuredJobTypes,
  handlers
});
process.once('SIGINT', () => runner.stop());
process.once('SIGTERM', () => runner.stop());
await runner.run();
