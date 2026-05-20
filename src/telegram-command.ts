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

interface MessageContext {
  text: string;
  chatId: string;
  messageId: number;
  username?: string;
}

const EXPORT_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

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

function parseCommand(context: MessageContext): TelegramCommand | null {
  const text = context.text;
  const parts = text.split(/\s+/).filter(Boolean);
  const head = parts[0];

  if (text === '查看聊天ID' || /^\/chatid(?:@[A-Za-z0-9_]+)?$/.test(text)) {
    return {
      type: 'chat-id',
      ...baseCommand(context)
    };
  }

  const isChineseExport = head === '导出分析';
  const isEnglishExport = /^\/export_analysis(?:@[A-Za-z0-9_]+)?$/.test(head ?? '');
  if (!isChineseExport && !isEnglishExport) {
    return null;
  }

  const args = parts.slice(1);
  if (args.length !== 2 || !EXPORT_HOUR_PATTERN.test(args[0]) || !EXPORT_HOUR_PATTERN.test(args[1])) {
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

export function extractTelegramCommands(updates: unknown[]): TelegramCommand[] {
  const commands: TelegramCommand[] = [];

  for (const update of updates) {
    if (!isRecord(update)) continue;

    for (const messageKey of ['message', 'channel_post'] as const) {
      const context = contextFromMessage(update[messageKey]);
      if (!context) continue;

      const command = parseCommand(context);
      if (command) {
        commands.push(command);
      }
    }
  }

  return commands;
}
