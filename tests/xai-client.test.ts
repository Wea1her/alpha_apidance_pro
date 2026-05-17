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

  it('extracts assistant content from SSE chat completion responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","reasoning_content":"thinking"}}]}

data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":"ok"}}]}

data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":"stop"}]}

data: [DONE]
`
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        fetch: fetchMock as unknown as typeof fetch
      })
    ).resolves.toBe('ok');
  });

  it('ignores malformed SSE frames and avoids duplicating message content after deltas', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `data: {"choices":[{"delta":{"content":"he"}}]}

data: not-json

data: {"choices":[{"delta":{"content":"llo"}}]}

data: {"choices":[{"message":{"content":"hello"}}]}

data: [DONE]
`
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        fetch: fetchMock as unknown as typeof fetch
      })
    ).resolves.toBe('hello');
  });

  it('retries retryable xAI HTTP failures before returning content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'server error'
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'retry ok'
                }
              }
            ]
          })
      });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        fetch: fetchMock as unknown as typeof fetch,
        retryMinDelayMs: 0
      })
    ).resolves.toBe('retry ok');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable xAI HTTP failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request'
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        fetch: fetchMock as unknown as typeof fetch,
        retryMinDelayMs: 0
      })
    ).rejects.toThrow('xAI request failed: 400 bad request');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
