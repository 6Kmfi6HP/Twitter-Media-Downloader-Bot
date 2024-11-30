import { TELEGRAM_API } from './config';
import type { MediaItem } from './types';

interface SendMessageResponse {
  ok: boolean;
  result?: {
    message_id: number;
  };
  description?: string;
}

export async function sendMessage(chatId: number, text: string): Promise<SendMessageResponse> {
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
  return response.json();
}

export async function sendMediaGroup(
  chatId: number, 
  media: MediaItem[], 
  caption?: string
): Promise<SendMessageResponse> {
  const response = await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      media: media.map((item, index) => ({
        ...item,
        caption: index === 0 ? caption : undefined,
        parse_mode: 'HTML',
      })),
    }),
  });
  return response.json();
}