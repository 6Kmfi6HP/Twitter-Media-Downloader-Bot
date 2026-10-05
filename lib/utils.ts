/** 读取环境变量整数配置；缺失/空/非法/非正数时回退默认值。 */
export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

/**
 * 推文 URL 提取正则，normalizeTweetKey 与 twitter/api.ts 共用，避免两处漂移。
 * 捕获组：1 = screenName（user/status 形态时；i/web、i 形态时为 undefined），2 = tweetId。
 * 覆盖 x.com / twitter.com / mobile.* / www.* 前缀，以及 i/web/status、i/status 分享形态。
 */
export const TWEET_STATUS_URL_RE =
  /(?:twitter|x)\.com\/(?:i\/(?:web\/)?|([\w-]+)\/)status\/(\d+)/i;

/** 去 query/hash、小写 host、去尾斜杠，得到不包含推文 ID 的 URL 的稳定形式。 */
function normalizeNonStatusUrl(url: string): string {
  let cleaned = url.trim();

  // 去 query / hash
  const cutIndex = cleaned.search(/[?#]/);
  if (cutIndex >= 0) cleaned = cleaned.slice(0, cutIndex);

  let result = cleaned;
  try {
    const parsed = new URL(cleaned);
    parsed.hostname = parsed.hostname.toLowerCase();
    result = parsed.toString();
  } catch {
    // 非绝对 URL：仅将 scheme://host 部分小写
    result = cleaned.replace(
      /^([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^/]+)/,
      (m) => m.toLowerCase()
    );
  }

  // 去尾斜杠
  return result.replace(/\/+$/, '');
}

/**
 * 归一化一条 Twitter/X 推文 URL 为去重键。
 * 命中 tweetId 返回 `tweet:{id}`；否则返回 `tweet:url:{归一化串}`。
 */
export function normalizeTweetKey(url: string): string {
  const statusMatch = url.match(TWEET_STATUS_URL_RE);
  if (statusMatch) {
    return `tweet:${statusMatch[2]}`;
  }
  return `tweet:url:${normalizeNonStatusUrl(url)}`;
}

/**
 * 清洗可能含敏感信息的错误文案：剥掉 TELEGRAM_BOT_TOKEN 字面量及 /bot[0-9]+:[^/\s]+/ 形态。
 * handler.ts 的 redactSensitive 对字符串统一委托到这里，勿再另建副本。
 */
export function redactErrorText(text: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  let redacted = token ? text.replaceAll(token, '<telegram-token>') : text;
  redacted = redacted.replace(/bot[0-9]+:[^/\s]+/g, 'bot<telegram-token>');
  return redacted;
}
