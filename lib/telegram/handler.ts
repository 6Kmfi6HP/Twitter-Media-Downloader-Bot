import { extractUrls } from '../utils';
import { downloadTwitterMedia } from '../twitter';
import { sendMessage, sendMediaGroup } from './api';
import { formatTweetCaption, formatMediaGroup } from './formatter';
import type { TelegramUpdate } from './types';

export async function processUpdate(update: TelegramUpdate): Promise<void> {
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
      const mediaGroup = formatMediaGroup(tweetData.media_items);

      if (mediaGroup.length > 0) {
        await sendMediaGroup(chatId, mediaGroup, caption);
      }
    }
  } catch (error) {
    console.error('Error processing tweet:', error);
    await sendMessage(chatId, '处理媒体内容时出错，请稍后重试。');
  }
}