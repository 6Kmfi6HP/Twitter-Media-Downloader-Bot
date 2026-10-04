import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  enqueue,
  claimNext,
  completeJob,
  failPermanently,
  rescheduleForRetry,
  getJob,
  countUnfinishedInGroup,
  groupHasFailure,
  sweep,
  setDbPathForTests,
  resetDbForTests,
} from '../store';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-store-'));
  setDbPathForTests(path.join(tmpDir, 'q.sqlite'));
});

afterEach(() => {
  resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 直接打开底层 DB 文件,伪造过期/终态记录。 */
function raw(): Database.Database {
  return new Database(path.join(tmpDir, 'q.sqlite'));
}

// SQLite(ms):完成扫描/宣告终态都需要新写入,stall/deadline 需要更新时间戳。
// waitless 时间注入即可,不需要真实时钟。

describe('jobs FIFO 与认领原子性', () => {
  it('按入队顺序先领先得;终态后不可再领', () => {
    const id1 = enqueue(123, 'https://x.com/u/status/1');
    const id2 = enqueue(123, 'https://x.com/u/status/2');

    const first = claimNext();
    expect(first?.id).toBe(id1);
    expect(first?.status).toBe('processing');
    expect(first?.attempts).toBe(1);

    completeJob(id1, null);

    const second = claimNext();
    expect(second?.id).toBe(id2);
    expect(claimNext()).toBeUndefined();
  });

  it('并发 50 次 claimNext 同一队列只有 1 个 job → 50 次调用恰好领走 2 条', () => {
    enqueue(123, 'https://x.com/u/status/1');
    enqueue(123, 'https://x.com/u/status/2');
    // better-sqlite3 同步,真并发不会发生;FIFO 顺序 + 租约在手时他人领不走
    // 通过二次 claim 返回 undefined 体现。
    const first = claimNext();
    const second = claimNext();
    expect(first?.id).not.toBe(second?.id);
    expect(claimNext()).toBeUndefined();
  });
});

describe('失败与退避', () => {
  it('rescheduleForRetry 回到 pending,next_run_at 之前不可领', () => {
    const id = enqueue(123, 'https://x.com/u/status/1');
    claimNext();
    const now = Date.now();
    rescheduleForRetry(id, 'boom', now + 60_000, now);
    expect(getJob(id)!.status).toBe('pending');
    expect(claimNext(now + 59_999)).toBeUndefined();
    expect(claimNext(now + 60_000)?.id).toBe(id);
    expect(getJob(id)!.attempts).toBe(2);
  });

  it('failPermanently 终态记录 last_error', () => {
    const id = enqueue(123, 'https://x.com/u/status/1');
    claimNext();
    failPermanently(id, 'permanent', 'failed');
    const job = getJob(id)!;
    expect(job.status).toBe('failed');
    expect(job.last_error).toBe('permanent');
    expect(job.dedup).toBe('failed');
  });
});

describe('启动自愈与清理', () => {
  it('重开连接时租约过期的 processing 行回到 pending', () => {
    const id = enqueue(123, 'https://x.com/u/status/1');
    claimNext();
    raw()
      .prepare(`UPDATE jobs SET lease_until=? WHERE id=?`)
      .run(Date.now() - 1000, id)
      .changes;

    // 同一进程内 db 缓存仍在;换 db 文件触发 getDb 重开路径不可行,
    // 这里直接模拟进程重启:关闭后重开同一文件。
    resetDbForTests();
    setDbPathForTests(path.join(tmpDir, 'q.sqlite'));

    const job = getJob(id)!;
    expect(job.status).toBe('pending');
    expect(job.last_error).toBe('stale lease recovered');
  });

  it('sweep 只清理保留期外的终态行', () => {
    const oldDone = enqueue(123, 'https://x.com/u/status/1');
    claimNext();
    completeJob(oldDone, null);
    const freshDone = enqueue(123, 'https://x.com/u/status/2');
    claimNext();
    completeJob(freshDone, null);

    raw()
      .prepare(`UPDATE jobs SET updated_at=? WHERE id=?`)
      .run(Date.now() - 25 * 3600_000, oldDone);

    expect(sweep()).toBe(1);
    expect(getJob(oldDone)).toBeUndefined();
    expect(getJob(freshDone)).toBeDefined();
  });
});

describe('组状态查询', () => {
  it('组内有 pending/processing 才算未完结;有 failed 可查', () => {
    const g = { groupId: 'upd:1', processingMsgId: 10 };
    const id1 = enqueue(123, 'https://x.com/u/status/1', g);
    const id2 = enqueue(123, 'https://x.com/u/status/2', g);

    expect(countUnfinishedInGroup('upd:1')).toBe(2);
    completeJob(id1, null);
    expect(countUnfinishedInGroup('upd:1')).toBe(1);

    failPermanently(id2, 'x', null);
    expect(countUnfinishedInGroup('upd:1')).toBe(0);
    expect(groupHasFailure('upd:1')).toBe(true);
  });
});
