export interface TwitterUser {
  name: string;
  screen_name: string;
  profile_image_url: string;
  is_blue_verified: boolean;
  description: string;
  followers_count: number;
  following_count: number;
}

export interface TwitterMediaVariant {
  content_type: string;
  bitrate?: number;
  url: string;
}

export interface TwitterMediaSize {
  w: number;
  h: number;
  resize: 'fit' | 'crop';
}

export interface TwitterMediaItem {
  type: 'video' | 'photo';
  url: string;
  media_url_https: string;
  sizes: {
    large: TwitterMediaSize;
    medium: TwitterMediaSize;
    small: TwitterMediaSize;
    thumb: TwitterMediaSize;
  };
  variants?: TwitterMediaVariant[];
  duration_millis?: number;
  aspect_ratio?: number[];
}

export interface TwitterTweet {
  id: string;
  text: string;
  created_at: string;
  user: TwitterUser;
  reply_count: number;
  retweet_count: number;
  quote_count: number;
  favorite_count: number;
  view_count?: number;
}

export interface TwitterResponse {
  type: 'video' | 'photo' | 'mixed';
  media_items: TwitterMediaItem[];
  tweet: TwitterTweet;
}