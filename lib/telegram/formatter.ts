import type { TwitterTweet, TwitterMediaItem } from '../twitter/types';
import type { MediaItem } from './types';

export function formatTweetCaption(tweet: TwitterTweet): string {
  return `
📱 <b>${tweet.user.name}</b> (@${tweet.user.screen_name})
${tweet.text}

❤️ ${tweet.favorite_count} | 🔄 ${tweet.retweet_count} | 💬 ${tweet.reply_count}
${tweet.view_count ? `👁️ ${tweet.view_count} views` : ''}
`.trim();
}

export function formatMediaGroup(mediaItems: TwitterMediaItem[]): MediaItem[] {
  return mediaItems.map(item => ({
    type: item.type === 'video' ? 'video' : 'photo',
    media: item.type === 'video' ? 
      (item.variants?.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url || '') :
      item.media_url_https,
  }));
}