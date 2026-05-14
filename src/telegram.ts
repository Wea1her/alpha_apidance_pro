import { ProxyAgent } from 'undici';

type FetchWithDispatcher = (
  input: string,
  init: RequestInit & { dispatcher?: ProxyAgent }
) => Promise<Response>;

export interface SendTelegramMessageOptions {
  botToken: string;
  chatId: string;
  text: string;
  proxyUrl?: string;
  replyToMessageId?: number;
  fetch?: typeof fetch;
}

export interface TelegramSendResult {
  messageId: number;
  chatId: number;
}

export async function sendTelegramMessage(options: SendTelegramMessageOptions): Promise<TelegramSendResult> {
  const fetchImpl = (options.fetch ?? fetch) as FetchWithDispatcher;
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  const response = await fetchImpl(`https://api.telegram.org/bot${options.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    dispatcher,
    body: JSON.stringify({
      chat_id: options.chatId,
      text: options.text,
      disable_web_page_preview: false,
      reply_to_message_id: options.replyToMessageId
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`telegram send failed: ${response.status} ${body}`);
  }
  const parsed = JSON.parse(body) as {
    ok?: boolean;
    result?: {
      message_id?: number;
      chat?: {
        id?: number;
      };
    };
    description?: string;
  };
  if (
    !parsed.ok ||
    typeof parsed.result?.message_id !== 'number' ||
    typeof parsed.result?.chat?.id !== 'number'
  ) {
    throw new Error(parsed.description ?? 'telegram send returned invalid payload');
  }
  return { messageId: parsed.result.message_id, chatId: parsed.result.chat.id };
}

export async function replyInTelegramThread(options: SendTelegramMessageOptions & { replyToMessageId: number }): Promise<TelegramSendResult> {
  return sendTelegramMessage(options);
}
