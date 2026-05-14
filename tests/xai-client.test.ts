import { describe, expect, it, vi } from 'vitest';
import { requestGrokAnalysis } from '../src/xai-client.js';

describe('requestGrokAnalysis', () => {
  it('extracts assistant content from chat completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: '这是分析结果'
              }
            }
          ]
        })
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        fetch: fetchMock as unknown as typeof fetch
      })
    ).resolves.toBe('这是分析结果');
  });
});
