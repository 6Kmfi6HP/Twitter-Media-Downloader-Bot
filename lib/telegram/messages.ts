import {
  InputFile,
  InputMediaBuilder,
} from 'grammy';
import type { Message } from '@grammyjs/types';
import { bot } from './bot';
import { escapeHtml, truncateForCaption } from './caption';
import { getTelegramApiRoot } from './limits';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

class TelegramApiRequestError extends Error {
  constructor(method: string, response: TelegramApiResponse<unknown>) {
    super(
      `Call to '${method}' failed! (${response.error_code ?? 'unknown'}: ${
        response.description ?? 'Unknown Telegram API error'
      })`
    );
    this.name = 'TelegramApiRequestError';
  }
}

/** Guards: ensures the bot is initialised before calling the API. */
function getBot() {
  if (!bot) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set — cannot call Telegram API');
  }
  return bot;
}

function telegramApiUrl(method: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set — cannot call Telegram API');
  }
  return `${getTelegramApiRoot()}/bot${token}/${method}`;
}

async function parseTelegramResponse<T>(
  method: string,
  response: Response
): Promise<T> {
  const raw = await response.text();
  let payload: TelegramApiResponse<T>;
  try {
    payload = JSON.parse(raw) as TelegramApiResponse<T>;
  } catch {
    throw new Error(
      `Telegram '${method}' returned a non-JSON response (${response.status} ${response.statusText})`
    );
  }

  if (!response.ok || !payload.ok) {
    throw new TelegramApiRequestError(method, payload);
  }

  return payload.result as T;
}

async function postTelegramJson<T>(
  method: string,
  payload: Record<string, unknown>
): Promise<T> {
  const response = await fetch(telegramApiUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseTelegramResponse<T>(method, response);
}

async function postTelegramForm<T>(
  method: string,
  formData: FormData
): Promise<T> {
  const response = await fetch(telegramApiUrl(method), {
    method: 'POST',
    body: formData,
  });
  return parseTelegramResponse<T>(method, response);
}

function isGrammyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'HttpError' ||
    error.message.startsWith('Network request for ')
  );
}

async function withNativeTelegramFallback<T>(
  method: 'sendPhoto' | 'sendMediaGroup',
  primary: () => Promise<T>,
  fallback: () => Promise<T>
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (!isGrammyNetworkError(error)) throw error;
    const networkError = error as Error;

    console.warn(`[telegram] grammY ${method} failed; retrying native Bot API`, {
      name: networkError.name,
      message: networkError.message,
    });
    return fallback();
  }
}

/** Maximum characters in a media caption (Telegram Bot API limit). */
export const CAPTION_LIMIT = 1024;
/** Maximum characters in a text message (Telegram Bot API limit). */
export const MESSAGE_LIMIT = 4096;

/** Photo items point at a public URL. */
export interface PhotoMediaItem {
  type: 'photo';
  media: string;
}

/** Video items carry an in-memory buffer that we ship via multipart upload. */
export interface VideoMediaItem {
  type: 'video';
  media: Buffer;
  filename?: string;
}

export type MediaItem = PhotoMediaItem | VideoMediaItem;

export interface SendMessageOptions {
  /** Override the default `parse_mode` ("HTML"). */
  parse_mode?: 'HTML' | 'MarkdownV2' | 'Markdown';
  /** Disable web-page preview. */
  disable_web_page_preview?: boolean;
}

export interface SendPhotoOptions {
  parse_mode?: 'HTML' | 'MarkdownV2' | 'Markdown';
}

export interface SendMediaGroupOptions {
  parse_mode?: 'HTML' | 'MarkdownV2' | 'Markdown';
}

/**
 * Sends a text message. Default `parse_mode` is `HTML`.
 */
export async function sendMessage(
  chatId: number | string,
  text: string,
  options: SendMessageOptions = {}
): Promise<Message.TextMessage> {
  return getBot().api.sendMessage(chatId, text, {
    parse_mode: options.parse_mode ?? 'HTML',
    link_preview_options: options.disable_web_page_preview
      ? { is_disabled: true }
      : undefined,
  });
}

/**
 * Sends a single photo with a caption. The caption is HTML-escaped and
 * truncated to 1024 characters.
 */
