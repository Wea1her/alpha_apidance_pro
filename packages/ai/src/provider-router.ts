import type { AiCapability, AiCompletionRequest, AiCompletionResponse, AiProviderAdapter, AiProviderProfile, AiPurpose } from './provider.js';

export class AiProviderUnavailableError extends Error {
  constructor(public readonly purpose: AiPurpose, message = `No healthy AI provider for ${purpose}`) { super(message); }
}

export class AiProviderRouter {
  constructor(private readonly providers: readonly AiProviderAdapter[]) {}

  providersFor(purpose: AiPurpose): AiProviderAdapter[] {
    // Research reports can be generated from the Alpha evidence bundle. Search and
    // citation capabilities are optional enrichments, not prerequisites for the
    // report worker to run on the configured OpenAI-compatible relay.
    const required: readonly AiCapability[] = ['chat', 'structured_output'];
    return this.providers.filter((provider) => provider.profile.enabled && provider.profile.health === 'healthy' && required.every((capability) => provider.profile.capabilities.includes(capability))).sort((a, b) => this.rank(a.profile) - this.rank(b.profile));
  }

  async complete(request: AiCompletionRequest): Promise<{ response: AiCompletionResponse; provider: AiProviderProfile }> {
    const candidates = this.providersFor(request.purpose);
    if (candidates.length === 0) throw new AiProviderUnavailableError(request.purpose);
    let lastError: unknown;
    for (const candidate of candidates) {
      try { return { response: await candidate.complete(request), provider: candidate.profile }; }
      catch (error) { lastError = error; }
    }
    throw new AiProviderUnavailableError(request.purpose, `All AI providers failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private rank(profile: AiProviderProfile): number { return profile.role === 'main' ? 0 : 1; }
}
