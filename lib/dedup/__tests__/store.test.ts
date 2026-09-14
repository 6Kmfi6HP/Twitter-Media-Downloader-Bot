import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  claim,
  complete,
  fail,
  get,
  sweep,
  setDbPathForTests,
  resetDbForTests,
} from '../store';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-store-'));
  setDbPathForTests(path.join(tmpDir, 'store.sqlite'));
});

afterEach(() => {
  resetDbForTests();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** 直接打开底层 DB 文件，用于伪造过期/冷却窗口。 */
function raw(): Database.Database {
  return new Database(path.join(tmpDir, 'store.sqlite'));
}

/** 认领并断言 owner，返回所有权 token（= 本次写入 updated_at）。 */
function ownerToken(key: string, kind: 'tweet' | 'upd' = 'tweet', chatId = 1): number {
  const res = claim(key, kind, chatId);
  expect(res.role).toBe('owner');
  return (res as { token: number }).token;
}

describe('claim 并发原子性', () => {
  it('并发 50 个 claim 同一 key → 恰好 1 个 owner', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve(claim('tweet:123', 'tweet', 1)))
    );
    const owners = results.filter((r) => r.role === 'owner');
    const dupes = results.filter((r) => r.role === 'duplicate');
    expect(owners).toHaveLength(1);
    expect(dupes).toHaveLength(49);
  });
});

describe('complete 后 done 窗口', () => {
  it('done 窗口内 claim → duplicate(done)', () => {
    complete('tweet:1', ownerToken('tweet:1'));
    const res = claim('tweet:1', 'tweet', 1);
    expect(res).toEqual({ role: 'duplicate', state: 'done' });
  });

  it('伪造过期 done 行 → 可接管为 owner', () => {
    complete('tweet:2', ownerToken('tweet:2'));
    raw()
      .prepare(`UPDATE dedup_keys SET expire_after=? WHERE key=?`)
      .run(Date.now() - 1000, 'tweet:2');
    expect(claim('tweet:2', 'tweet', 1).role).toBe('owner');
  });
});

describe('fail 后冷却窗口', () => {
  it('冷却内 claim → duplicate(failed, 带 error)', () => {
    fail('tweet:3', 'boom', ownerToken('tweet:3'));
    const res = claim('tweet:3', 'tweet', 1);
    expect(res).toEqual({ role: 'duplicate', state: 'failed', error: 'boom' });
  });

  it('伪造冷却过期 → owner', () => {
    fail('tweet:4', 'boom', ownerToken('tweet:4'));
    raw()
      .prepare(`UPDATE dedup_keys SET updated_at=? WHERE key=?`)
      .run(Date.now() - 3 * 60_000, 'tweet:4');
    expect(claim('tweet:4', 'tweet', 1).role).toBe('owner');
  });
});

