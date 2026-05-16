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

function extractContentFromSse(body: string): string | undefined {
  const chunks = body
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  let deltaContent = '';
  let messageContent = '';
  let sawDeltaContent = false;

  for (const chunk of chunks) {
    const lines = chunk
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'));

    for (const line of lines) {
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }

      let parsed: {
        choices?: Array<{
          delta?: {
            content?: string;
          };
          message?: {
            content?: string;
          };
        }>;
      };

      try {
        parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string;
            };
            message?: {
              content?: string;
            };
          }>;
        };
      } catch {
        continue;
      }

      const deltaPiece = parsed.choices?.[0]?.delta?.content;
      if (typeof deltaPiece === 'string') {
        deltaContent += deltaPiece;
        sawDeltaContent = true;
        continue;
      }

      const messagePiece = parsed.choices?.[0]?.message?.content;
      if (!sawDeltaContent && typeof messagePiece === 'string') {
        messageContent += messagePiece;
      }
    }
  }

  const content = sawDeltaContent ? deltaContent : messageContent;
  return content.trim() || undefined;
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

  let parsed:
    | {
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
        error?: { message?: string };
      }
    | undefined;

  try {
    parsed = JSON.parse(body) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
      error?: { message?: string };
    };
  } catch {
    const sseContent = extractContentFromSse(body);
    if (sseContent) {
      return sseContent;
    }
    throw new Error(`xAI response is neither JSON nor valid SSE: ${body.slice(0, 300)}`);
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    const sseContent = extractContentFromSse(body);
    if (sseContent) {
      return sseContent;
    }
    throw new Error(parsed.error?.message ?? 'xAI response missing choices[0].message.content');
  }
  return content.trim();
}
