import { ProxyAgent } from 'undici';
import { retry } from './retry.js';

type FetchWithDispatcher = (
  input: string,
  init?: RequestInit & { dispatcher?: ProxyAgent }
) => Promise<Response>;

export const XAI_SEARCH_TOOL_TYPES = ['web_search', 'x_search'] as const;
export type XaiSearchTool = (typeof XAI_SEARCH_TOOL_TYPES)[number];

export interface RequestGrokAnalysisOptions {
  apiKey: string;
  prompt: string;
  baseUrl?: string;
  model?: string;
  proxyUrl?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  /** 非空时改走 xAI Responses API，并启用对应的服务端检索工具。 */
  searchTools?: readonly XaiSearchTool[];
  fetch?: typeof fetch;
  retryAttempts?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** 非致命告警回调，例如检索工具已启用但模型本次未调用。 */
  warn?: (message: string) => void;
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

interface XaiResponsesApiResponse {
  status?: string;
  incomplete_details?: { reason?: string | null } | null;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string | null;
    }>;
  }>;
  output_text?: string | null;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    num_server_side_tools_used?: number;
    num_sources_used?: number;
  };
  error?: { message?: string };
}

const DEFAULT_SYSTEM_PROMPT = [
  '你必须返回非空内容。',
  '如果信息不足，也要根据用户要求输出可用结论，不要只返回空字符串。',
  '不要输出思考过程。'
].join('\n');

const UNSUPPORTED_ENDPOINT_PATTERN =
  /not implemented|convert_request_failed|not supported|unsupported|unknown (?:path|route|endpoint)|no such (?:path|route|endpoint)/i;

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

/** 中转站或上游不支持 Responses API / 服务端检索工具时抛出，不重试，由调用方决定是否退回普通请求。 */
export class XaiSearchUnsupportedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'XaiSearchUnsupportedError';
  }
}

export function isXaiSearchUnsupportedError(error: unknown): error is XaiSearchUnsupportedError {
  return error instanceof XaiSearchUnsupportedError;
}

function looksLikeUnsupportedEndpoint(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 501) {
    return true;
  }
  return UNSUPPORTED_ENDPOINT_PATTERN.test(body);
}

function isRetryableXaiError(error: unknown): boolean {
  if (error instanceof XaiSearchUnsupportedError) {
    return false;
  }
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

function parseChatCompletionBody(body: string): string {
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
}

function extractResponsesOutputText(parsed: XaiResponsesApiResponse): string | undefined {
  const texts: string[] = [];
  for (const item of parsed.output ?? []) {
    if (item?.type !== 'message') {
      continue;
    }
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        texts.push(part.text);
      }
    }
  }

  const joined = texts.join('').trim();
  if (joined) {
    return joined;
  }
  if (typeof parsed.output_text === 'string' && parsed.output_text.trim()) {
    return parsed.output_text.trim();
  }
  const chatContent = parsed.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string' && chatContent.trim()) {
    return chatContent.trim();
  }
  return undefined;
}

function describeEmptyResponsesContent(parsed: XaiResponsesApiResponse): string {
  const baseMessage = parsed.error?.message?.trim() || 'xAI responses output missing output_text';
  const details: string[] = [];
  if (typeof parsed.status === 'string' && parsed.status.length > 0) {
    details.push(`status=${parsed.status}`);
  }
  const reason = parsed.incomplete_details?.reason;
  if (typeof reason === 'string' && reason.length > 0) {
    details.push(`incomplete_reason=${reason}`);
  }
  if (typeof parsed.usage?.output_tokens === 'number') {
    details.push(`output_tokens=${parsed.usage.output_tokens}`);
  }
  return details.length > 0 ? `${baseMessage} (${details.join(', ')})` : baseMessage;
}

function parseResponsesBody(body: string, warn?: (message: string) => void): string {
  let parsed: XaiResponsesApiResponse;
  try {
    parsed = JSON.parse(body) as XaiResponsesApiResponse;
  } catch {
    throw new Error(`xAI responses body is not valid JSON: ${body.slice(0, 300)}`);
  }

  const content = extractResponsesOutputText(parsed);
  if (!content) {
    throw new XaiEmptyContentError(describeEmptyResponsesContent(parsed));
  }
  if (parsed.usage?.num_server_side_tools_used === 0) {
    warn?.(
      `xAI 服务端检索工具已启用，但本次响应未调用任何检索（num_server_side_tools_used=0, num_sources_used=${
        parsed.usage.num_sources_used ?? '未知'
      }），第 2 节背书信息可能未经检索`
    );
  }
  return content;
}

export async function requestGrokAnalysis(options: RequestGrokAnalysisOptions): Promise<string> {
  const fetchImpl = (options.fetch ?? fetch) as FetchWithDispatcher;
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  const baseUrl = (options.baseUrl ?? 'https://api.x.ai').replace(/\/+$/, '');
  const model = options.model ?? 'grok-4.20-fast';
  const temperature = options.temperature ?? 0.2;
  const maxTokens = options.maxTokens ?? 2_048;
  const messages = [
    {
      role: 'system',
      content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: options.prompt
    }
  ];
  const searchTools = [...new Set(options.searchTools ?? [])];
  const useResponsesApi = searchTools.length > 0;
  const url = useResponsesApi ? `${baseUrl}/v1/responses` : `${baseUrl}/v1/chat/completions`;
  const requestBody: Record<string, unknown> = useResponsesApi
    ? {
        model,
        input: messages,
        tools: searchTools.map((type) => ({ type })),
        temperature,
        max_output_tokens: maxTokens
      }
    : {
        model,
        stream: false,
        temperature,
        max_tokens: maxTokens,
        messages
      };

  return retry(
    async () => {
      const response = await fetchImpl(url, {
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
        if (useResponsesApi && looksLikeUnsupportedEndpoint(response.status, body)) {
          throw new XaiSearchUnsupportedError(
            `xAI responses API unsupported: ${response.status} ${body}`,
            response.status
          );
        }
        throw new XaiHttpError(`xAI request failed: ${response.status} ${body}`, response.status);
      }

      return useResponsesApi ? parseResponsesBody(body, options.warn) : parseChatCompletionBody(body);
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
