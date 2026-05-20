import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ProxyAgent } from 'undici';
import { retry } from './retry.js';

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
  retryAttempts?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface SendTelegramDocumentOptions {
  botToken: string;
  chatId: string;
  filePath: string;
  filename?: string;
  caption?: string;
  proxyUrl?: string;
  fetch?: typeof fetch;
  retryAttempts?: number;
  retryMinDelayMs?: number;
  retryMaxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface TelegramSendResult {
  messageId: number;
  chatId: number;
}

class TelegramHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function isRetryableTelegramError(error: unknown): boolean {
  if (error instanceof TelegramHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

function parseTelegramSendResult(body: string): TelegramSendResult {
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

export async function sendTelegramMessage(options: SendTelegramMessageOptions): Promise<TelegramSendResult> {
  const fetchImpl = (options.fetch ?? fetch) as FetchWithDispatcher;
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  return retry(
    async () => {
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
        throw new TelegramHttpError(`telegram send failed: ${response.status} ${body}`, response.status);
      }
      return parseTelegramSendResult(body);
    },
    {
      attempts: options.retryAttempts ?? 5,
      minDelayMs: options.retryMinDelayMs ?? 1_000,
      maxDelayMs: options.retryMaxDelayMs ?? 30_000,
      shouldRetry: isRetryableTelegramError,
      onRetry: options.onRetry
    }
  );
}

export async function sendTelegramDocument(options: SendTelegramDocumentOptions): Promise<TelegramSendResult> {
  const fetchImpl = (options.fetch ?? fetch) as FetchWithDispatcher;
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  const fileBuffer = await readFile(options.filePath);
  const formData = new FormData();
  formData.set('chat_id', options.chatId);
  if (options.caption) {
    formData.set('caption', options.caption);
  }
  formData.set('document', new Blob([fileBuffer]), options.filename ?? basename(options.filePath));

  return retry(
    async () => {
      const response = await fetchImpl(`https://api.telegram.org/bot${options.botToken}/sendDocument`, {
        method: 'POST',
        dispatcher,
        body: formData
      });
      const body = await response.text();
      if (!response.ok) {
        throw new TelegramHttpError(`telegram send failed: ${response.status} ${body}`, response.status);
      }
      return parseTelegramSendResult(body);
    },
    {
      attempts: options.retryAttempts ?? 5,
      minDelayMs: options.retryMinDelayMs ?? 1_000,
      maxDelayMs: options.retryMaxDelayMs ?? 30_000,
      shouldRetry: isRetryableTelegramError,
      onRetry: options.onRetry
    }
  );
}

export async function replyInTelegramThread(options: SendTelegramMessageOptions & { replyToMessageId: number }): Promise<TelegramSendResult> {
  return sendTelegramMessage(options);
}
