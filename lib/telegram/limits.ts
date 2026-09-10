export const DEFAULT_TELEGRAM_API_ROOT = 'https://api.telegram.org';

export function getTelegramApiRoot(): string {
  const configured = process.env.TELEGRAM_API_ROOT?.trim();
  if (!configured) return DEFAULT_TELEGRAM_API_ROOT;
  return configured.replace(/\/$/, '');
}

export function getMaxUploadBytes(): number {
  // Official Bot API accepts multipart uploads up to 50 MB. A self-hosted
  // Bot API server run with `--local` raises that to 2000 MB.
  return process.env.TELEGRAM_API_ROOT?.trim()
    ? 2000 * 1024 * 1024
    : 50 * 1024 * 1024;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}
