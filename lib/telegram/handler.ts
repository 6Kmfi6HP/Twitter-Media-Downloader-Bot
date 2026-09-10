import { extractUrls } from '../utils';
import { downloadTwitterMedia } from '../twitter';
import type { TwitterMediaItem, TwitterResponse } from '../twitter/types';
import {
  sendMessage,
  sendPhoto,
  sendMediaGroup,
  sendLongCaption,
  deleteMessage,
  type MediaItem,
} from './messages';
import {
  formatTweetCaption,
  formatTweetCaption_without_name,
  pickBestMediaUrl,
} from './formatter';
import type { TelegramUpdate } from './types';
import { formatBytes, getMaxUploadBytes } from './limits';
import { isMtprotoConfigured, sendMediaGroupViaMtproto } from './mtproto';

export interface DownloadResult {
  success: boolean;
  error?: string;
}

function redactSensitive(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  let redacted = token ? value.replaceAll(token, '<telegram-token>') : value;
  redacted = redacted.replace(/bot[0-9]+:[^/\s]+/g, 'bot<telegram-token>');
  return redacted;
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { error: redactSensitive(error) };
  }

  const maybeError = error as Error & {
    code?: unknown;
    type?: unknown;
    status?: unknown;
    statusText?: unknown;
    error?: unknown;
    cause?: unknown;
  };
  const nested = maybeError.error;
  const nestedError = nested instanceof Error
    ? {
        name: nested.name,
        message: redactSensitive(nested.message),
        code: (nested as Error & { code?: unknown }).code,
        type: (nested as Error & { type?: unknown }).type,
        cause: redactSensitive((nested as Error & { cause?: unknown }).cause),
      }
    : nested && typeof nested === 'object'
      ? {
          status: (nested as { status?: unknown }).status,
          statusText: (nested as { statusText?: unknown }).statusText,
          message: redactSensitive((nested as { message?: unknown }).message),
        }
      : redactSensitive(nested);

  return {
    name: error.name,
    message: redactSensitive(error.message),
    code: maybeError.code,
    type: maybeError.type,
    status: maybeError.status,
    statusText: maybeError.statusText,
    cause: redactSensitive(maybeError.cause),
    nestedError,
  };
}

/**
 * Handles an inbound Telegram update. The behaviour mirrors the previous
 * monolithic `lib/telegram.ts`:
 *  1. Extract Twitter/X URLs from the message text.
 *  2. Send a "processing" message; delete it on success or auto-delete the
 *     error message after 5 seconds.
 *  3. For each URL, fetch the tweet and dispatch a single photo or a media
 *     group (with video support via `InputFile`).
 */
export async function processUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text;

  const urls = extractUrls(text);
  const twitterUrls = urls.filter(
    (url) => url.includes('twitter.com') || url.includes('x.com')
  );

  if (twitterUrls.length === 0) {
    await sendMessage(chatId, '请发送Twitter/X链接以下载媒体内容。');
    return;
  }

  const processingMsg = await sendMessage(chatId, '正在处理您的请求...');

  try {
    for (const url of twitterUrls) {
      const tweetData = await downloadTwitterMedia(url);

      if (tweetData.media_items.length === 0) {
        await sendMessage(chatId, '未找到媒体内容。');
        continue;
      }

      const caption = await formatTweetCaption(tweetData.tweet);
      await dispatchTweet(chatId, tweetData, caption, url);
    }

    // Delete the processing message after a successful run.
    await deleteMessage(chatId, processingMsg.message_id);
  } catch (error) {
    console.error('Error processing tweet:', error);
    // Tell the user something went wrong; auto-cleanup after 5 s.
    await sendMessage(chatId, '处理媒体内容时出错，请稍后重试。');
    setTimeout(() => {
      void deleteMessage(chatId, processingMsg.message_id);
    }, 5000);
  }
}

