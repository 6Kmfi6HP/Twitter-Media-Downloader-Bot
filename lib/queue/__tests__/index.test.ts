import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../telegram/messages', () => ({
  sendMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));

import { enqueueUpdateJobs, enqueueAndWait } from '../index';
import { completeJob, getJob, setDbPathForTests, resetDbForTests } from '../store';
import {
  setDbPathForTests as setDedupDbForTests,
  resetDbForTests as resetDedupDbForTests,
} from '../../dedup/store';
import { stopWorkerForTests } from '../worker';
import { sendMessage } from '../../telegram/messages';

const mockedSendMessage = sendMessage as unknown as Mock;

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-index-'));
  setDbPathForTests(path.join(tmpDir, 'q.sqlite'));
  setDedupDbForTests(path.join(tmpDir, 'd.sqlite'));
  // 防止真启动的 worker 轮询消费掉刚入队的 job(本套用例只验入队语义,
  // 消费语义在 worker.test.ts)。把轮询间隔拉到测试永远等不到的长度。
  process.env.QUEUE_POLL_MS = '3600000';
  mockedSendMessage.mockResolvedValue({ message_id: 1001 });
});

afterEach(() => {
  delete process.env.QUEUE_POLL_MS;
  stopWorkerForTests();
  resetDbForTests();
  resetDedupDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('enqueueUpdateJobs', () => {
  it('无文本 update → 不入队不发消息', async () => {
    const res = await enqueueUpdateJobs({ update_id: 1 });
    expect(res).toEqual({ enqueued: 0 });
    expect(mockedSendMessage).not.toHaveBeenCalled();
  });

  it('文本无 Twitter 链接 → 提示并不入队', async () => {
    const res = await enqueueUpdateJobs({
      update_id: 2,
      message: { message_id: 1, chat: { id: 123 }, text: 'hello' },
    });
    expect(res.enqueued).toBe(0);
    expect(mockedSendMessage).toHaveBeenCalledWith(123, '请发送Twitter/X链接以下载媒体内容。');
  });

  it('多条链接 → 各入一 job,同组共享处理中消息', async () => {
    const res = await enqueueUpdateJobs({
      update_id: 3,
      message: {
        message_id: 1,
        chat: { id: 123 },
        text: 'https://x.com/u/status/1 and https://twitter.com/u/status/2',
      },
    });
    expect(res.enqueued).toBe(2);
    const jobs = [getJob(1)!, getJob(2)!];
    expect(jobs.map((j) => j.url)).toEqual([
      'https://x.com/u/status/1',
      'https://twitter.com/u/status/2',
    ]);
    expect(jobs.every((j) => j.group_id === 'upd:3' && j.processing_msg_id === 1001)).toBe(true);
  });

  it('相同 update_id 重放 → dedup,不重复入队、不重复发消息(自 processUpdate 迁移)', async () => {
    const update = {
      update_id: 42,
      message: { message_id: 1, chat: { id: 123 }, text: 'https://x.com/user/status/123' },
    };
    const first = await enqueueUpdateJobs(update);
    expect(first).toEqual({ enqueued: 1 });

    const sendsBefore = mockedSendMessage.mock.calls.length;
    const second = await enqueueUpdateJobs(update);
    expect(second).toEqual({ enqueued: 0, dedup: true });
    expect(mockedSendMessage.mock.calls.length).toBe(sendsBefore);
    // 只入队过第一条(本测试独立 DB,id 从 1 起)。
    expect(getJob(1)!.url).toBe('https://x.com/user/status/123');
    expect(getJob(2)).toBeUndefined();
  });
});

describe('enqueueAndWait', () => {
  it('job 完成 → 返回 done 与 dedup 值', async () => {
    mockedSendMessage.mockResolvedValue({ message_id: 1 });
    const waiting = enqueueAndWait(123, 'https://x.com/u/status/9', 5000);
    // 任务同步 insert,jobId=1;直接标记完成让等待循环命中。
    completeJob(1, 'done');
    const res = await waiting;
    expect(res).toEqual({ status: 'done', dedup: 'done' });
  });

  it('超时未终态 → 返回 queued', async () => {
    // 600ms 真实等待:enqueueAndWait 按 500ms 轮询一次,超时路径只能靠
    // 平台时钟驱动,属集成语义,故保留一次真实计时。
    const res = await enqueueAndWait(123, 'https://x.com/u/status/10', 600);
    expect(res).toEqual({ status: 'queued' });
    expect(getJob(1)!.status).toBe('pending');
  }, 10000);
});
