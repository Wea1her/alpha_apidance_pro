import { describe, expect, it } from 'vitest';
import { AiProviderRouter } from '../src/provider-router.js';
import type { AiProviderAdapter } from '../src/provider.js';

function provider(overrides: Partial<AiProviderAdapter['profile']> = {}, complete = async () => ({ text: '{"accountType":"PROJECT","reason":"项目账号"}', model: 'screen-v1' })): AiProviderAdapter {
  return { profile: { id: 'p', name: 'main', baseUrl: 'https://ai.test', screeningModel: 'screen-v1', researchModel: 'research-v1', capabilities: ['chat', 'structured_output', 'web_search', 'citations'], role: 'main', enabled: true, health: 'healthy', ...overrides }, complete, healthCheck: async () => 'healthy' };
}

describe('AiProviderRouter', () => {
  it('uses the main provider then falls back after an error', async () => {
    const main = provider({ name: 'main' }, async () => { throw new Error('down'); });
    const fallback = provider({ id: 'fallback', name: 'fallback', role: 'fallback' }, async () => ({ text: 'ok', model: 'fallback-v1' }));
    const router = new AiProviderRouter([fallback, main]);
    await expect(router.complete({ purpose: 'screening', system: '', user: '' })).resolves.toMatchObject({ provider: { name: 'fallback' } });
  });
  it('allows Alpha-evidence research without optional search capability', async () => {
    const router = new AiProviderRouter([provider({ capabilities: ['chat', 'structured_output'] })]);
    await expect(router.complete({ purpose: 'research', system: '', user: '' })).resolves.toMatchObject({ provider: { name: 'main' } });
  });
});
