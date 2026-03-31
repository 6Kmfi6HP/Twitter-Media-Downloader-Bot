import type { TwitterResponse, TwitterMediaItem } from './types';

const FIXTWEET_API_BASE = 'https://api.fxtwitter.com';

// FixTweet API 响应类型
interface FixTweetAPIResponse {
  code: number;
  message: string;
  tweet?: {
    id: string;
    url: string;
    text: string;
    created_at: string;
    created_timestamp: number;
    author: {
      name: string;
      screen_name: string;
      avatar_url?: string;
      avatar_color?: string;
      banner_url?: string;
    };
    replies: number;
    retweets: number;
    likes: number;
    views?: number;
    media?: {
      photos?: Array<{
        type: 'photo';
        url: string;
        width: number;
        height: number;
      }>;
      videos?: Array<{
        type: 'video' | 'gif';
        url: string;
        thumbnail_url: string;
        width: number;
        height: number;
        format: string;
        duration?: number;
      }>;
    };
    article?: {
      title: string;
      preview_text: string;
      cover_media?: {
        media_info?: {
          original_img_url: string;
          original_img_width: number;
          original_img_height: number;
        };
      };
      content?: {
        blocks: Array<{
          type: string;
          text: string;
        }>;
      };
    };
  };
}

function extractTweetInfo(url: string): { tweetId: string | null; screenName: string | null } {
  const match = url.match(/(?:twitter|x)\.com\/(\w+)\/status\/(\d+)/);
  if (match) {
    return { screenName: match[1], tweetId: match[2] };
  }
  return { tweetId: null, screenName: null };
}

function buildArticleText(article: NonNullable<NonNullable<FixTweetAPIResponse['tweet']>['article']>): string {
  const parts: string[] = [];

  if (article.title) {
    parts.push(`📝 ${article.title}`);
    parts.push('');
  }

  if (article.content?.blocks) {
    for (const block of article.content.blocks) {
      if (block.type === 'atomic' || !block.text.trim()) {
        parts.push('');
      } else if (block.type === 'header-two' || block.type === 'header-three') {
        parts.push(`\n▎${block.text}`);
      } else if (block.type === 'unordered-list-item') {
        parts.push(`• ${block.text}`);
      } else if (block.type === 'ordered-list-item') {
        parts.push(`· ${block.text}`);
      } else {
        parts.push(block.text);
      }
    }
  } else if (article.preview_text) {
    parts.push(article.preview_text);
  }

  // 去除连续空行
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function determineMediaType(mediaItems: TwitterMediaItem[]): 'video' | 'photo' | 'mixed' {
  const hasVideo = mediaItems.some(item => item.type === 'video');
  const hasPhoto = mediaItems.some(item => item.type === 'photo');
  if (hasVideo && hasPhoto) return 'mixed';
  return hasVideo ? 'video' : 'photo';
}

function convertFixTweetResponse(data: FixTweetAPIResponse, tweetId: string): TwitterResponse {
  const tweet = data.tweet!;
  const mediaItems: TwitterMediaItem[] = [];

  if (tweet.media?.photos) {
    for (const photo of tweet.media.photos) {
      const size = { w: photo.width, h: photo.height, resize: 'fit' as const };
      mediaItems.push({
        type: 'photo',
        url: photo.url,
        media_url_https: photo.url,
        sizes: { large: size, medium: size, small: size, thumb: size },
      });
    }
  }

  if (tweet.media?.videos) {
    for (const video of tweet.media.videos) {
      const size = { w: video.width, h: video.height, resize: 'fit' as const };
      mediaItems.push({
        type: 'video',
        url: video.thumbnail_url || video.url,
        media_url_https: video.thumbnail_url || video.url,
        sizes: { large: size, medium: size, small: size, thumb: size },
        variants: [{ content_type: video.format, url: video.url }],
        duration_millis: video.duration ? Math.round(video.duration * 1000) : undefined,
        aspect_ratio: [video.width, video.height],
      });
    }
  }

  // 处理文章类型：提取封面图片作为媒体，文章标题+预览作为文本
  if (tweet.article) {
    const coverMedia = tweet.article.cover_media?.media_info;
    if (coverMedia?.original_img_url && mediaItems.length === 0) {
      const size = { w: coverMedia.original_img_width, h: coverMedia.original_img_height, resize: 'fit' as const };
      mediaItems.push({
        type: 'photo',
        url: coverMedia.original_img_url,
        media_url_https: coverMedia.original_img_url,
        sizes: { large: size, medium: size, small: size, thumb: size },
      });
    }
  }

  // 构建文本：优先使用 tweet.text，如果为空则从文章内容提取完整文本
  let text = tweet.text;
  if (!text && tweet.article) {
    text = buildArticleText(tweet.article);
  }

  return {
    type: mediaItems.length > 0 ? determineMediaType(mediaItems) : 'photo',
    media_items: mediaItems,
    tweet: {
      id: tweetId,
      text,
      created_at: tweet.created_at,
      user: {
        name: tweet.author.name,
        screen_name: tweet.author.screen_name,
        profile_image_url: tweet.author.avatar_url || '',
        is_blue_verified: false,
        description: '',
        followers_count: 0,
        following_count: 0,
      },
      reply_count: tweet.replies,
      retweet_count: tweet.retweets,
      quote_count: 0,
      favorite_count: tweet.likes,
      view_count: tweet.views,
    },
  };
}

async function getTweetDetails(tweetId: string, screenName?: string): Promise<FixTweetAPIResponse> {
  const apiUrl = `${FIXTWEET_API_BASE}/${screenName || 'status'}/status/${tweetId}`;

  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': 'x-video-dl/1.0' },
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('PRIVATE_TWEET');
    if (response.status === 404) throw new Error('NOT_FOUND');
    throw new Error(`Failed to fetch tweet data: ${response.statusText}`);
  }

  return await response.json();
}

export async function downloadTwitterMedia(url: string): Promise<TwitterResponse> {
  const { tweetId, screenName } = extractTweetInfo(url);
  if (!tweetId) {
    throw new Error('Invalid tweet URL');
  }

  const fixTweetData = await getTweetDetails(tweetId, screenName || undefined);

  if (fixTweetData.code !== 200 || !fixTweetData.tweet) {
    throw new Error(fixTweetData.message || 'Failed to fetch tweet data');
  }

  return convertFixTweetResponse(fixTweetData, tweetId);
}
