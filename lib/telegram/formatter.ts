import type { TwitterTweet } from '../twitter/types';
import { escapeHtml } from './caption';

/**
 * Returns the highest-bitrate MP4 variant URL for a Twitter media item, or
 * the photo URL when the item is a photo. Returns `undefined` if no usable
 * URL is present.
 */
export function pickBestMediaUrl(item: {
  type: 'video' | 'photo';
  media_url_https?: string;
  variants?: Array<{ bitrate?: number; url?: string }>;
}): string | undefined {
  if (item.type === 'video' && item.variants && item.variants.length > 0) {
    const sorted = [...item.variants].sort(
      (a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0)
    );
    return sorted[0]?.url;
  }
  return item.media_url_https;
}

/**
 * Follows t.co short-links in a piece of text. If a link cannot be expanded
 * (network error, no redirect) the original token is left in place.
 */
export async function replaceShortLinks(text: string): Promise<string> {
  const tcoPattern = /https:\/\/t\.co\/[a-zA-Z0-9]+/g;
  const matches = text.match(tcoPattern);
  if (!matches) return text;

  let result = text;
  for (const shortUrl of matches) {
    try {
      const expanded = await followRedirect(shortUrl);
      result = result.replace(shortUrl, expanded);
    } catch (err) {
      console.error(`[telegram] failed to expand ${shortUrl}:`, err);
    }
  }
  return result;
}

async function followRedirect(url: string): Promise<string> {
  const response = await fetch(url, { method: 'GET', redirect: 'manual' });
  if (response.status === 301 || response.status === 302) {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('No redirect location found in 3xx response');
    }
    return location;
  }
  return response.url;
}

/**
 * Returns just the tweet text (with t.co short links expanded and HTML
 * escaped). Used by the direct download path which already shows the user
 * header on the request page. Uses translated text if available.
 */
export async function formatTweetCaption_without_name(
  tweet: TwitterTweet
): Promise<string> {
  // 优先使用翻译后的文本
  const rawText = tweet.translated_text || tweet.text;
  const text = await replaceShortLinks(rawText);
  return escapeHtml(text);
}


