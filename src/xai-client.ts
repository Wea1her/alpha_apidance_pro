import { ProxyAgent } from 'undici';

type FetchWithDispatcher = (
  input: string,
  init?: RequestInit & { dispatcher?: ProxyAgent }
) => Promise<Response>;

export interface RequestGrokAnalysisOptions {
  apiKey: string;
  prompt: string;
  baseUrl?: string;
  model?: string;
  proxyUrl?: string;
  fetch?: typeof fetch;
}

export async function requestGrokAnalysis(options: RequestGrokAnalysisOptions): Promise<string> {
  const fetchImpl = (options.fetch ?? fetch) as FetchWithDispatcher;
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  const baseUrl = (options.baseUrl ?? 'https://api.x.ai').replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json'
    },
    dispatcher,
    body: JSON.stringify({
      model: options.model ?? 'grok-4.20-fast',
      stream: false,
      messages: [
        {
          role: 'user',
          content: options.prompt
        }
      ]
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`xAI request failed: ${response.status} ${body}`);
  }
  const parsed = JSON.parse(body) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
    error?: { message?: string };
  };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error(parsed.error?.message ?? 'xAI response missing choices[0].message.content');
  }
  return content.trim();
}
