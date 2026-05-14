import 'dotenv/config';
import { fetchTelegramUpdates, extractChatsFromUpdates } from './telegram-updates.js';

const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!botToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

const updates = await fetchTelegramUpdates({
  botToken,
  proxyUrl: process.env.PROXY_URL?.trim()
});

const chats = extractChatsFromUpdates(updates);

console.log(JSON.stringify({ updateCount: updates.length, chats }, null, 2));
