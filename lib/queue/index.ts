import { setTimeout as delay } from 'node:timers/promises';
import { envInt, extractUrls } from '../utils';
import { claim } from '../dedup/store';
import { sendMessage } from '../telegram/messages';
import type { TelegramUpdate } from '../telegram/types';
import { enqueue, getJob } from './store';
import { startWorker } from './worker';

export interface EnqueueSummary {
  enqueued: number;
  /** Telegram 重投同一个 update_id 时为 true(静默丢弃)。 */
  dedup?: boolean;
}

/**
 * 将一条 Telegram update 转换为队列任务:update 级去重 → 提取推文 URL →
 * 每条一个 job(同组,共享「正在处理」提示消息),webhook 可立即 200。
 *
 * worker 在首个入队时随路由启动(startWorker 幂等)。曾经挂在
 * instrumentation register() 上,但 edge bundle 无法解析 better-sqlite3
 * (其常量折叠在模块解析之前,tree-shake 救不了),而 register() 在
 * Next 13.5 下本就是首个请求才惰性执行,最终时序等价:有任务才有 worker。
 */
export async function enqueueUpdateJobs(update: TelegramUpdate): Promise<EnqueueSummary> {
  const message = update.message;
  if (!message?.text) return { enqueued: 0 };

  if (update.update_id !== undefined) {
    const updClaim = claim(`upd:${update.update_id}`, 'upd');
    if (updClaim.role === 'duplicate') return { enqueued: 0, dedup: true };
  }

  const chatId = message.chat.id;
  const twitterUrls = extractUrls(message.text).filter(
    (url) => url.includes('twitter.com') || url.includes('x.com')
  );

  if (twitterUrls.length === 0) {
    await sendMessage(chatId, '请发送Twitter/X链接以下载媒体内容。');
    return { enqueued: 0 };
  }

  const processingMsg = await sendMessage(chatId, '正在处理您的请求...');
  const groupId = update.update_id !== undefined ? `upd:${update.update_id}` : `msg:${processingMsg.message_id}`;
  startWorker(); // 兜底幂等:确保消费循环已启动。
  for (const url of twitterUrls) {
    enqueue(chatId, url, { groupId, processingMsgId: processingMsg.message_id });
  }
  return { enqueued: twitterUrls.length };
}

export interface QueueOutcome {
  status: 'done' | 'failed' | 'queued';
  error?: string;
  dedup?: string | null;
}

/**
 * 入队并同步等待终态(供 /api/download 保持既有同步契约)。
 * 超时返回 { status:'queued' }——任务继续在后台跑,调用方按 202 处理。
 */
export async function enqueueAndWait(
  chatId: number,
  url: string,
  timeoutMs: number = envInt('QUEUE_WAIT_TIMEOUT_MS', 8 * 60_000)
): Promise<QueueOutcome> {
  const jobId = enqueue(chatId, url);
  startWorker(); // 兜底幂等,见 enqueueUpdateJobs。

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(jobId);
    if (job?.status === 'done') {
      return { status: 'done', dedup: job.dedup };
    }
    if (job?.status === 'failed') {
      return { status: 'failed', error: job.last_error ?? 'Download failed', dedup: job.dedup };
    }
    await delay(500);
  }
  return { status: 'queued' };
}
