import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { withTweetDedup, resetInflightForTests } from '../guard';
import { claim, setDbPathForTests, resetDbForTests } from '../store';

let tmpDir: string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function raw(): Database.Database {
  return new Database(path.join(tmpDir, 'guard.sqlite'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-guard-'));
  setDbPathForTests(path.join(tmpDir, 'guard.sqlite'));
  resetInflightForTests();
});

afterEach(() => {
  resetInflightForTests();
  resetDbForTests();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('withTweetDedup 并发', () => {
  it('10 个并发同 url(waitMs>0) → run 只执行 1 次，9 个 reused-done，1 个 executed', async () => {
    const url = 'https://x.com/user/status/123';
    const run = vi.fn(async () => {
      await sleep(50);
      return { ok: true };
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => withTweetDedup(url, { waitMs: 2000 }, run))
    );

    expect(run).toHaveBeenCalledTimes(1);
    const executed = results.filter((r) => r.outcome === 'executed');
    const reused = results.filter((r) => r.outcome === 'reused-done');
    expect(executed).toHaveLength(1);
    expect(reused).toHaveLength(9);
  });

  it('owner 失败 → owner 拿 executed+业务失败 result，等待者 recently-failed；冷却内 recently-failed；冷却过期重新 executed', async () => {
    const url = 'https://x.com/user/status/456';
    const run = vi.fn(async (): Promise<{ success: boolean; error?: string }> => {
      await sleep(30);
      return { success: false, error: 'boom' };
    });

    // 数组第一个元素同步 claim 成 owner，第二个为等待者。
    const [owner, waiter] = await Promise.all([
      withTweetDedup(url, { waitMs: 2000 }, run),
      withTweetDedup(url, { waitMs: 2000 }, run),
    ]);
    // owner 自身业务失败：返回 executed 并原样带 result，不落 dedup/recently-failed 语义
    expect(owner.outcome).toBe('executed');
    expect(owner.result).toEqual({ success: false, error: 'boom' });
    // 等待者：兑现为 recently-failed
    expect(waiter.outcome).toBe('recently-failed');
    expect(waiter.error).toBe('boom');
    expect(run).toHaveBeenCalledTimes(1);

    // 冷却内新请求 → recently-failed，run 不再执行
    const c = await withTweetDedup(url, { waitMs: 0 }, run);
    expect(c.outcome).toBe('recently-failed');
    expect(c.error).toBe('boom');
    expect(run).toHaveBeenCalledTimes(1);

    // 拨快时钟（updated_at 置为过去）→ 冷却过期 → 重新 executed
    raw()
      .prepare(`UPDATE dedup_keys SET updated_at=? WHERE key=?`)
      .run(Date.now() - 3 * 60_000, 'tweet:456');
    run.mockImplementation(async () => ({ success: true }));
    const d = await withTweetDedup(url, { waitMs: 0 }, run);
    expect(d.outcome).toBe('executed');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('run 抛异常 → 记 failed，owner 重新抛错，等待者 recently-failed 不悬挂', async () => {
    const url = 'https://x.com/user/status/789';
    const run = vi.fn(async (): Promise<{ ok: boolean }> => {
      await sleep(20);
      throw new Error('kaboom');
    });

    const [owner, waiter] = await Promise.allSettled([
      withTweetDedup(url, { waitMs: 3000 }, run),
      withTweetDedup(url, { waitMs: 3000 }, run),
    ]);

    // owner 抛出的异常被重新抛出（不吞掉）
    expect(owner.status).toBe('rejected');
    if (owner.status === 'rejected') {
      expect((owner.reason as Error).message).toBe('kaboom');
    }
    // 等待者不再悬挂，兑现为 recently-failed
    expect(waiter.status).toBe('fulfilled');
    if (waiter.status === 'fulfilled') {
      expect(waiter.value.outcome).toBe('recently-failed');
      expect(waiter.value.error).toBe('kaboom');
    }
    expect(run).toHaveBeenCalledTimes(1);

    const c = await withTweetDedup(url, { waitMs: 0 }, run);
    expect(c.outcome).toBe('recently-failed');
    expect(c.error).toBe('kaboom');
  });

  it('waitMs:0 → 立即 in-progress 不等待', async () => {
    const url = 'https://x.com/user/status/101112';
    // 先制造一个 processing 行
    expect(claim('tweet:101112', 'tweet', 1).role).toBe('owner');

    const run = vi.fn(async () => ({ ok: true }));
    const res = await withTweetDedup(url, { waitMs: 0 }, run);
    expect(res.outcome).toBe('in-progress');
    expect(run).not.toHaveBeenCalled();
  });

  it('不同 key（不同 tweetId）互不阻塞', async () => {
    const runA = vi.fn(async () => ({ success: true }));
    const runB = vi.fn(async () => ({ success: true }));
    const [a, b] = await Promise.all([
      withTweetDedup('https://x.com/user/status/111', { waitMs: 0 }, runA),
      withTweetDedup('https://x.com/user/status/222', { waitMs: 0 }, runB),
    ]);
    expect(a.outcome).toBe('executed');
    expect(b.outcome).toBe('executed');
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
  });
});
