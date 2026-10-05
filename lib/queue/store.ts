import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { envInt } from '../utils';

export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface JobRow {
  id: number;
  chat_id: number;
  url: string;
  group_id: string | null;
  processing_msg_id: number | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: number;
  last_error: string | null;
  /** DownloadResult.dedup 的回写:'done' | 'processing' | 'failed' | null */
  dedup: string | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
}

export function backoffBaseMs(): number {
  return envInt('QUEUE_BACKOFF_BASE_MS', 60_000);
}
export function leaseMs(): number {
  return envInt('QUEUE_LEASE_MS', 20 * 60_000);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  group_id TEXT,
  processing_msg_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dedup TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_runnable ON jobs(status, next_run_at, id);
CREATE INDEX IF NOT EXISTS idx_jobs_group ON jobs(group_id, status);
`;

let db: Database.Database | null = null;
let dbPathOverride: string | null = null;
let sweeper: NodeJS.Timeout | null = null;

function resolveDbPath(): string {
  if (dbPathOverride) return dbPathOverride;
  if (process.env.QUEUE_DB_PATH) return process.env.QUEUE_DB_PATH;
  // 与 dedup 同取舍:默认放系统临时目录。nextjs 非 root,/app 只读;
  // 容器无持久卷,重启即清空文件系统,跨部署持久化本就不可达。
  return path.join(os.tmpdir(), 'twitter-media-dl-queue.sqlite');
}

function getDb(): Database.Database {
  if (db) return db;
  const filePath = resolveDbPath();
  const conn = new Database(filePath, { timeout: 5000 });
  try {
    conn.pragma('journal_mode = WAL');
  } catch {
    // WAL 只是并发优化,失败退回默认 journal 模式(见 dedup store 同款注释)。
  }
  conn.exec(SCHEMA);
  // 启动自愈:仅回收租约已过期的 processing 行。多 bundle 冷启动下,
  // 本进程另一 bundle 正在跑的 job 租约未到期,不受影响。
  conn.prepare(
    `UPDATE jobs SET status='pending', next_run_at=?, last_error='stale lease recovered', lease_until=NULL, updated_at=?
     WHERE status='processing' AND lease_until IS NOT NULL AND lease_until < ?`
  ).run(Date.now(), Date.now(), Date.now());
  db = conn;
  startSweeper();
  return conn;
}

function rowToJob(row: Record<string, unknown>): JobRow {
  return {
    id: row.id as number,
    chat_id: row.chat_id as number,
    url: row.url as string,
    group_id: (row.group_id as string | null) ?? null,
    processing_msg_id: (row.processing_msg_id as number | null) ?? null,
    status: row.status as JobStatus,
    attempts: row.attempts as number,
    max_attempts: row.max_attempts as number,
    next_run_at: row.next_run_at as number,
    last_error: (row.last_error as string | null) ?? null,
    dedup: (row.dedup as string | null) ?? null,
    lease_until: (row.lease_until as number | null) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

export interface EnqueueOptions {
  groupId?: string;
  processingMsgId?: number;
  maxAttempts?: number;
}

/** 入队一个下载任务,返回 job id。FIFO 按 id 顺序消费。 */
export function enqueue(chatId: number, url: string, opts: EnqueueOptions = {}): number {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `INSERT INTO jobs (chat_id, url, group_id, processing_msg_id, status, attempts, max_attempts, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?)`
    )
    .run(chatId, url, opts.groupId ?? null, opts.processingMsgId ?? null, opts.maxAttempts ?? envInt('QUEUE_MAX_ATTEMPTS', 3), now, now);
  return Number(res.lastInsertRowid);
}

/**
 * 原子地领取下一个到期任务(BEGIN IMMEDIATE 单事务:多 worker loop
 * 并发时同一 job 只可能被一个领取)。设 attempts+1、挂租约。
 */
export function claimNext(now: number = Date.now()): JobRow | undefined {
  const conn = getDb();
  const txn = conn.transaction((): JobRow | undefined => {
    const row = conn
      .prepare(
        `SELECT id, updated_at FROM jobs
         WHERE status = 'pending' AND next_run_at <= ?
         ORDER BY id LIMIT 1`
      )
      .get(now) as { id: number; updated_at: number } | undefined;
    if (!row) return undefined;

    // CAS:updated_at 未变才接管,失败视为他人已领取。
    const taken = conn
      .prepare(
        `UPDATE jobs SET status='processing', attempts=attempts+1, lease_until=?, updated_at=?
         WHERE id=? AND updated_at=?`
      )
      .run(now + leaseMs(), now, row.id, row.updated_at);
    if (taken.changes !== 1) return undefined;

    return rowToJob(
      conn.prepare(`SELECT * FROM jobs WHERE id=?`).get(row.id) as Record<string, unknown>
    );
  });
  return txn();
}

export function completeJob(id: number, dedup: string | null, now: number = Date.now()): void {
  getDb()
    .prepare(`UPDATE jobs SET status='done', dedup=?, last_error=NULL, lease_until=NULL, updated_at=? WHERE id=?`)
    .run(dedup, now, id);
}

/** 终态失败:写 last_error,供 GET 日志与 group 收尾判断。 */
export function failPermanently(id: number, err: string, dedup: string | null, now: number = Date.now()): void {
  getDb()
    .prepare(`UPDATE jobs SET status='failed', last_error=?, dedup=?, lease_until=NULL, updated_at=? WHERE id=?`)
    .run(err.slice(0, 1000), dedup, now, id);
}

/** 失败可重试:回到 pending,按退避时间排下次执行。 */
export function rescheduleForRetry(id: number, err: string, nextRunAt: number, now: number = Date.now()): void {
  getDb()
    .prepare(
      `UPDATE jobs SET status='pending', last_error=?, next_run_at=?, lease_until=NULL, updated_at=? WHERE id=?`
    )
    .run(err.slice(0, 1000), nextRunAt, now, id);
}

export function getJob(id: number): JobRow | undefined {
  const row = getDb().prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : undefined;
}

/** 组内未完结任务数(同一次 update 的多 URL 共用 group_id)。 */
export function countUnfinishedInGroup(groupId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE group_id=? AND status IN ('pending','processing')`)
    .get(groupId) as { n: number };
  return row.n;
}

export function groupHasFailure(groupId: string): boolean {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE group_id=? AND status='failed'`)
    .get(groupId) as { n: number };
  return row.n > 0;
}

/** 手动触发一次清理:删除已过保留期的终态行。 */
export function sweep(now: number = Date.now()): number {
  const res = getDb()
    .prepare(`DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at < ?`)
    .run(now - envInt('QUEUE_RETENTION_MS', 24 * 3600_000));
  return res.changes;
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      console.error('[queue] sweep failed:', err);
    }
  }, 60 * 60_000);
  // 不阻止进程退出。
  sweeper.unref();
}

/** 关闭当前连接并挂起定时器(测试隔离用)。 */
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

/** 测试用:切换到独立临时 DB 路径(关闭现有连接、清除路径覆盖)。 */
export function setDbPathForTests(p: string): void {
  closeDb();
  dbPathOverride = p;
}

/** 测试用:重置到环境变量/默认路径,并清空路径覆盖。 */
export function resetDbForTests(): void {
  closeDb();
  dbPathOverride = null;
}
