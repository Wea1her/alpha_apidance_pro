export type AiCapability = 'chat' | 'web_search' | 'x_search' | 'citations' | 'structured_output';
export type AiPurpose = 'screening' | 'research' | 'materiality';

export interface AiProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  screeningModel: string;
  researchModel: string;
  capabilities: readonly AiCapability[];
  role: 'main' | 'fallback';
  enabled: boolean;
  health: 'unknown' | 'healthy' | 'unhealthy';
}

export interface AiCompletionRequest {
  purpose: AiPurpose;
  system: string;
  user: string;
  schema?: string;
}

export interface AiCompletionResponse {
  text: string;
  model: string;
  citations?: readonly string[];
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiProviderAdapter {
  readonly profile: AiProviderProfile;
  complete(request: AiCompletionRequest): Promise<AiCompletionResponse>;
  healthCheck(): Promise<AiProviderProfile['health']>;
}
