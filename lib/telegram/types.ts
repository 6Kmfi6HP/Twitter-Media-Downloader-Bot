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

export interface MediaItem {
  type: 'video' | 'photo';
  media: string;
  caption?: string;
  parse_mode?: string;
}