async function getContentLength(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const header = response.headers.get('content-length');
    if (!header) return undefined;
    const parsed = Number(header);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Routes a tweet to either `sendPhoto` (single photo) or `sendMediaGroup`
 * (video or mixed). For articles with long captions, sends a short caption
 * with media group first, then the full text as a separate message.
 */
async function dispatchTweet(
  chatId: number | string,
  tweetData: TwitterResponse,
  caption: string,
  tweetUrl?: string
): Promise<void> {
  const isLongCaption = caption.length > 1024;
  // Article with multiple images: use short caption for media group
  const isArticle = tweetData.tweet.text?.includes('📝') ||
                    (tweetData.media_items.length > 2 && isLongCaption);

  // Single photo: prefer `sendPhoto` for nicer UX.
  if (tweetData.media_items.length === 1 && tweetData.media_items[0].type === 'photo') {
    const photo = tweetData.media_items[0];
    const photoUrl = photo.media_url_https;
    if (!photoUrl) {
      await sendMessage(chatId, caption);
      return;
    }
    await sendPhoto(chatId, photoUrl, caption);
    if (isLongCaption) {
      await sendLongCaption(chatId, caption);
    }
    return;
  }

  // Mixed / video: build a media group. Videos must be downloaded to a
  // Buffer first because Telegram's media group endpoint requires real
  // multipart data for video files.
  //
  // Two-pass build:
  //  1. First iterate and compute sizes (HEAD) for every video so we can
  //     decide whether the entire group must be routed over MTProto.
  //  2. Then either upload everything through mtcute (when any item exceeds
  //     the Bot API limit and MTProto is configured), or fall through to the
  //     existing Bot API path that skips oversized items individually.
  interface SizedItem {
    item: (typeof tweetData.media_items)[number];
    url: string | undefined;
    size: number | undefined;
  }
  const sized: SizedItem[] = [];
  const videoFilename = `TG@haren2024_${tweetData.tweet.id}.mp4`;

  for (const item of tweetData.media_items) {
    const url = pickBestMediaUrl(item);
    if (!url) continue;
    if (item.type === 'video') {
      sized.push({ item, url, size: await getContentLength(url) });
    } else {
      sized.push({ item, url, size: undefined });
    }
  }

  const maxBytes = getMaxUploadBytes();
  const hasOversizedVideo = sized.some(
    (entry) =>
      entry.item.type === 'video' &&
      entry.size !== undefined &&
      entry.size > maxBytes
  );

  // MTProto path: only when the configuration is present *and* at least one
  // video exceeds the Bot API limit. Group always goes through MTProto as a
  // whole so Telegram renders one album for the tweet.
  if (hasOversizedVideo && isMtprotoConfigured()) {
    const mediaForMtproto: MediaItem[] = [];
    for (const entry of sized) {
      try {
        if (entry.item.type === 'video') {
          const res = await fetch(entry.url!);
          if (!res.ok) continue;
          mediaForMtproto.push({
            type: 'video',
            media: Buffer.from(await res.arrayBuffer()),
            filename: videoFilename,
          });
        } else {
          mediaForMtproto.push({ type: 'photo', media: entry.url! });
        }
      } catch (err) {
        console.warn('[telegram] failed to download media for mtproto', {
          url: entry.url,
          err,
        });
      }
    }

    if (mediaForMtproto.length > 0) {
      try {
        await sendMediaGroupViaMtproto(chatId, mediaForMtproto, caption);
        if (isLongCaption) {
          await sendLongCaption(chatId, caption);
        }
        return;
      } catch (err) {
        console.error(
          '[telegram] mtproto sendMediaGroup failed, falling back to Bot API',
          err
        );
        // fall through to Bot API path
      }
    }
  }

  // Bot API path (existing behaviour): skip videos that exceed the limit,
  // send the rest via grammY.
  const media: MediaItem[] = [];
  for (const entry of sized) {
    if (entry.item.type === 'video') {
      if (entry.size !== undefined && entry.size > maxBytes) {
        await sendMessage(
          chatId,
          `⚠️ 视频过大（${formatBytes(entry.size)}），暂不支持直接发送。${tweetUrl ? `请打开原推查看：${tweetUrl}` : '请稍后重试。'}`
        );
        continue;
      }

      const res = await fetch(entry.url!);
      if (!res.ok) {
        throw new Error(`Failed to download video: ${res.statusText}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      media.push({ type: 'video', media: buf, filename: videoFilename });
    } else {
      media.push({ type: 'photo', media: entry.url! });
    }
  }

  if (media.length === 0) {
    await sendMessage(chatId, caption);
    return;
  }

  // For articles with long captions, send short caption with media, then full text
  if (isArticle && isLongCaption) {
    const authorLine = caption.split('\n')[0] || '';
    const shortCaption = authorLine.length > 1021
      ? authorLine.substring(0, 1021) + '...'
      : authorLine;
    await sendMediaGroup(chatId, media, shortCaption);
    await sendLongCaption(chatId, caption);
  } else {
    await sendMediaGroup(chatId, media, caption);
    if (isLongCaption) {
      await sendLongCaption(chatId, caption);
    }
  }
}

/**
 * Downloads the media for a single Twitter URL and posts it to a chat.
 * Preserves the previous `{ success, error? }` return shape so existing
 * callers in `app/api/download/route.ts` keep working.
 */
export async function processDirectDownload(
  chatId: number | string,
  url: string
): Promise<DownloadResult> {
  try {
    const tweetData = await downloadTwitterMedia(url);
    const caption = await formatTweetCaption_without_name(tweetData.tweet);

    if (tweetData.type === 'photo' && tweetData.media_items.length === 0) {
      if (!caption || caption.trim().length === 0) {
        return { success: false, error: 'No media or text content found in tweet' };
      }
      await sendMessage(chatId, caption);
      return { success: true };
    }

    await dispatchTweet(chatId, tweetData, caption, url);
    return { success: true };
  } catch (error) {
    console.error('[telegram] processDirectDownload failed', {
      chatId,
      url,
      error: summarizeError(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

// Re-export helpers for testing and for backward compatibility.
export { pickBestMediaUrl } from './formatter';
export type { TwitterMediaItem };
