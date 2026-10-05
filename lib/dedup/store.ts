import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { envInt } from '../utils';

export type DedupKind = 'tweet' | 'upd';
export type DedupStatus = 'processing' | 'done' | 'failed';

export interface DedupRow {
  key: string;
  kind: DedupKind;
  status: DedupStatus;
  chat_id: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  lease_until: number | null;
  expire_after: number;
}

export type ClaimResult =
  | { role: 'owner'; token: number }
  | { role: 'duplicate'; state: DedupStatus; error?: string };

function leaseMs(): number {
  return envInt('DEDUP_PROCESSING_LEASE_MS', 10 * 60_000);
}
function doneTtlMs(): number {
  return envInt('DEDUP_DONE_TTL_MS', 15 * 60_000);
}
function failedCooldownMs(): number {
  return envInt('DEDUP_FAILED_COOLDOWN_MS', 2 * 60_000);
}
function updateTtlMs(): number {
  return envInt('DEDUP_UPDATE_TTL_MS', 24 * 3600_000);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dedup_keys (
  key          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  chat_id      INTEGER,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  lease_until  INTEGER,
  expire_after INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_dedup_expire ON dedup_keys(expire_after);
`;

let db: Database.Database | null = null;
let dbPathOverride: string | null = null;
let sweeper: NodeJS.Timeout | null = null;

function resolveDbPath(): string {
  if (dbPathOverride) return dbPathOverride;
  if (process.env.DEDUP_DB_PATH) return process.env.DEDUP_DB_PATH;
  // 默认放系统临时目录：Docker runner 以非 root 用户(nextjs)运行，/app 只读，
  // CWD 下的 './.dedup.sqlite' 会报 SQLITE_CANTOPEN；/tmp 必然可写。
  // 去重本就是短窗口临时状态，容器重启即清空是设计上可接受的取舍。
  return path.join(os.tmpdir(), 'twitter-media-dl-dedup.sqlite');
}

function getDb(): Database.Database {
  if (db) return db;
  const path = resolveDbPath();
  const conn = new Database(path, { timeout: 5000 });
  try {
    conn.pragma('journal_mode = WAL');
  } catch {
    // WAL 只是并发读写优化，非正确性必需。并发冷启动同一全新文件时，
    // journal_mode 切换需要独占锁，busy timeout 也挡不住，这里失败就退回
    // 默认 journal 模式（小表串行化足够）。正常单进程冷启动不受影响。
  }
  conn.exec(SCHEMA);
  // 启动自愈：仅把租约已过期（或没有租约）的残留 processing 行翻成失败。
  // 加租约守卫避免「同进程多 bundle 冷启动」：Next 会把不同 route 打成不同 bundle，
  // 本模块可能在不同 bundle 各自延迟初始化；无条件自愈会把本进程另一 bundle 正在
  // 跑的活 owner 的 processing 行误伤为 failed。取舍：极端崩溃残留的 processing 行
  // 最多粘住一个租约周期(默认 10min)才会被接管或下一次自愈回收；Docker 容器文件
  // 系统重启即清空，本地开发残留 .dedup.sqlite* 已被 gitignore，可手动删除。
  conn.prepare(
    `UPDATE dedup_keys SET status='failed', error='process-restarted', lease_until=NULL, updated_at=? WHERE status='processing' AND (lease_until IS NULL OR lease_until < ?)`
  ).run(Date.now(), Date.now());
  db = conn;
  startSweeper();
  return conn;
}

function rowToDedupRow(row: Record<string, unknown>): DedupRow {
  return {
    key: row.key as string,
    kind: row.kind as DedupKind,
    status: row.status as DedupStatus,
    chat_id: (row.chat_id as number | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    lease_until: (row.lease_until as number | null) ?? null,
    expire_after: row.expire_after as number,
  };
}

interface ClaimRow {
  status: DedupStatus;
  error: string | null;
  updated_at: number;
  lease_until: number | null;
  expire_after: number;
}

/**
 * 原子地认领一个去重键。单事务（BEGIN IMMEDIATE）内完成插入或 CAS 接管。
 */
export function claim(key: string, kind: DedupKind, chatId?: number): ClaimResult {
  const now = Date.now();
  const conn = getDb();
  const lease = leaseMs();
  const ttl = doneTtlMs();
  const cooldown = failedCooldownMs();
  const updTtl = updateTtlMs();

  const claimTxn = conn.transaction((): ClaimResult => {
    const insertExpire = kind === 'upd' ? now + updTtl : now + lease + ttl;
    const inserted = conn
      .prepare(
        `INSERT OR IGNORE INTO dedup_keys
           (key, kind, status, chat_id, error, created_at, updated_at, lease_until, expire_after)
         VALUES (?, ?, 'processing', ?, NULL, ?, ?, ?, ?)`
      )
      .run(key, kind, chatId ?? null, now, now, now + lease, insertExpire);

    if (inserted.changes === 1) {
      return { role: 'owner', token: now };
    }

    // upd 键语义：整个 TTL 内永不再执行。命中即重复，不做窗口判断、不做 CAS 接管，
    // 否则 Telegram 迟到的同 update_id 重投会在租约过期后被再次执行。
    if (kind === 'upd') {
      const updRow = conn
        .prepare(`SELECT status FROM dedup_keys WHERE key = ?`)
        .get(key) as { status: DedupStatus } | undefined;
      return { role: 'duplicate', state: updRow?.status ?? 'processing' };
    }

    const row = conn
      .prepare(
        `SELECT status, error, updated_at, lease_until, expire_after
           FROM dedup_keys WHERE key = ?`
      )
      .get(key) as ClaimRow | undefined;

    if (!row) {
      // 极端竞态下被 sweeper 删掉：按仍在处理处理。
      return { role: 'duplicate', state: 'processing' };
    }

    if (row.status === 'done' && now < row.expire_after) {
      return { role: 'duplicate', state: 'done' };
    }
    if (row.status === 'processing' && row.lease_until !== null && now < row.lease_until) {
      return { role: 'duplicate', state: 'processing' };
    }
    if (row.status === 'failed' && now < row.updated_at + cooldown) {
      return { role: 'duplicate', state: 'failed', error: row.error ?? undefined };
    }

    // CAS 接管：仅在 updated_at 未变化时抢占，失败即视为他人已接管。
    const taken = conn
      .prepare(
        `UPDATE dedup_keys
           SET status='processing', error=NULL, updated_at=?, lease_until=?, expire_after=?
         WHERE key=? AND updated_at=?`
      )
      .run(now, now + lease, now + lease + ttl, key, row.updated_at);

    if (taken.changes === 1) {
      return { role: 'owner', token: now };
    }
    return { role: 'duplicate', state: 'processing' };
  });

  return claimTxn.immediate();
}

export function complete(key: string, token: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE dedup_keys
         SET status='done', lease_until=NULL, updated_at=?, expire_after=?
       WHERE key=? AND status='processing' AND updated_at=?`
    )
    .run(now, now + doneTtlMs(), key, token);
}

