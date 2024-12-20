import { extractUrls } from './utils';
import { downloadTwitterMedia } from './twitter';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
  };
  text?: string;
}

interface TelegramUpdate {
  message?: TelegramMessage;
}

interface MediaItem {
  type: string;
  media_url_https?: string;
  variants?: Array<{
    bitrate?: number;
    url?: string;
  }>;
}

export interface DownloadResult {
  success: boolean;
  error?: string;
}

export async function sendMessage(chatId: number, text: string) {
  console.log('Sending message to Telegram:', { chatId, textLength: text.length });
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
  const result = await response.json();
  console.log('Message sent response:', result);
  return result;
}

export async function sendMediaGroup(chatId: number, media: any[], caption?: string) {
  console.log('Sending media group:', {
    chatId,
    mediaCount: media.length,
    captionLength: caption?.length,
    mediaDetails: media.map(m => ({
      type: m.type,
      mediaUrl: m.media
    }))
  });

  const formData = new FormData();
  formData.append('chat_id', chatId.toString());

  // 准备媒体数组
  const mediaArray = media.map((item, index) => {
    if (item.type === 'video') {
      return {
        type: 'video',
        media: `attach://video${index}`,
        caption: index === 0 ? caption : undefined,
        parse_mode: 'HTML'
      };
    } else if (item.type === 'photo') {
      return {
        type: 'photo',
        media: item.media,
        caption: index === 0 ? caption : undefined,
        parse_mode: 'HTML'
      };
    }
  });

  // 添加媒体数组到 FormData
  formData.append('media', JSON.stringify(mediaArray));

  // 添加所有视频文件到 FormData
  media.forEach((item, index) => {
    if (item.type === 'video') {
      const videoBlob = new Blob([item.media], { 
        type: 'video/mp4'
      });
      formData.append(`video${index}`, videoBlob, `video${index}.mp4`);
    }
  });

  console.log('Sending media group with FormData:', formData);

  const response = await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
    method: 'POST',
    body: formData,
  });

  const result = await response.json();
  console.log('Media group send response:', result);
  return result;
}

