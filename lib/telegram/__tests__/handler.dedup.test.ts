import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  formatTweetCaption: vi.fn(async () => 'caption'),
  formatTweetCaption_without_name: vi.fn(async () => 'caption'),
  pickBestMediaUrl: vi.fn((item: { variants?: Array<{ url?: string }>; media_url_https?: string }) => item.variants?.[0]?.url ?? item.media_url_https ?? ''),
}));

vi.mock('../../twitter', () => ({
  downloadTwitterMedia: vi.fn(),
}));

import { processUpdate, processDirectDownload } from '../handler';
import { sendMessage } from '../messages';
import { downloadTwitterMedia } from '../../twitter';
import { setDbPathForTests, resetDbForTests } from '../../dedup/store';
import { resetInflightForTests } from '../../dedup/guard';

const mockedSendMessage = sendMessage as unknown as ReturnType<typeof vi.fn>;
const mockedDownload = downloadTwitterMedia as unknown as ReturnType<typeof vi.fn>;

let tmpDir: string;

function photoTweet() {
  return {
    type: 'photo',
    media_items: [{
      type: 'photo',
      url: 'https://example.com/p.jpg',
      media_url_https: 'https://example.com/p.jpg',
      sizes: { large: { w: 1, h: 1, resize: 'fit' }, medium: { w: 1, h: 1, resize: 'fit' }, small: { w: 1, h: 1, resize: 'fit' }, thumb: { w: 1, h: 1, resize: 'fit' } },
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

describe('processUpdate webhook 重投去重', () => {
  it('相同 update_id 的 webhook 重放 → 第二次不下载、不发送任何消息', async () => {
    const update = {
      update_id: 42,
      message: { message_id: 1, chat: { id: 123 }, text: 'https://x.com/user/status/123' },
    };

    await processUpdate(update);
    expect(mockedDownload).toHaveBeenCalledTimes(1);

    const sendCountBefore = mockedSendMessage.mock.calls.length;
    await processUpdate(update);

    expect(mockedDownload).toHaveBeenCalledTimes(1);
    expect(mockedSendMessage.mock.calls.length).toBe(sendCountBefore);
  });

  it('窗口内同 URL 不同消息 → 跳过管线并发短提示', async () => {
    const m1 = {
      update_id: 100,
      message: { message_id: 1, chat: { id: 123 }, text: 'https://x.com/user/status/123' },
    };
    const m2 = {
      update_id: 200,
      message: { message_id: 2, chat: { id: 123 }, text: 'https://x.com/user/status/123' },
    };

    await processUpdate(m1);
    expect(mockedDownload).toHaveBeenCalledTimes(1);

    await processUpdate(m2);
    expect(mockedDownload).toHaveBeenCalledTimes(1);
    expect(mockedSendMessage).toHaveBeenCalledWith(123, '该推文刚刚已处理，已跳过重复请求。');
  });

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

  it('processUpdate owner run 抛错 → 走外层 catch 发错误提示（不吞掉）', async () => {
    mockedDownload.mockRejectedValue(new Error('NOT_FOUND'));
    await processUpdate({
      update_id: 300,
      message: { message_id: 1, chat: { id: 123 }, text: 'https://x.com/user/status/123' },
    });
    expect(mockedSendMessage).toHaveBeenCalledWith(123, '处理媒体内容时出错，请稍后重试。');
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
      await gate; // owner 阻塞，直到手动放行
      return photoTweet();
    });

    try {
      // owner 同步 claim 后才 await run，因此紧随其后的调用是等待者。
      const ownerPromise = processDirectDownload(123, 'https://x.com/user/status/777');

      const waiterRes = await processDirectDownload(123, 'https://x.com/user/status/777');
      expect(waiterRes).toEqual({ success: true, dedup: 'processing' });

      release();
      const ownerRes = await ownerPromise;
      expect(ownerRes).toEqual({ success: true });
    } finally {
      if (oldWait === undefined) delete process.env.DEDUP_WAIT_MS;
      else process.env.DEDUP_WAIT_MS = oldWait;
    }
  });
});
