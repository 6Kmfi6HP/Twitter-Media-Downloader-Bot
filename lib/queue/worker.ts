import {
  claimNext,
  completeJob,
  rescheduleForRetry,
  failPermanently,
  countUnfinishedInGroup,
  groupHasFailure,
  backoffBaseMs,
  type JobRow,
} from './store';
import { processDirectDownload } from '../telegram/handler';
import { deleteMessage, sendMessage } from '../telegram/messages';
import { envInt } from '../utils';

// 进程内单例守卫(Symbol.for 跨 bundle 共享):Next 多 bundle 各持模块副本,
// 极端情况下可能起多个循环。可接受:claimNext 用事务原子领取,多循环
// 只是更快消费,最坏并发 = 循环数 × QUEUE_CONCURRENCY。默认串行部署下
// 仅 instrumentation register() 启动一次。
const WORKER_FLAG = Symbol.for('tmdb.queueWorker');

let pollTimer: NodeJS.Timeout | null = null;
let inFlight = 0;

/**
 * 组收尾:同一次 update 的最后一个任务完结时,清掉「正在处理」提示消息;
 * 若组内有失败任务,发一次错误提示。仅最后一个完结者会看到组清空,
 * 所以错误提示天然只发一次。
 */
async function finalizeGroupIfDone(job: JobRow): Promise<void> {
  const groupId = job.group_id;
  if (!groupId) return;
  if (countUnfinishedInGroup(groupId) > 0) return;

  if (job.processing_msg_id !== null) {
    await deleteMessage(job.chat_id, job.processing_msg_id).catch((err) => {
      console.warn('[queue] failed to delete processing message:', err);
    });
  }
  if (groupHasFailure(groupId)) {
    await sendMessage(job.chat_id, '处理媒体内容时出错,请稍后重试。').catch((err) => {
      console.warn('[queue] failed to send group error message:', err);
    });
  }
}

async function runJob(job: JobRow): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await processDirectDownload(job.chat_id, job.url);
    if (result.success) {
      completeJob(job.id, result.dedup ?? null);
      console.log(`[queue] job #${job.id} done in ${Date.now() - startedAt}ms: ${job.url}`);
      await finalizeGroupIfDone(job);
      return;
    }
    await failJob(job, result.error ?? 'unknown error', result.dedup ?? null);
  } catch (err) {
    await failJob(job, err instanceof Error ? err.message : String(err), null);
  }
}

async function failJob(job: JobRow, error: string, dedup: string | null): Promise<void> {
  const now = Date.now();
  if (job.attempts < job.max_attempts) {
    // 退避 = attempts × base:第 1 次失败 +60s,第 2 次 +120s(默认值)。
    // 与 dedup 的 2 分钟失败冷却配合,最后一次重试落在冷却解除后。
    const nextRunAt = now + job.attempts * backoffBaseMs();
    rescheduleForRetry(job.id, error, nextRunAt, now);
    console.warn(
      `[queue] job #${job.id} failed (attempt ${job.attempts}/${job.max_attempts}), retry at +${nextRunAt - now}ms: ${error}`
    );
    return;
  }
  failPermanently(job.id, error, dedup, now);
  console.error(`[queue] job #${job.id} gave up after ${job.attempts} attempts: ${error}`);
  await finalizeGroupIfDone(job);
}

/**
 * 处理一轮:在并发上限内尽量领取任务并执行,await 本轮全部结束后返回
 * 启动的任务数。轮询定时器走 void 调用;测试 await 它即可确定性等到终态。
 */
export async function tickOnce(now: number = Date.now()): Promise<number> {
  const concurrency = envInt('QUEUE_CONCURRENCY', 1);
  const running: Promise<void>[] = [];
  while (inFlight < concurrency) {
    const job = claimNext(now);
    if (!job) break;
    inFlight += 1;
    running.push(
      runJob(job).finally(() => {
        inFlight -= 1;
      })
    );
  }
  await Promise.all(running);
  return running.length;
}

/**
 * 启动队列 worker:轮询领取下载任务。幂等,重复调用返回 false。
 * 由 instrumentation hook(生产)或测试显式调用;能在进程崩溃重启后
 * 通过 store 的启动自愈接管残留 processing 任务。
 */
export function startWorker(): boolean {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (g[WORKER_FLAG]) return false;
  g[WORKER_FLAG] = true;

  pollTimer = setInterval(() => {
    void tickOnce().catch((err) => {
      console.error('[queue] worker tick failed:', err);
    });
  }, envInt('QUEUE_POLL_MS', 500));
  pollTimer.unref();
  console.log(`[queue] worker started (concurrency=${envInt('QUEUE_CONCURRENCY', 1)})`);
  return true;
}

/** 测试用:停掉轮询循环并清除进程级守卫(不等在途任务)。 */
export function stopWorkerForTests(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  delete (globalThis as Record<PropertyKey, unknown>)[WORKER_FLAG];
  inFlight = 0;
}
