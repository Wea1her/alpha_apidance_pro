import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/openai-compatible.js';

describe('OpenAI-compatible Grok provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enables Grok X Search for research and returns annotation citations', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toEqual([{ type: 'x_search' }]);
      return new Response(JSON.stringify({
        model: 'grok-4.3',
        choices: [{ message: { content: '{"ok":true}', annotations: [{ url: 'https://x.com/example/status/1' }] } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiCompatibleProvider({ name: 'test', baseUrl: 'https://ai.test/v1', apiKey: 'key', screeningModel: 'grok-4.3', researchModel: 'grok-4.3', xSearch: true });
    await expect(provider.complete({ purpose: 'research', system: 'system', user: 'search', schema: 'json' })).resolves.toMatchObject({ citations: ['https://x.com/example/status/1'], model: 'grok-4.3' });
  });
});
