import { ProxyAgent } from 'undici';

type FetchWithDispatcher = (
  input: string,
  init?: RequestInit & { dispatcher?: ProxyAgent }
) => Promise<Response>;

export interface Twitter6551ClientOptions {
  token: string;
  baseUrl?: string;
  proxyUrl?: string;
  fetch?: typeof fetch;
}

export interface Twitter6551Client {
  postOpen(endpoint: string, body: Record<string, unknown>): Promise<unknown>;
}

export function createTwitter6551Client(options: Twitter6551ClientOptions): Twitter6551Client {
  const fetchImpl = (options.fetch ?? fetch) as FetchWithDispatcher;
  const baseUrl = (options.baseUrl ?? 'https://ai.6551.io').replace(/\/+$/, '');
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;

  return {
    async postOpen(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
      const response = await fetchImpl(`${baseUrl}/open/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json'
        },
        dispatcher,
        body: JSON.stringify(body)
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`6551 request failed: ${response.status} ${text}`);
      }
      try {
        return text.length > 0 ? JSON.parse(text) : {};
      } catch (error) {
        throw new Error(`6551 response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
