import { claim, complete, fail, get } from './store';
import { normalizeTweetKey, redactErrorText } from '../utils';

export type DedupOutcome = 'executed' | 'reused-done' | 'in-progress' | 'recently-failed';

export interface DedupResult<T> {
  outcome: DedupOutcome;
  result?: T;
  error?: string;
}

export interface WithTweetDedupOptions {
  chatId?: number;
  waitMs?: number;
}

/** 进程内正在执行（或刚结束）的可等待句柄，跨 bundle 时降级为轮询 DB。 */
const inflight = new Map<string, Promise<{ ok: boolean; error?: string }>>();

/** 从调用点各自的返回形状里提取「是否成功」。 */
function resultOk(result: unknown): boolean {
  if (result == null) return true;
  if (typeof result === 'object') {
    const r = result as { success?: unknown; ok?: unknown };
    if ('success' in r) return r.success === true;
    if ('ok' in r) return r.ok === true;
  }
  return true;
}

/** 从调用点各自的返回形状里提取错误文案。 */
function resultError(result: unknown): string | undefined {
  if (result && typeof result === 'object') {
    const r = result as { error?: unknown };
    if (typeof r.error === 'string') return r.error;
  }
  return undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitWithTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 给一次推文下载套上去重编排。owner 路径执行 run 并如实返回其结果形状；
 * 重复路径根据 store 状态映射为 reused-done / in-progress / recently-failed。
 */
export async function withTweetDedup<T>(
  url: string,
  opts: WithTweetDedupOptions,
  run: () => Promise<T>
): Promise<DedupResult<T>> {
  const key = normalizeTweetKey(url);
  const claimed = claim(key, 'tweet', opts.chatId);

  if (claimed.role === 'duplicate') {
    if (claimed.state === 'done') {
      return { outcome: 'reused-done' };
    }
    if (claimed.state === 'failed') {
      return { outcome: 'recently-failed', error: claimed.error };
    }
    // processing
    const waitMs = opts.waitMs ?? 0;
    if (!waitMs) {
      return { outcome: 'in-progress' };
    }

    const existing = inflight.get(key);
    if (existing) {
      const res = await awaitWithTimeout(existing, waitMs);
      if (res === 'timeout') return { outcome: 'in-progress' };
      return res.ok
        ? { outcome: 'reused-done' }
        : { outcome: 'recently-failed', error: res.error };
    }

    // 跨 bundle/进程：本进程 inflight 里没有，退化为轮询 store。
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const row = get(key);
      if (row?.status === 'done') return { outcome: 'reused-done' };
      if (row?.status === 'failed') {
        return { outcome: 'recently-failed', error: row.error ?? undefined };
      }
      await sleep(1000);
    }
    return { outcome: 'in-progress' };
  }

  // owner 路径：拿到执行权后直接执行 run。失败信息仍落库并兑现给 inflight 等待者，
  // 但对 owner 本人：
  //   - run 正常 resolve：一律返回 executed，业务失败形状（{success:false,...}）原样带 result 返回，
  //     不带 dedup 语义，由调用点走原有失败路径。
  //   - run 抛异常：fail 落库 + 兑现 inflight 后，重新抛出该异常，让外层既有 try/catch 恢复原行为。
  // 所有权令牌（= 本次写入的 updated_at）：complete/fail 只对持有该令牌的行生效，
  // 防止旧 owner 在被 CAS 接管后迟到写入，误伤新 owner 的 processing 行。
  const token = claimed.token;

  let resolveInflight!: (value: { ok: boolean; error?: string }) => void;
  const inflightPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    resolveInflight = resolve;
  });

  inflight.set(key, inflightPromise);

  try {
    const result: T = await run();
    const ok = resultOk(result);
    const rawError = resultError(result);
    const safeError = rawError ? redactErrorText(rawError) : undefined;
    if (ok) {
      complete(key, token);
    } else {
      // 落库与兑现给等待者的错误文案先清洗，避免 bot token 等敏感信息落盘/外泄。
      fail(key, safeError ?? 'unknown error', token);
    }
    resolveInflight({ ok, error: ok ? undefined : safeError ?? 'unknown error' });
    return { outcome: 'executed', result };
  } catch (err) {
    const message = redactErrorText(errorText(err));
    fail(key, message, token);
    resolveInflight({ ok: false, error: message });
    throw err;
  } finally {
    if (inflight.get(key) === inflightPromise) {
      inflight.delete(key);
    }
  }
}

/** 测试用：清空进程内 inflight 状态，保证用例之间不串。 */
export function resetInflightForTests(): void {
  inflight.clear();
}
