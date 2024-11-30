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

export async function sendMessage(chatId: number, text: string) {
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
  return response.json();
}

export async function sendMediaGroup(chatId: number, media: any[], caption?: string) {
  const response = await fetch(`${TELEGRAM_API}/sendMediaGroup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      media: media.map((item, index) => ({
        ...item,
        caption: index === 0 ? caption : undefined,
        parse_mode: 'HTML',
      })),
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
    await sendMessage(chatId, '正在处理您的请求...');

    for (const url of twitterUrls) {
      const tweetData = await downloadTwitterMedia(url);
      
      if (!tweetData.media_items.length) {
        await sendMessage(chatId, '未找到媒体内容。');
        continue;
      }

      const caption = formatTweetCaption(tweetData.tweet);
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
  } catch (error) {
    console.error('Error processing tweet:', error);
    await sendMessage(chatId, '处理媒体内容时出错，请稍后重试。');
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