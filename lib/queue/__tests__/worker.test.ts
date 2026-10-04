import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

vi.mock('../../telegram/handler', () => ({
  processDirectDownload: vi.fn(),
}));

vi.mock('../../telegram/messages', () => ({
  sendMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));

import {
  enqueue,
  getJob,
  setDbPathForTests,
  resetDbForTests,
} from '../store';
import { tickOnce, stopWorkerForTests } from '../worker';
import { processDirectDownload } from '../../telegram/handler';
import { deleteMessage, sendMessage } from '../../telegram/messages';

const mockedRun = processDirectDownload as unknown as Mock;
const mockedDeleteMessage = deleteMessage as unknown as Mock;
const mockedSendMessage = sendMessage as unknown as Mock;

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-worker-'));
  setDbPathForTests(path.join(tmpDir, 'q.sqlite'));
  mockedRun.mockResolvedValue({ success: true });
  mockedDeleteMessage.mockResolvedValue(true);
  mockedSendMessage.mockResolvedValue({ message_id: 1 });
});

afterEach(() => {
  stopWorkerForTests();
  resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 把 job 的重试时间窗拨到过去,绕过退避等待(确定性,不用假时钟)。 */
function makeDue(id: number): void {
  const raw = new Database(path.join(tmpDir, 'q.sqlite'));
  raw.prepare(`UPDATE jobs SET next_run_at=0, updated_at=? WHERE id=?`).run(Date.now(), id);
  raw.close();
}

describe('worker tickOnce 消费', () => {
  it('tick 后 job 被 worker 执行并标记 done', async () => {
    const id = enqueue(123, 'https://x.com/u/status/1');
    expect(await tickOnce()).toBe(1);
    const job = getJob(id)!;
    expect(job.status).toBe('done');
    expect(job.attempts).toBe(1);
    expect(mockedRun).toHaveBeenCalledWith(123, 'https://x.com/u/status/1');
  });

  it('执行失败 → 回到 pending 按退避重试;耗尽后 failed', async () => {
    mockedRun.mockResolvedValue({ success: false, error: 'boom' });
    const id = enqueue(123, 'https://x.com/u/status/2', { maxAttempts: 2 });

    // 第 1 次失败:attempts=1 < max → pending,next_run_at 在将来,不应被立刻重领。
    await tickOnce();
    let job = getJob(id)!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(await tickOnce()).toBe(0);

    // 越过退避窗口再 tick:第 2 次失败耗尽 → failed 终态。
    makeDue(id);
    await tickOnce();
    job = getJob(id)!;
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(2);
    expect(job.last_error).toBe('boom');
  });

  it('组收尾:最后一个 job 完成时删除「正在处理」消息', async () => {
    const g = { groupId: 'upd:1', processingMsgId: 55 };
    const id1 = enqueue(123, 'https://x.com/u/status/1', g);
    const id2 = enqueue(123, 'https://x.com/u/status/2', g);

    // 串行(默认 QUEUE_CONCURRENCY=1):每轮 tick 消费一条。
    await tickOnce();
    expect(getJob(id1)!.status).toBe('done');
    expect(getJob(id2)!.status).toBe('pending');
    // 组未清空前不删「正在处理」。
    expect(mockedDeleteMessage).not.toHaveBeenCalled();

    await tickOnce();
    expect(getJob(id2)!.status).toBe('done');
    // 组清空时删一次处理中提示。
    expect(mockedDeleteMessage).toHaveBeenCalledWith(123, 55);
    expect(mockedDeleteMessage.mock.calls).toHaveLength(1);
    expect(mockedSendMessage).not.toHaveBeenCalled();
  });

  it('组内有失败 → 完结后发送一条错误提示', async () => {
    const g = { groupId: 'upd:2', processingMsgId: 56, maxAttempts: 1 };
    enqueue(123, 'https://x.com/u/status/1', g);
    enqueue(123, 'https://x.com/u/status/2', g);

    mockedRun
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'boom' });

    await tickOnce();
    // 第一条成功,组内还剩第二条:尚未收尾。
    expect(mockedSendMessage).not.toHaveBeenCalled();

    await tickOnce();

    expect(mockedDeleteMessage).toHaveBeenCalledWith(123, 56);
    expect(mockedSendMessage).toHaveBeenCalledWith(123, '处理媒体内容时出错,请稍后重试。');
    // 组级错误提示只发一条。
    expect(mockedSendMessage.mock.calls).toHaveLength(1);
  });
});
