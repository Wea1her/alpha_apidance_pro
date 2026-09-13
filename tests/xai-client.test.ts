import { describe, expect, it, vi } from 'vitest';
import { XaiSearchUnsupportedError, isXaiSearchUnsupportedError, requestGrokAnalysis } from '../src/xai-client.js';

describe('requestGrokAnalysis', () => {
  it('uses the fengshao multi-agent Responses contract with only web search enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        model: 'grok-4.20-multi-agent-0309', status: 'completed', output_text: '深度报告',
        usage: { output_tokens: 1000, num_server_side_tools_used: 3 }
      })
    });
    await expect(requestGrokAnalysis({
      apiKey: 'deep-key', baseUrl: 'https://api.fengshao1227.com/', model: 'grok-4.20-multi-agent-0309',
      prompt: '深度投研', maxTokens: 4096, searchTools: ['web_search'], fetch: fetchMock as unknown as typeof fetch
    })).resolves.toBe('深度报告');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.fengshao1227.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer deep-key');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'grok-4.20-multi-agent-0309', tools: [{ type: 'web_search' }], max_output_tokens: 4096
    });
  });
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

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.x.ai/v1/chat/completions');
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as {
      max_tokens?: number;
      temperature?: number;
      tools?: unknown;
      messages?: Array<{ role: string; content: string }>;
    };
    expect(requestBody.max_tokens).toBe(2048);
    expect(requestBody.temperature).toBe(0.2);
    expect(requestBody.tools).toBeUndefined();
    expect(requestBody.messages?.[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('非空')
    });
    expect(requestBody.messages?.[1]).toEqual({
      role: 'user',
      content: 'hello'
    });
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

  it('retries Grok upstream 403 before returning content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'upstream forbidden'
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '403 retry ok'
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
    ).resolves.toBe('403 retry ok');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries empty Grok completions and reports usage details', async () => {
    const onRetry = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: ''
                }
              }
            ],
            usage: {
              completion_tokens: 0,
              prompt_tokens: 900,
              total_tokens: 900
            }
          })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'empty retry ok'
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
        retryMinDelayMs: 0,
        onRetry
      })
    ).resolves.toBe('empty retry ok');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((onRetry.mock.calls[0][0] as Error).message).toContain('completion_tokens=0');
    expect((onRetry.mock.calls[0][0] as Error).message).toContain('finish_reason=stop');
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

  it('sends server-side search tools through the responses API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'web_search_call', status: 'completed' },
            { type: 'x_search_call', status: 'completed' },
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: '检索后的',
                  annotations: [{ type: 'url_citation', url: 'https://example.com' }]
                },
                { type: 'output_text', text: '分析结果' }
              ]
            }
          ],
          usage: { input_tokens: 100, output_tokens: 20 }
        })
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        baseUrl: 'https://relay.example/',
        model: 'grok-4.6',
        maxTokens: 1024,
        searchTools: ['web_search', 'x_search', 'x_search'],
        fetch: fetchMock as unknown as typeof fetch
      })
    ).resolves.toBe('检索后的分析结果');

    expect(fetchMock.mock.calls[0][0]).toBe('https://relay.example/v1/responses');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      Authorization: 'Bearer key',
      'Content-Type': 'application/json'
    });
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(requestBody.model).toBe('grok-4.6');
    expect(requestBody.tools).toEqual([{ type: 'web_search' }, { type: 'x_search' }]);
    expect(requestBody.max_output_tokens).toBe(1024);
    expect(requestBody.temperature).toBe(0.2);
    expect(requestBody.input).toEqual([
      { role: 'system', content: expect.stringContaining('非空') },
      { role: 'user', content: 'hello' }
    ]);
    expect(requestBody.messages).toBeUndefined();
    expect(requestBody.max_tokens).toBeUndefined();
  });

  it('warns when search tools were enabled but the model did not invoke any', async () => {
    const warn = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'no search happened' }] }],
          usage: { output_tokens: 20, num_server_side_tools_used: 0, num_sources_used: 0 }
        })
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        searchTools: ['web_search', 'x_search'],
        fetch: fetchMock as unknown as typeof fetch,
        warn
      })
    ).resolves.toBe('no search happened');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('num_server_side_tools_used=0');
    expect(warn.mock.calls[0][0]).toContain('num_sources_used=0');
  });

  it('does not warn when search tools were used or usage is missing', async () => {
    const warn = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'searched' }] }],
            usage: { num_server_side_tools_used: 2, num_sources_used: 5 }
          })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'no usage' }] }] })
      });

    await expect(
      requestGrokAnalysis({ apiKey: 'key', prompt: 'a', searchTools: ['x_search'], fetch: fetchMock as never, warn })
    ).resolves.toBe('searched');
    await expect(
      requestGrokAnalysis({ apiKey: 'key', prompt: 'b', searchTools: ['x_search'], fetch: fetchMock as never, warn })
    ).resolves.toBe('no usage');

    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps using chat completions when the search tool list is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'plain' } }] })
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        searchTools: [],
        fetch: fetchMock as unknown as typeof fetch
      })
    ).resolves.toBe('plain');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.x.ai/v1/chat/completions');
  });

  it('accepts chat-formatted content when a relay converts responses output', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'converted by relay' } }] })
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        searchTools: ['x_search'],
        fetch: fetchMock as unknown as typeof fetch
      })
    ).resolves.toBe('converted by relay');
  });

  it('retries empty responses API output and reports the incomplete reason', async () => {
    const onRetry = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [{ type: 'web_search_call', status: 'completed' }],
            usage: { output_tokens: 0 }
          })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'second try' }] }]
          })
      });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        searchTools: ['web_search'],
        fetch: fetchMock as unknown as typeof fetch,
        retryMinDelayMs: 0,
        onRetry
      })
    ).resolves.toBe('second try');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const message = (onRetry.mock.calls[0][0] as Error).message;
    expect(message).toContain('status=incomplete');
    expect(message).toContain('incomplete_reason=max_output_tokens');
    expect(message).toContain('output_tokens=0');
  });

  it('reports an unsupported responses endpoint without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () =>
        JSON.stringify({
          error: { message: 'not implemented (request id: 1)', type: 'new_api_error', code: 'convert_request_failed' }
        })
    });

    const promise = requestGrokAnalysis({
      apiKey: 'key',
      prompt: 'hello',
      searchTools: ['web_search', 'x_search'],
      fetch: fetchMock as unknown as typeof fetch,
      retryMinDelayMs: 0
    });

    await expect(promise).rejects.toBeInstanceOf(XaiSearchUnsupportedError);
    await expect(promise).rejects.toThrow('xAI responses API unsupported: 500');
    await promise.catch((error: unknown) => {
      expect(isXaiSearchUnsupportedError(error)).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a 404 on the responses endpoint as unsupported', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found'
    });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        searchTools: ['x_search'],
        fetch: fetchMock as unknown as typeof fetch,
        retryMinDelayMs: 0
      })
    ).rejects.toBeInstanceOf(XaiSearchUnsupportedError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries ordinary upstream failures on the responses endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'upstream overloaded'
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'recovered' }] }]
          })
      });

    await expect(
      requestGrokAnalysis({
        apiKey: 'key',
        prompt: 'hello',
        searchTools: ['x_search'],
        fetch: fetchMock as unknown as typeof fetch,
        retryMinDelayMs: 0
      })
    ).resolves.toBe('recovered');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
