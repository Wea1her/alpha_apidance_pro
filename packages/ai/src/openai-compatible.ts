import type { AiCapability, AiCompletionRequest, AiCompletionResponse, AiProviderAdapter, AiProviderProfile } from './provider.js';

export interface OpenAiCompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  name: string;
  screeningModel: string;
  researchModel: string;
  capabilities?: readonly AiCapability[];
  role?: 'main' | 'fallback';
  xSearch?: boolean;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

interface CompletionPayload {
  choices?: Array<{ message?: { content?: unknown; annotations?: Array<{ url?: unknown }> } }>;
  model?: string;
  citations?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : (part as { text?: string })?.text ?? '').join('');
  return '';
}

export class OpenAiCompatibleProvider implements AiProviderAdapter {
  readonly profile: AiProviderProfile;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens?: number;
  private readonly xSearch: boolean;

  constructor(options: OpenAiCompatibleProviderOptions) {
    const normalizedUrl = options.baseUrl.replace(/\/$/, '');
    this.baseUrl = /\/v1$/i.test(normalizedUrl) ? normalizedUrl : `${normalizedUrl}/v1`;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxOutputTokens = options.maxOutputTokens;
    this.xSearch = options.xSearch ?? false;
    this.profile = {
      id: options.name,
      name: options.name,
      baseUrl: this.baseUrl,
      screeningModel: options.screeningModel,
      researchModel: options.researchModel,
      capabilities: options.capabilities ?? ['chat', 'structured_output'],
      role: options.role ?? 'main',
      enabled: true,
      health: 'healthy'
    };
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const model = request.purpose === 'screening' ? this.profile.screeningModel : this.profile.researchModel;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST', signal: controller.signal,
            headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
              temperature: 0.1,
              ...(this.maxOutputTokens ? { max_tokens: this.maxOutputTokens } : {}),
              ...(request.schema ? { response_format: { type: 'json_object' } } : {}),
              ...((request.purpose === 'research' || request.purpose === 'screening') && this.xSearch ? { tools: [{ type: 'x_search' }] } : {})
            })
          });
          const raw = await response.text();
          if (!response.ok) {
            if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
              continue;
            }
            throw new Error(`AI provider HTTP ${response.status}: ${raw.slice(0, 300)}`);
          }
          const payload = JSON.parse(raw) as CompletionPayload;
          const text = contentText(payload.choices?.[0]?.message?.content);
          if (!text) throw new Error('AI provider returned empty completion');
          const annotations = payload.choices?.[0]?.message?.annotations ?? [];
          const annotationUrls = annotations.map((item) => typeof item.url === 'string' ? item.url : '').filter(Boolean);
          const citations = [...new Set([...(payload.citations ?? []), ...annotationUrls])];
          return { text, model: payload.model ?? model, citations, inputTokens: payload.usage?.prompt_tokens, outputTokens: payload.usage?.completion_tokens };
        } finally { clearTimeout(timer); }
      }
    throw new Error('AI provider retries exhausted');
  }

  async healthCheck(): Promise<AiProviderProfile['health']> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: { authorization: `Bearer ${this.apiKey}` } });
      return response.ok ? 'healthy' : 'unhealthy';
    } catch {
      return 'unhealthy';
    }
  }
}