export function fail(key: string, err: string, token: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE dedup_keys
         SET status='failed', error=?, lease_until=NULL, updated_at=?, expire_after=?
       WHERE key=? AND status='processing' AND updated_at=?`
    )
    .run(err, now, now + 10 * 60_000, key, token);
}

export function get(key: string): DedupRow | undefined {
  const row = getDb().prepare(`SELECT * FROM dedup_keys WHERE key = ?`).get(key);
  if (!row) return undefined;
  return rowToDedupRow(row as unknown as Record<string, unknown>);
}

/** 手动触发一次清理：删除已过期的行。供测试与定时器共用。 */
export function sweep(): number {
  const conn = getDb();
  const info = conn
    .prepare(`DELETE FROM dedup_keys WHERE expire_after < ?`)
    .run(Date.now());
  return info.changes;
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    try {
      sweep();
    } catch {
      // 定时清理失败不影响主流程
    }
  }, 60_000);
  sweeper.unref?.();
}

/** 关闭当前连接并挂起定时器（测试隔离用）。 */
export function closeDb(): void {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  if (db) {
    db.close();
    db = null;
  }
}

/** 测试用：切换到独立临时 DB 路径（关闭现有连接、清除路径覆盖）。 */
export function setDbPathForTests(path: string): void {
  closeDb();
  dbPathOverride = path;
}

/** 测试用：重置到环境变量/默认路径，并清空路径覆盖。 */
export function resetDbForTests(): void {
  closeDb();
  dbPathOverride = null;
}
