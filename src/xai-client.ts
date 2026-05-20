import { ProxyAgent } from 'undici';
import { retry } from './retry.js';

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
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  fetch?: typeof fetch;
  retryAttempts?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

interface XaiChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

const DEFAULT_SYSTEM_PROMPT = [
  '你必须返回非空内容。',
  '如果信息不足，也要根据用户要求输出可用结论，不要只返回空字符串。',
  '不要输出思考过程。'
].join('\n');

class XaiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

class XaiEmptyContentError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function isRetryableXaiError(error: unknown): boolean {
  if (error instanceof XaiEmptyContentError) {
    return true;
  }
  if (error instanceof XaiHttpError) {
    return error.status === 403 || error.status === 429 || error.status >= 500;
  }
  return true;
}

function describeEmptyContent(parsed: XaiChatCompletionResponse): string {
  const baseMessage =
    parsed.error?.message?.trim() ||
    (parsed.usage?.completion_tokens === 0
      ? '模型未返回任何内容'
      : 'xAI response missing choices[0].message.content');
  const details: string[] = [];
  const completionTokens = parsed.usage?.completion_tokens;
  const finishReason = parsed.choices?.[0]?.finish_reason;
  if (typeof completionTokens === 'number' && !baseMessage.includes('completion_tokens=')) {
    details.push(`completion_tokens=${completionTokens}`);
  }
  if (typeof finishReason === 'string' && finishReason.length > 0 && !baseMessage.includes('finish_reason=')) {
    details.push(`finish_reason=${finishReason}`);
  }
  return details.length > 0 ? `${baseMessage} (${details.join(', ')})` : baseMessage;
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
  const requestBody: Record<string, unknown> = {
    model: options.model ?? 'grok-4.20-fast',
    stream: false,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 2_048,
    messages: [
      {
        role: 'system',
        content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: options.prompt
      }
    ]
  };
  return retry(
    async () => {
      const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json'
        },
        dispatcher,
        body: JSON.stringify(requestBody)
      });
      const body = await response.text();
      if (!response.ok) {
        throw new XaiHttpError(`xAI request failed: ${response.status} ${body}`, response.status);
      }

      let parsed: XaiChatCompletionResponse | undefined;

      try {
        parsed = JSON.parse(body) as XaiChatCompletionResponse;
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
        throw new XaiEmptyContentError(describeEmptyContent(parsed));
      }
      return content.trim();
    },
    {
      attempts: options.retryAttempts ?? 3,
      minDelayMs: options.retryMinDelayMs ?? 1_000,
      maxDelayMs: options.retryMaxDelayMs ?? 10_000,
      shouldRetry: isRetryableXaiError,
      onRetry: options.onRetry
    }
  );
}
