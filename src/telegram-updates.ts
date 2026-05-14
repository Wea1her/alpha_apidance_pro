import { ProxyAgent } from 'undici';

type FetchWithDispatcher = (
  input: string,
  init?: RequestInit & { dispatcher?: ProxyAgent }
) => Promise<Response>;

export interface TelegramChatSummary {
  id: number;
  type: string;
  title?: string;
  username?: string;
  isAutomaticForward?: boolean;
  forwardedFromChatId?: number;
}

interface TelegramMessageLike {
  chat?: {
    id?: number;
    type?: string;
    title?: string;
    username?: string;
  };
  is_automatic_forward?: boolean;
  forward_from_chat?: {
    id?: number;
  };
}

function toChatSummary(message: TelegramMessageLike | undefined): TelegramChatSummary | null {
  if (!message?.chat?.id || !message.chat.type) {
    return null;
  }
  return {
    id: message.chat.id,
    type: message.chat.type,
    title: message.chat.title,
    username: message.chat.username,
    isAutomaticForward: message.is_automatic_forward === true ? true : undefined,
    forwardedFromChatId: message.forward_from_chat?.id
  };
}

export function extractChatsFromUpdates(updates: unknown[]): TelegramChatSummary[] {
  const seen = new Map<number, TelegramChatSummary>();

  for (const update of updates) {
    if (!update || typeof update !== 'object') continue;
    const record = update as Record<string, unknown>;
    const candidates = [
      toChatSummary(record.message as TelegramMessageLike | undefined),
      toChatSummary(record.channel_post as TelegramMessageLike | undefined),
      toChatSummary(record.edited_message as TelegramMessageLike | undefined),
      toChatSummary(record.edited_channel_post as TelegramMessageLike | undefined)
    ];

    for (const chat of candidates) {
      if (!chat) continue;
      const existing = seen.get(chat.id);
      seen.set(chat.id, existing ? { ...existing, ...chat } : chat);
    }
  }

  return [...seen.values()];
}

export async function fetchTelegramUpdates(options: {
  botToken: string;
  proxyUrl?: string;
  offset?: number;
  fetch?: typeof fetch;
}): Promise<unknown[]> {
  const fetchImpl = (options.fetch ?? fetch) as FetchWithDispatcher;
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  const url = new URL(`https://api.telegram.org/bot${options.botToken}/getUpdates`);
  if (typeof options.offset === 'number') {
    url.searchParams.set('offset', String(options.offset));
  }
  const response = await fetchImpl(url.toString(), {
    dispatcher
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`telegram getUpdates failed: ${response.status} ${body}`);
  }
  const parsed = JSON.parse(body) as { ok?: boolean; result?: unknown[]; description?: string };
  if (!parsed.ok || !Array.isArray(parsed.result)) {
    throw new Error(parsed.description ?? 'telegram getUpdates returned invalid payload');
  }
  return parsed.result;
}
