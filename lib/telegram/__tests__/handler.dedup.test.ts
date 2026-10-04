import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../messages', () => ({
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendMediaGroup: vi.fn(),
  sendLongCaption: vi.fn(),
  deleteMessage: vi.fn(),
}));

vi.mock('../formatter', () => ({
  formatTweetCaption_without_name: vi.fn(async () => 'caption'),
  pickBestMediaUrl: vi.fn((item: { variants?: Array<{ url?: string }>; media_url_https?: string }) => item.variants?.[0]?.url ?? item.media_url_https ?? ''),
}));

vi.mock('../../twitter', () => ({
  downloadTwitterMedia: vi.fn(),
}));

import { processDirectDownload } from '../handler';
import { sendMessage } from '../messages';
import { downloadTwitterMedia } from '../../twitter';
import { setDbPathForTests, resetDbForTests } from '../../dedup/store';
import { resetInflightForTests } from '../../dedup/guard';

const mockedSendMessage = sendMessage as unknown as Mock;
const mockedDownload = downloadTwitterMedia as unknown as Mock;

let tmpDir: string;

function photoTweet() {
  return {
    type: 'photo',
    media_items: [{
      type: 'photo',
      media_url_https: 'https://pbs.twimg.com/media/x.jpg',
    }],
    tweet: { id: '123', text: 'hi', created_at: '', user: { name: 'n', screen_name: 's' }, reply_count: 0, retweet_count: 0, quote_count: 0, favorite_count: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-handler-'));
  setDbPathForTests(path.join(tmpDir, 'h.sqlite'));
  resetInflightForTests();
  mockedSendMessage.mockResolvedValue({ message_id: 1001 });
  mockedDownload.mockResolvedValue(photoTweet());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetInflightForTests();
  resetDbForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('processDirectDownload 去重', () => {
  it('并发 10 个 processDirectDownload 同 URL（真实临时 DB）→ 只下载 1 次，其余 dedup done', async () => {
    const url = 'https://x.com/user/status/999';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => processDirectDownload(123, url))
    );

    expect(mockedDownload).toHaveBeenCalledTimes(1);
    const executed = results.filter((r) => r.success && !r.dedup);
    const done = results.filter((r) => r.success && r.dedup === 'done');
    expect(executed).toHaveLength(1);
    expect(done).toHaveLength(9);
  });

  it('首次下载失败（owner 失败）→ 返回 success:false 且不带 dedup 字段', async () => {
    mockedDownload.mockRejectedValue(new Error('PRIVATE_TWEET'));
    const res = await processDirectDownload(123, 'https://x.com/user/status/555');
    expect(res.success).toBe(false);
    expect(res.dedup).toBeUndefined();
    expect(res.error).toBe('PRIVATE_TWEET');
  });
});

describe('processDirectDownload 等待超时（真实定时器）', () => {
  it('等待超时仍 processing → 返回 { success:true, dedup:processing }，放行后 owner 完成', async () => {
    // 本文件 beforeEach 开了 fake timers，此用例需要真实定时器驱动 awaitWithTimeout 的 200ms 超时。
    vi.useRealTimers();

    const oldWait = process.env.DEDUP_WAIT_MS;
    process.env.DEDUP_WAIT_MS = '200';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedDownload.mockImplementation(async () => {
      await gate;
      return photoTweet();
    });

    try {
      const url = 'https://x.com/user/status/777';
      const owner = processDirectDownload(123, url);
      const waiter = processDirectDownload(123, url);

      const waiterResult = await waiter;
      expect(waiterResult.success).toBe(true);
      expect(waiterResult.dedup).toBe('processing');

      release();
      const ownerResult = await owner;
      expect(ownerResult.success).toBe(true);
      expect(ownerResult.dedup).toBeUndefined();
    } finally {
      if (oldWait === undefined) delete process.env.DEDUP_WAIT_MS;
      else process.env.DEDUP_WAIT_MS = oldWait;
    }
  });
});
