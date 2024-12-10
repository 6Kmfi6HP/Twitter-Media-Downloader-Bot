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

  // Assuming only one video for simplicity
  const videoItem = media.find(item => item.type === 'video');
  if (!videoItem) {
    console.error('No video found in media group.');
    return;
  }

  const formData = new FormData();
  formData.append('chat_id', chatId.toString());
  formData.append('media', JSON.stringify([{
    type: 'video',
    media: 'attach://video',
    caption: caption,
    parse_mode: 'HTML',
  }]));
  
  // 创建带有正确 MIME 类型的 Blob
  const videoBlob = new Blob([videoItem.media], { 
    type: 'video/mp4'  // 指定 MIME 类型
  });
  
  // 使用带有类型的 Blob 创建文件
  formData.append('video', videoBlob, 'video.mp4');

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
  const urls = extractUrls(message.text);
  const twitterUrls = urls.filter(url => url.includes('twitter.com') || url.includes('x.com'));

  if (twitterUrls.length === 0) {
    await sendMessage(chatId, '请发送Twitter/X链接以下载媒体内容。');
    return;
  }

  try {
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

function formatTweetCaption(tweet: any) {
  return `
📱 <b>${tweet.user.name}</b> (@${tweet.user.screen_name})
${tweet.text}

❤️ ${tweet.favorite_count} | 🔄 ${tweet.retweet_count} | 💬 ${tweet.reply_count}
${tweet.view_count ? `👁️ ${tweet.view_count} views` : ''}
`.trim();
}

export async function formatTweetCaption_without_name(tweet: any) {
  const { text, user } = tweet;
  return `${text}`;
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
      console.log('Sending media group to Telegram...');
      // This part needs to be updated to handle file uploads
      const sendResult = await sendMediaGroup(chatId, mediaGroup, caption);
      console.log('Media group send result:', sendResult);
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}