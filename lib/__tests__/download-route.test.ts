import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/telegram', () => ({
  processDirectDownload: vi.fn(),
}));

import { processDirectDownload } from '@/lib/telegram';
import { POST } from '@/app/api/download/route';

const mockedDownload = processDirectDownload as unknown as ReturnType<typeof vi.fn>;

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

  it('success 无 dedup → 200 {ok:true, message}', async () => {
    mockedDownload.mockResolvedValue({ success: true });
    const res = await POST(req(params));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Download success.' });
  });

  it('success + dedup:done → 200 {ok:true, dedup:done}', async () => {
    mockedDownload.mockResolvedValue({ success: true, dedup: 'done' });
    const res = await POST(req(params));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      dedup: 'done',
      message: 'already processed recently',
    });
  });

  it('success + dedup:processing → 202 {ok:true, dedup:processing}', async () => {
    mockedDownload.mockResolvedValue({ success: true, dedup: 'processing' });
    const res = await POST(req(params));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, dedup: 'processing' });
  });

  it('!success + dedup:failed → 409 {ok:false, dedup:failed, error}', async () => {
    mockedDownload.mockResolvedValue({ success: false, dedup: 'failed', error: 'boom' });
    const res = await POST(req(params));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, dedup: 'failed', error: 'boom' });
  });

  it('!success 无 dedup → 400 {ok:false, error}', async () => {
    mockedDownload.mockResolvedValue({ success: false, error: 'nope' });
    const res = await POST(req(params));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'nope' });
  });

  it('缺参数 → 400 {ok:false, Missing required parameters}', async () => {
    const res = await POST(req({ chatId: 123 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'Missing required parameters' });
  });

  it('processDirectDownload 抛异常 → 500', async () => {
    mockedDownload.mockRejectedValue(new Error('kaboom'));
    const res = await POST(req(params));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'Internal server error' });
  });
});
