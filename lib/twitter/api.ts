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
    lang?: string;
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
      media_entities?: Array<{
        media_id: string;
        media_info?: {
          original_img_url: string;
          original_img_width: number;
          original_img_height: number;
        };
      }>;
    };
    translation?: {
      text: string;
      source_lang: string;
      target_lang: string;
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

function convertFixTweetResponse(data: FixTweetAPIResponse, tweetId: string, translatedData?: FixTweetAPIResponse): TwitterResponse {
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

  // 处理文章类型：提取封面图片和文章内嵌图片作为媒体
  if (tweet.article) {
    // 提取封面图片
    const coverMedia = tweet.article.cover_media?.media_info;
    if (coverMedia?.original_img_url) {
      const size = { w: coverMedia.original_img_width, h: coverMedia.original_img_height, resize: 'fit' as const };
      mediaItems.push({
        type: 'photo',
        url: coverMedia.original_img_url,
        media_url_https: coverMedia.original_img_url,
        sizes: { large: size, medium: size, small: size, thumb: size },
      });
    }

    // 提取文章内嵌图片 (media_entities)
    const articleMediaEntities = tweet.article.media_entities;
    if (Array.isArray(articleMediaEntities)) {
      for (const entity of articleMediaEntities) {
        const mediaInfo = entity.media_info;
        if (mediaInfo?.original_img_url) {
          // 避免重复添加封面图片
          const isDuplicate = mediaItems.some(
            item => item.media_url_https === mediaInfo.original_img_url
          );
          if (!isDuplicate) {
            const size = {
              w: mediaInfo.original_img_width,
              h: mediaInfo.original_img_height,
              resize: 'fit' as const
            };
            mediaItems.push({
              type: 'photo',
              url: mediaInfo.original_img_url,
              media_url_https: mediaInfo.original_img_url,
              sizes: { large: size, medium: size, small: size, thumb: size },
            });
          }
        }
      }
    }
  }

  // 构建文本：优先使用 tweet.text，如果为空则从文章内容提取完整文本
  let text = tweet.text;
  if (!text && tweet.article) {
    text = buildArticleText(tweet.article);
  }

  // 获取翻译文本（如果有）
  const translatedText = translatedData?.tweet?.translation?.text || data.tweet?.translation?.text;

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
      lang: tweet.lang,
      translated_text: translatedText,
    },
  };
}

async function getTweetDetails(tweetId: string, screenName?: string, translateTo?: string): Promise<FixTweetAPIResponse> {
  let apiUrl = `${FIXTWEET_API_BASE}/${screenName || 'status'}/status/${tweetId}`;
  if (translateTo) {
    apiUrl += `/${translateTo}`;
  }

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

/**
 * 检测语言是否为中文
 */
function isChineseLanguage(lang?: string | null): boolean {
  if (!lang) return true; // 如果无法检测，默认认为是中文
  return lang.startsWith('zh');
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

  // 检测语言，如果不是中文则自动翻译
  const lang = fixTweetData.tweet.lang;
  let translatedData: FixTweetAPIResponse | undefined;

  if (!isChineseLanguage(lang)) {
    try {
      translatedData = await getTweetDetails(tweetId, screenName || undefined, 'zh');
    } catch (err) {
      console.error('[twitter] Translation failed, using original text:', err);
    }
  }

  return convertFixTweetResponse(fixTweetData, tweetId, translatedData);
}
