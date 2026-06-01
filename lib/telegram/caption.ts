/**
 * Caption / text utilities for Telegram messages.
 *
 * The functions here are pure and side-effect free so they can be unit-tested
 * without any external network or SDK dependency.
 */

/**
 * Escapes the five HTML special characters recommended by grammY's
 * `entity-parser` `textSanitizer` default implementation. We apply this to any
 * user-provided caption before sending it to Telegram with `parse_mode: "HTML"`
 * to prevent 400 "Cannot parse entities" errors.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Truncates a caption to fit Telegram's 1024-character caption limit. When the
 * text exceeds `limit` characters, the function returns the first `limit - 3`
 * characters followed by an ellipsis (`...`). Text at exactly `limit` is
 * returned unchanged.
 *
 * NOTE: callers should `escapeHtml` BEFORE calling `truncateForCaption` so that
 * the resulting entity references (`&amp;` etc.) are not sliced in half.
 */
export function truncateForCaption(text: string, limit = 1024): string {
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit - 3) + '...';
}
