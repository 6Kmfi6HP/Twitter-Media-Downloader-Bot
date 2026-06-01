export interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
  };
  text?: string;
}

export interface TelegramUpdate {
  message?: TelegramMessage;
}

/**
 * Shape of a media item going INTO the Telegram `sendMediaGroup` endpoint.
 * Distinct from the Twitter source `TwitterMediaItem`: this is the post-fetch
 * `Buffer`/URL form. Renamed from the legacy `MediaItem` to avoid the type
 * collision noted in the proposal.
 */
export interface TelegramMediaItem {
  type: 'video' | 'photo';
  media: string;
  caption?: string;
  parse_mode?: string;
}
