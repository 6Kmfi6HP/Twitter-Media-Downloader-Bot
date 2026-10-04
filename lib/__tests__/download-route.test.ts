import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('@/lib/queue', () => ({
  enqueueAndWait: vi.fn(),
}));

import { enqueueAndWait } from '@/lib/queue';
import { POST } from '@/app/api/download/route';

const mockedEnqueue = enqueueAndWait as unknown as Mock;

function req(body: unknown): Request {
  return new Request('http://localhost/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('app/api/download 响应矩阵', () => {
  const params = { chatId: 123, url: 'https://x.com/u/status/1' };

  it('done 无 dedup → 200 {ok:true, message}', async () => {
    mockedEnqueue.mockResolvedValue({ status: 'done', dedup: null });
    const res = await POST(req(params));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Download success.' });
  });

  it('done + dedup:done → 200 {ok:true, dedup:done, message}', async () => {
    mockedEnqueue.mockResolvedValue({ status: 'done', dedup: 'done' });
    const res = await POST(req(params));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      dedup: 'done',
      message: 'already processed recently',
    });
  });

  it('done + dedup:processing → 202', async () => {
    mockedEnqueue.mockResolvedValue({ status: 'done', dedup: 'processing' });
    const res = await POST(req(params));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, dedup: 'processing' });
  });

  it('等待超时仍在跑 → 202 {ok:true, dedup:processing, queued:true}', async () => {
    mockedEnqueue.mockResolvedValue({ status: 'queued' });
    const res = await POST(req(params));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, dedup: 'processing', queued: true });
  });

  it('failed + dedup:failed → 409', async () => {
    mockedEnqueue.mockResolvedValue({ status: 'failed', dedup: 'failed', error: 'recently failed' });
    const res = await POST(req(params));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, dedup: 'failed', error: 'recently failed' });
  });

  it('failed 无 dedup → 400', async () => {
    mockedEnqueue.mockResolvedValue({ status: 'failed', error: 'boom' });
    const res = await POST(req(params));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'boom' });
  });

  it('缺参数 → 400 且不入队', async () => {
    const res = await POST(req({ chatId: 123 }));
    expect(res.status).toBe(400);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it('非 twitter/x 链接 → 400 且不入队', async () => {
    const res = await POST(req({ chatId: 123, url: 'https://example.com/x' }));
    expect(res.status).toBe(400);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it('入队抛错 → 500', async () => {
    mockedEnqueue.mockRejectedValue(new Error('db down'));
    const res = await POST(req(params));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'Internal server error' });
  });
});