export async function sendPhoto(
  chatId: number | string,
  photo: string,
  caption?: string,
  options: SendPhotoOptions = {}
): Promise<Message.PhotoMessage> {
  const parseMode = options.parse_mode ?? 'HTML';
  const safeCaption = caption !== undefined
    ? truncateForCaption(escapeHtml(caption), CAPTION_LIMIT)
    : undefined;

  return withNativeTelegramFallback(
    'sendPhoto',
    () => getBot().api.sendPhoto(chatId, photo, {
      caption: safeCaption,
      parse_mode: parseMode,
    }),
    () => postTelegramJson<Message.PhotoMessage>('sendPhoto', {
      chat_id: chatId,
      photo,
      caption: safeCaption,
      parse_mode: parseMode,
    })
  );
}

/**
 * Sends a media group (up to 10 items) with optional caption attached only to
 * the first item. Video items are uploaded as multipart via `InputFile`;
 * photo items reference the URL directly.
 */
export async function sendMediaGroup(
  chatId: number | string,
  media: MediaItem[],
  caption?: string,
  options: SendMediaGroupOptions = {}
): Promise<Message[]> {
  const parseMode = options.parse_mode ?? 'HTML';
  const safeCaption =
    caption !== undefined
      ? truncateForCaption(escapeHtml(caption), CAPTION_LIMIT)
      : undefined;

  const inputMedia = media.map((item, index) => {
    const itemOpts = {
      caption: index === 0 ? safeCaption : undefined,
      parse_mode: parseMode as 'HTML' | 'MarkdownV2' | 'Markdown',
    };
    if (item.type === 'video') {
      return InputMediaBuilder.video(
        new InputFile(item.media, item.filename || 'video.mp4'),
        itemOpts
      );
    }
    return InputMediaBuilder.photo(item.media, itemOpts);
  });

  return withNativeTelegramFallback<Message[]>(
    'sendMediaGroup',
    () => getBot().api.sendMediaGroup(chatId, inputMedia),
    () => nativeSendMediaGroup(chatId, media, safeCaption, parseMode)
  );
}

async function nativeSendMediaGroup(
  chatId: number | string,
  media: MediaItem[],
  caption: string | undefined,
  parseMode: 'HTML' | 'MarkdownV2' | 'Markdown'
): Promise<Message[]> {
  const hasUploads = media.some((item) => item.type === 'video');
  const mediaPayload = media.map((item, index) => ({
    type: item.type,
    media:
      item.type === 'video'
        ? `attach://video${index}`
        : item.media,
    caption: index === 0 ? caption : undefined,
    parse_mode: parseMode,
  }));

  if (!hasUploads) {
    return postTelegramJson<Message[]>('sendMediaGroup', {
      chat_id: chatId,
      media: mediaPayload,
    });
  }

  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append('media', JSON.stringify(mediaPayload));

  media.forEach((item, index) => {
    if (item.type !== 'video') return;
    const filename = item.filename || `video${index}.mp4`;
    const blob = new Blob([new Uint8Array(item.media)], { type: 'video/mp4' });
    formData.append(`video${index}`, blob, filename);
  });

  return postTelegramForm<Message[]>('sendMediaGroup', formData);
}

/**
 * Sends a long caption (over 1024 chars) as a series of plain text messages.
 * Returns the array of resulting SDK messages.
 */
export async function sendLongCaption(
  chatId: number | string,
  text: string,
  options: SendMessageOptions = {}
): Promise<Message[]> {
  const messages: Message[] = [];
  for (let i = 0; i < text.length; i += MESSAGE_LIMIT) {
    const chunk = text.slice(i, i + MESSAGE_LIMIT);
    const sent = await sendMessage(chatId, chunk, options);
    messages.push(sent);
  }
  return messages;
}

/**
 * Deletes a message. Returns `true` on success and `false` when the message
 * is too old (>48h) or otherwise undeletable. Other errors propagate.
 */
export async function deleteMessage(
  chatId: number | string,
  messageId: number
): Promise<boolean> {
  try {
    await getBot().api.deleteMessage(chatId, messageId);
    return true;
  } catch (err) {
    // GrammyError has `error_code` and `description` fields on the error
    // object; use duck-typing because Edge runtime webpack may not expose
    // the `GrammyError` class as a named export.
    const error = err as Record<string, unknown> | undefined;
    if (error && typeof error === 'object' && 'error_code' in error) {
      console.warn('[telegram] deleteMessage GrammyError', {
        code: error.error_code,
        description: error.description,
      });
      return false;
    }
    throw err;
  }
}