export async function deleteMessage(chatId: number, messageId: number) {
  const response = await fetch(`${TELEGRAM_API}/deleteMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
    }),
  });
  return response.json();
}

export async function processUpdate(update: TelegramUpdate) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text;

  if (!text) {
    return;
  }

  try {
    // Replace t.co links with their redirected URLs
    const processedText = await replaceShortLinks(text);
    
    // Extract URLs from the processed text
    const urls = extractUrls(processedText);
    const twitterUrls = urls.filter(url => url.includes('twitter.com') || url.includes('x.com'));

    if (twitterUrls.length === 0) {
      await sendMessage(chatId, '请发送Twitter/X链接以下载媒体内容。');
      return;
    }

    const processingMsg = await sendMessage(chatId, '正在处理您的请求...');

    for (const url of twitterUrls) {
      const tweetData = await downloadTwitterMedia(url);

      const caption = await formatTweetCaption(tweetData.tweet);

      // 如果是图片类型但没有媒体内容，只发送文本
      if (tweetData.type === 'photo' && !tweetData.media_items.length) {
        await sendMessage(chatId, caption);
        continue;
      }

      const mediaGroup = tweetData.media_items.map((item: MediaItem) => {
        const mediaObject = {
          type: item.type === 'video' ? 'video' : 'photo',
          media: item.type === 'video' ?
            (item.variants?.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url || '') :
            item.media_url_https,
        };
        return mediaObject;
      });

      if (mediaGroup.length > 0) {
        await sendMediaGroup(chatId, mediaGroup, caption);
      }
    }

    // Delete the processing message after completion
    if (processingMsg?.result?.message_id) {
      await deleteMessage(chatId, processingMsg.result.message_id);
    }
  } catch (error) {
    console.error('Error processing tweet:', error);
    const errorMsg = await sendMessage(chatId, '处理媒体内容时出错，请稍后重试。');
    if (errorMsg?.result?.message_id) {
      setTimeout(async () => {
        await deleteMessage(chatId, errorMsg.result.message_id);
      }, 5000); // Delete after 5 seconds
    }
  }
}

async function followRedirect(url: string): Promise<string> {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual'
  });
  
  console.log('Response status:', response.status);
  
  if (response.status === 301 || response.status === 302) {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('No redirect location found in 3xx response');
    }
    return location;
  }
  
  return response.url;
}

async function replaceShortLinks(text: string): Promise<string> {
  const tcoPattern = /https:\/\/t\.co\/[a-zA-Z0-9]+/g;
  const matches = text.match(tcoPattern);
  
  if (!matches) return text;
  
  let result = text;
  for (const shortUrl of matches) {
    try {
      const redirectedUrl = await followRedirect(shortUrl);
      result = result.replace(shortUrl, redirectedUrl);
    } catch (error) {
      console.error(`Error following redirect for ${shortUrl}:`, error);
    }
  }
  
  return result;
}

async function formatTweetCaption(tweet: any) {
  const text = await replaceShortLinks(tweet.text);
  return `
📱 <b>${tweet.user.name}</b> (@${tweet.user.screen_name})
${text}

❤️ ${tweet.favorite_count} 🔄 ${tweet.retweet_count} 💬 ${tweet.reply_count} 👀 ${tweet.view_count}`;
}

async function formatTweetCaption_without_name(tweet: any) {
  const text = await replaceShortLinks(tweet.text);
  return text;
}

export async function processDirectDownload(chatId: number, url: string): Promise<DownloadResult> {
  try {
    console.log('Starting processDirectDownload:', { chatId, url });

    console.log('Fetching tweet data...');
    const tweetData = await downloadTwitterMedia(url);
    console.log('Tweet data received:', {
      type: tweetData.type,
      mediaItemsCount: tweetData.media_items.length,
      mediaItems: tweetData.media_items.map((item: MediaItem) => ({
        type: item.type,
        hasVariants: !!item.variants,
        variantsCount: item.variants?.length,
        variants: item.variants?.map((v: { bitrate?: number; url?: string }) => ({
          bitrate: v.bitrate,
          url: v.url
        }))
      }))
    });

    console.log('Formatting tweet caption...');
    const caption = await formatTweetCaption_without_name(tweetData.tweet);

    if (tweetData.type === 'photo' && !tweetData.media_items.length) {
      console.log('No media items found, sending text only');
      await sendMessage(chatId, caption);
      return { success: true };
    }

    console.log('Processing media items...');
    const mediaGroup = await Promise.all(tweetData.media_items.map(async (item: MediaItem) => {
      console.log('Processing media item:', {
        type: item.type,
        hasVariants: !!item.variants,
        variantsCount: item.variants?.length
      });

      let mediaUrl: string | undefined;
      if (item.type === 'video' && item.variants) {
        const sortedVariants = item.variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        console.log('Sorted video variants:',
          sortedVariants.map(v => ({
            bitrate: v.bitrate,
            url: v.url
          }))
        );
        const selectedVariant = sortedVariants[0];
        console.log('Selected video variant:', {
          bitrate: selectedVariant?.bitrate,
          url: selectedVariant?.url
        });
        mediaUrl = selectedVariant?.url;
      } else if (item.type === 'photo') {
        mediaUrl = item.media_url_https;
      }

      // Download the media file if it's a video
      let fileData: any = null;
      if (item.type === 'video' && mediaUrl) {
        console.log('Downloading video file from:', mediaUrl);
        const response = await fetch(mediaUrl);
        if (!response.ok) {
          throw new Error(`Failed to download video: ${response.statusText}`);
        }
        fileData = await response.arrayBuffer();
        console.log('Video file downloaded successfully.');
      }

      const mediaObject = {
        type: item.type === 'video' ? 'video' : 'photo',
        media: item.type === 'video' ? fileData : mediaUrl, // Use fileData for video
      };
      console.log('Created media object:', mediaObject);
      return mediaObject;
    }));

    console.log('Media group prepared:', {
      count: mediaGroup.length,
      types: mediaGroup.map((m: { type: string }) => m.type),
      mediaUrls: mediaGroup.map((m: { media: string }) => m.media)
    });

    if (mediaGroup.length > 0) {
      console.log('Sending media to Telegram...');
      if (mediaGroup.length === 1 && mediaGroup[0].type === 'photo') {
        // 对于单张图片使用 sendPhoto
        await sendPhoto(chatId, mediaGroup[0].media, caption);
      } else {
        // 对于视频或多个媒体项使用 sendMediaGroup
        await sendMediaGroup(chatId, mediaGroup, caption);
      }
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function sendPhoto(chatId: number, photoUrl: string, caption?: string) {
  console.log('Sending photo:', {
    chatId,
    photoUrl,
    captionLength: caption?.length
  });

  const response = await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: 'HTML',
    }),
  });

  const result = await response.json();
  console.log('Photo send response:', result);
  return result;
}