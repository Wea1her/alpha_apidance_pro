export type TelegramCommand =
  | {
      type: 'chat-id';
      chatId: string;
      messageId: number;
      username?: string;
    }
  | {
      type: 'export-analysis';
      chatId: string;
      messageId: number;
      username?: string;
      from: string;
      to: string;
    }
  | {
      type: 'invalid-export-analysis';
      chatId: string;
      messageId: number;
      username?: string;
    };

export interface TelegramCommandExtractionOptions {
  botUsername?: string;
}

interface MessageContext {
  text: string;
  chatId: string;
  messageId: number;
  username?: string;
}

const EXPORT_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const CHINESE_EXPORT_COMMAND = '导出分析';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function stringFromChatId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

function contextFromMessage(value: unknown): MessageContext | null {
  if (!isRecord(value) || typeof value.text !== 'string' || typeof value.message_id !== 'number') {
    return null;
  }

  const chat = isRecord(value.chat) ? value.chat : null;
  const chatId = stringFromChatId(chat?.id);
  if (!chatId) {
    return null;
  }

  const from = isRecord(value.from) ? value.from : null;
  const username = typeof from?.username === 'string' && from.username.length > 0 ? from.username : undefined;

  return {
    text: value.text.trim(),
    chatId,
    messageId: value.message_id,
    username
  };
}

function baseCommand(context: MessageContext) {
  return {
    chatId: context.chatId,
    messageId: context.messageId,
    username: context.username
  };
}

function normalizeBotUsername(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^@/, '').toLowerCase();
  return normalized ? normalized : null;
}

function parseSlashCommandToken(head: string | undefined): { command: string; botUsername?: string } | null {
  const match = head?.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/);
  if (!match) {
    return null;
  }
  return { command: match[1], botUsername: match[2] };
}

function isCommandForThisBot(
  parsed: { command: string; botUsername?: string } | null,
  command: string,
  options: TelegramCommandExtractionOptions
): boolean {
  if (!parsed || parsed.command !== command) {
    return false;
  }
  if (!parsed.botUsername) {
    return true;
  }
  const expectedBotUsername = normalizeBotUsername(options.botUsername);
  return expectedBotUsername !== null && normalizeBotUsername(parsed.botUsername) === expectedBotUsername;
}

function looksLikeChineseExportCommand(text: string): boolean {
  if (!text.startsWith(CHINESE_EXPORT_COMMAND)) {
    return false;
  }
  const next = text[CHINESE_EXPORT_COMMAND.length];
  return next === undefined || /\s|\d/.test(next);
}

function parseCommand(
  context: MessageContext,
  options: TelegramCommandExtractionOptions
): TelegramCommand | null {
  const text = context.text;
  const parts = text.split(/\s+/).filter(Boolean);
  const head = parts[0];
  const slashCommand = parseSlashCommandToken(head);

  if (text === '查看聊天ID' || (parts.length === 1 && isCommandForThisBot(slashCommand, 'chatid', options))) {
    return {
      type: 'chat-id',
      ...baseCommand(context)
    };
  }

  const isChineseExport = head === CHINESE_EXPORT_COMMAND;
  const isEnglishExport = isCommandForThisBot(slashCommand, 'export_analysis', options);
  const isExportLike = looksLikeChineseExportCommand(text) || isEnglishExport;
  if (!isExportLike) {
    return null;
  }

  const args = parts.slice(1);
  if (
    !isChineseExport && !isEnglishExport ||
    args.length !== 2 ||
    !EXPORT_HOUR_PATTERN.test(args[0]) ||
    !EXPORT_HOUR_PATTERN.test(args[1])
  ) {
    return {
      type: 'invalid-export-analysis',
      ...baseCommand(context)
    };
  }

  return {
    type: 'export-analysis',
    ...baseCommand(context),
    from: args[0],
    to: args[1]
  };
}

function updateListFromInput(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  if (isRecord(input) && Array.isArray(input.result)) {
    return input.result;
  }
  return [];
}

export function extractTelegramCommands(
  input: unknown,
  options: TelegramCommandExtractionOptions = {}
): TelegramCommand[] {
  const commands: TelegramCommand[] = [];

  for (const update of updateListFromInput(input)) {
    if (!isRecord(update)) continue;

    for (const messageKey of ['message', 'channel_post'] as const) {
      const context = contextFromMessage(update[messageKey]);
      if (!context) continue;

      const command = parseCommand(context, options);
      if (command) {
        commands.push(command);
      }
    }
  }

  return commands;
}