describe('complete/fail 所有权令牌（stale-owner 防护）', () => {
  it('旧 owner 迟到写入不误伤新 owner；新 owner 用自身 token 才生效', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const tokenA = ownerToken('tweet:tok');

      // 拨快 1 分钟，模拟租约过期后被 B 接管。
      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      raw()
        .prepare(`UPDATE dedup_keys SET lease_until=? WHERE key=?`)
        .run(Date.now() - 1000, 'tweet:tok');

      const claimB = claim('tweet:tok', 'tweet', 1);
      expect(claimB.role).toBe('owner');
      const tokenB = (claimB as { token: number }).token;
      expect(tokenB).not.toBe(tokenA);

      // A 迟到 complete/fail（旧 token）→ 不生效，行仍 processing 且 updated_at 为 B 的值
      complete('tweet:tok', tokenA);
      let row = get('tweet:tok');
      expect(row?.status).toBe('processing');
      expect(row?.updated_at).toBe(tokenB);

      fail('tweet:tok', 'stale-owner-err', tokenA);
      row = get('tweet:tok');
      expect(row?.status).toBe('processing');
      expect(row?.error).toBeNull();
      expect(row?.updated_at).toBe(tokenB);

      // B 用自身 token complete → 成功 done
      complete('tweet:tok', tokenB);
      row = get('tweet:tok');
      expect(row?.status).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('upd 键永不再执行', () => {
  it('伪造 lease_until 过期的 upd 行 → claim 仍返回 duplicate，绝不 owner', () => {
    expect(claim('upd:88', 'upd', 1).role).toBe('owner');
    raw()
      .prepare(`UPDATE dedup_keys SET lease_until=? WHERE key=?`)
      .run(Date.now() - 1000, 'upd:88');
    const res = claim('upd:88', 'upd', 1);
    expect(res.role).toBe('duplicate');
  });

  it('伪造 updated_at 拨快超过租约的 upd 行 → claim 仍返回 duplicate', () => {
    expect(claim('upd:89', 'upd', 1).role).toBe('owner');
    raw()
      .prepare(`UPDATE dedup_keys SET updated_at=?, lease_until=? WHERE key=?`)
      .run(Date.now() - 30 * 60_000, Date.now() - 30 * 60_000, 'upd:89');
    const res = claim('upd:89', 'upd', 1);
    expect(res.role).toBe('duplicate');
  });
});

describe('processing 租约过期接管', () => {
  it('伪造 lease_until 过期的 processing 行 → claim 接管成功', () => {
    expect(claim('tweet:5', 'tweet', 1).role).toBe('owner');
    raw()
      .prepare(`UPDATE dedup_keys SET lease_until=? WHERE key=?`)
      .run(Date.now() - 1000, 'tweet:5');
    expect(claim('tweet:5', 'tweet', 1).role).toBe('owner');
  });
});

describe('CAS 接管', () => {
  it('对同一过期行并发两次接管逻辑 → 恰一个 owner', async () => {
    expect(claim('tweet:6', 'tweet', 1).role).toBe('owner');
    raw()
      .prepare(`UPDATE dedup_keys SET lease_until=? WHERE key=?`)
      .run(Date.now() - 1000, 'tweet:6');

    const results = await Promise.all([
      Promise.resolve(claim('tweet:6', 'tweet', 1)),
      Promise.resolve(claim('tweet:6', 'tweet', 1)),
    ]);
    const owners = results.filter((r) => r.role === 'owner');
    // 同步 CAS（BEGIN IMMEDIATE）串行化，且第二次读到已更新的 updated_at 时失败。
    expect(owners).toHaveLength(1);
  });
});

describe('启动自愈（带租约守卫）', () => {
  it('(a) 租约未过期的 processing 行在重建连接后保持 processing 不变（保护活 owner）', () => {
    expect(claim('tweet:7a', 'tweet', 1).role).toBe('owner');
    expect(get('tweet:7a')?.status).toBe('processing');

    // 模拟进程重启：关闭连接后重新指向同一 DB 路径。
    resetDbForTests();
    setDbPathForTests(path.join(tmpDir, 'store.sqlite'));

    const row = get('tweet:7a');
    expect(row?.status).toBe('processing');
    expect(row?.error).toBeNull();
  });

  it('(b) 租约已过期的残留 processing 行被翻成 failed/process-restarted，冷却内 duplicate、拨快出冷却后可 owner', () => {
    expect(claim('tweet:7b', 'tweet', 1).role).toBe('owner');
    // 伪造租约已过期的残留行
    raw()
      .prepare(`UPDATE dedup_keys SET lease_until=? WHERE key=?`)
      .run(Date.now() - 1000, 'tweet:7b');

    resetDbForTests();
    setDbPathForTests(path.join(tmpDir, 'store.sqlite'));

    const row = get('tweet:7b');
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('process-restarted');
    expect(row?.lease_until).toBeNull();

    // 冷却内 → duplicate(failed)
    const cold = claim('tweet:7b', 'tweet', 1);
    expect(cold).toEqual({ role: 'duplicate', state: 'failed', error: 'process-restarted' });

    // 拨快 updated_at 出冷却 → 重新 owner
    raw()
      .prepare(`UPDATE dedup_keys SET updated_at=? WHERE key=?`)
      .run(Date.now() - 3 * 60_000, 'tweet:7b');
    expect(claim('tweet:7b', 'tweet', 1).role).toBe('owner');
  });
});

describe('sweeper 清理', () => {
  it('过期行被 DELETE，未过期行不受影响', () => {
    // 已过期行
    expect(claim('tweet:expired', 'tweet', 1).role).toBe('owner');
    raw()
      .prepare(`UPDATE dedup_keys SET expire_after=? WHERE key=?`)
      .run(Date.now() - 5000, 'tweet:expired');

    // 未过期行
    expect(claim('tweet:alive', 'tweet', 1).role).toBe('owner');

    const removed = sweep();

    expect(removed).toBe(1);
    expect(get('tweet:expired')).toBeUndefined();
    expect(get('tweet:alive')).toBeDefined();
  });
});

describe('跨连接安全（模拟第二进程）', () => {
  it('peer 连接已插入 processing 行时，本模块 claim 返回 duplicate（owner 合计 0）', () => {
    // 先触发本模块建库建表（getDb 懒加载建 schema）
    expect(claim('tweet:seed', 'tweet', 1).role).toBe('owner');

    const peer = raw();
    const now = Date.now();
    // peer 模拟另一进程先认领
    peer
      .prepare(
        `INSERT INTO dedup_keys
           (key, kind, status, chat_id, error, created_at, updated_at, lease_until, expire_after)
         VALUES (?, 'tweet', 'processing', ?, NULL, ?, ?, ?, ?)`
      )
      .run('tweet:peer', 1, now, now, now + 600_000, now + 600_000 + 900_000);

    const results = [claim('tweet:peer', 'tweet', 1), claim('tweet:peer', 'tweet', 1)];
    expect(results.every((r) => r.role === 'duplicate')).toBe(true);
    peer.close();
  });

  it('peer 竞争插入同 key → 0 changes，owner 合计仍 = 1', () => {
    // 建表 + 本模块先抢到 owner
    expect(claim('tweet:dual', 'tweet', 1).role).toBe('owner');

    const peer = raw();
    const now = Date.now();
    // peer 用同样的 INSERT OR IGNORE 竞争认领（模拟另一进程同时 claim）
    const peerInsert = peer
      .prepare(
        `INSERT OR IGNORE INTO dedup_keys
           (key, kind, status, chat_id, error, created_at, updated_at, lease_until, expire_after)
         VALUES (?, 'tweet', 'processing', ?, NULL, ?, ?, ?, ?)`
      )
      .run('tweet:dual', 1, now, now, now + 600_000, now + 600_000 + 900_000);

    expect(peerInsert.changes).toBe(0); // 键已存在，不会产生第二个 owner
    expect(claim('tweet:dual', 'tweet', 1).role).toBe('duplicate');
    expect(claim('tweet:dual', 'tweet', 1).role).toBe('duplicate');
    peer.close();
  });

  it('双连接模式下重演 M2：活行不被自愈误伤，peer 可见一致状态', () => {
    expect(claim('tweet:live', 'tweet', 1).role).toBe('owner');
    const peer = raw();

    // 模拟另一进程冷启动（本模块重连触发自愈）——活行租约未过期，不应被翻。
    resetDbForTests();
    setDbPathForTests(path.join(tmpDir, 'store.sqlite'));

    const moduleRow = get('tweet:live');
    expect(moduleRow?.status).toBe('processing');

    const peerRow = peer
      .prepare(`SELECT status, error FROM dedup_keys WHERE key = ?`)
      .get('tweet:live') as { status: string; error: string | null };
    expect(peerRow.status).toBe('processing');
    expect(peerRow.error).toBeNull();
    peer.close();
  });
});
