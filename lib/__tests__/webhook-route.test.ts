import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('@/lib/queue', () => ({
  enqueueUpdateJobs: vi.fn(),
}));

import { enqueueUpdateJobs } from '@/lib/queue';
import { POST } from '@/app/api/webhook/route';

const mockedEnqueue = enqueueUpdateJobs as unknown as Mock;

function req(body: unknown, secretHeader?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secretHeader !== undefined) headers['x-telegram-bot-api-secret-token'] = secretHeader;
  return new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_UPDATE = {
  update_id: 1,
  message: { message_id: 1, chat: { id: 123 }, text: 'https://x.com/u/status/1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  vi.restoreAllMocks();
});

describe('app/api/webhook 队列接入', () => {
  it('合法 update → 入队并立刻 200', async () => {
    mockedEnqueue.mockResolvedValue({ enqueued: 1 });
    const res = await POST(req(VALID_UPDATE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, queued: 1, dedup: false });
    expect(mockedEnqueue).toHaveBeenCalledWith(VALID_UPDATE);
  });

  it('Telegram 重投(dedup) → 200 且不再入队', async () => {
    mockedEnqueue.mockResolvedValue({ enqueued: 0, dedup: true });
    const res = await POST(req(VALID_UPDATE));
    expect(await res.json()).toEqual({ ok: true, queued: 0, dedup: true });
  });

  it('配置了 secret 时,缺失/错误的头 → 401 且不入队', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 's3cret';
    expect((await POST(req(VALID_UPDATE))).status).toBe(401);
    expect((await POST(req(VALID_UPDATE, 'wrong'))).status).toBe(401);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it('配置了 secret 时,正确的头 → 入队成功', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 's3cret';
    mockedEnqueue.mockResolvedValue({ enqueued: 1 });
    expect((await POST(req(VALID_UPDATE, 's3cret'))).status).toBe(200);
    expect(mockedEnqueue).toHaveBeenCalledWith(VALID_UPDATE);
  });

  it('入队抛错 → 200 ok:false(防 Telegram 无限重投)', async () => {
    mockedEnqueue.mockRejectedValue(new Error('boom'));
    const res = await POST(req(VALID_UPDATE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
  });
});
