export const ALPHA_LOGIN_MESSAGE = 'welcome to alpha3!';
export const DEFAULT_ALPHA_BASE_URL = 'https://alpha.apidance.pro/api';
export const DEFAULT_ALPHA_WS_BASE_URL = 'wss://alpha.apidance.pro/api';

export interface AlphaLoginPayload {
  address: string;
  msg: string;
  signature: string;
}

export interface AlphaApiResponse<T> {
  code?: number;
  data?: T;
  msg?: string;
}

export interface LoginAlphaOptions {
  baseUrl: string;
  payload: AlphaLoginPayload;
  fetch?: typeof fetch;
}

export type AlphaMessage = Record<string, unknown>;

export async function createAlphaLoginPayload(
  address: string,
  signMessage: (message: string) => Promise<string>
): Promise<AlphaLoginPayload> {
  return {
    address,
    msg: ALPHA_LOGIN_MESSAGE,
    signature: await signMessage(ALPHA_LOGIN_MESSAGE)
  };
}

export function buildAlphaWsUrl(wsBaseUrl: string, token: string): string {
  const base = wsBaseUrl.replace(/\/+$/, '');
  const url = new URL(`${base}/v1/user/ws`);
  url.searchParams.set('token', token);
  return url.toString();
}

export async function loginAlpha(options: LoginAlphaOptions): Promise<string> {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options.payload)
  });
  const raw = await response.text();
  let body: AlphaApiResponse<string>;
  try {
    body = JSON.parse(raw) as AlphaApiResponse<string>;
  } catch {
    throw new Error(`alpha login returned invalid JSON: ${raw}`);
  }

  if (!response.ok) {
    throw new Error(body.msg ?? `alpha login failed with HTTP ${response.status}`);
  }
  if (body.code !== 1 || typeof body.data !== 'string' || body.data.length === 0) {
    throw new Error(body.msg ?? 'alpha login failed');
  }

  return body.data;
}

export function isAlphaHeartbeat(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'channel' in message &&
    (message as { channel?: unknown }).channel === 'heartbeat'
  );
}

export function parseAlphaMessage(raw: string): AlphaMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('alpha message must be a JSON object');
  }
  return parsed as AlphaMessage;
}
