export interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
  };
  text?: string;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

