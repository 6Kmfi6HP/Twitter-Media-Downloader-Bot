import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  pickBestMediaUrl: vi.fn((item: { variants?: Array<{ url?: string }> }) => item.variants?.[0]?.url ?? ''),
}));

vi.mock('../../twitter', () => ({
  downloadTwitterMedia: vi.fn(),
}));

import { processDirectDownload } from '../handler';
import { sendMessage } from '../messages';
import { formatTweetCaption_without_name } from '../formatter';
import { downloadTwitterMedia } from '../../twitter';

const mockedSendMessage = sendMessage as unknown as ReturnType<typeof vi.fn>;
const mockedFormat = formatTweetCaption_without_name as unknown as ReturnType<typeof vi.fn>;
const mockedDownload = downloadTwitterMedia as unknown as ReturnType<typeof vi.fn>;

function mockVideoTweet(overrides: Record<string, unknown> = {}) {
  return {
    type: 'video',
    media_items: [{
      type: 'video',
      url: 'https://example.com/video.mp4',
      media_url_https: 'https://example.com/thumb.jpg',
      sizes: { large: { w: 1, h: 1, resize: 'fit' }, medium: { w: 1, h: 1, resize: 'fit' }, small: { w: 1, h: 1, resize: 'fit' }, thumb: { w: 1, h: 1, resize: 'fit' } },
      variants: [{ content_type: 'video/mp4', bitrate: 1000, url: 'https://example.com/video.mp4' }],
    }],
    tweet: { id: '123', text: '', created_at: '', user: {}, reply_count: 0, retweet_count: 0, quote_count: 0, favorite_count: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFormat.mockResolvedValue('caption');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('processDirectDownload size guard', () => {
  it('stops before downloading when HEAD reports oversized video', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
    mockedDownload.mockResolvedValue(mockVideoTweet());

    let getRequestCount = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(51 * 1024 * 1024) },
        });
      }
      getRequestCount += 1;
      throw new Error('unexpected GET download');
    });
    vi.stubGlobal('fetch', fetchMock);

    await processDirectDownload(123, 'https://x.com/user/status/123');

    expect(getRequestCount).toBe(0);
    expect(mockedSendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining('视频过大')
    );
  });

  it('proceeds with the normal download when HEAD is unavailable', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
    mockedDownload.mockResolvedValue(mockVideoTweet());
    mockedSendMessage.mockResolvedValue({ message_id: 1 });

    let getRequestCount = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 405 });
      }
      getRequestCount += 1;
      return new Response(new Uint8Array([1, 2, 3]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { sendMediaGroup } = await import('../messages');
    (sendMediaGroup as any).mockResolvedValue([]);

    await processDirectDownload(123, 'https://x.com/user/status/123');

    expect(getRequestCount).toBe(1);
  });
});
