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
  pickBestMediaUrl: vi.fn(
    (item: {
      type?: 'photo' | 'video';
      media_url_https?: string;
      variants?: Array<{ url?: string }>;
    }) => item.variants?.[0]?.url ?? item.media_url_https ?? ''
  ),
}));

vi.mock('../../twitter', () => ({
  downloadTwitterMedia: vi.fn(),
}));

vi.mock('../mtproto', () => ({
  isMtprotoConfigured: vi.fn(),
  sendMediaGroupViaMtproto: vi.fn(),
}));

import { processDirectDownload } from '../handler';
import { sendMessage, sendMediaGroup } from '../messages';
import { downloadTwitterMedia } from '../../twitter';
import {
  isMtprotoConfigured,
  sendMediaGroupViaMtproto,
} from '../mtproto';

const mockedSendMessage = sendMessage as unknown as ReturnType<typeof vi.fn>;
const mockedSendMediaGroup = sendMediaGroup as unknown as ReturnType<typeof vi.fn>;
const mockedDownload = downloadTwitterMedia as unknown as ReturnType<typeof vi.fn>;
const mockedIsConfigured = isMtprotoConfigured as unknown as ReturnType<typeof vi.fn>;
const mockedSendViaMtproto = sendMediaGroupViaMtproto as unknown as ReturnType<typeof vi.fn>;

const UNDER_LIMIT = 10 * 1024 * 1024;   // 10 MB
const OVER_LIMIT = 60 * 1024 * 1024;    // 60 MB (>50 MB Bot API cap)

function makeTweet(mediaItems: Array<Record<string, unknown>>) {
  return {
    type: 'video',
    media_items: mediaItems,
    tweet: {
      id: '123',
      text: '',
      created_at: '',
      user: {},
      reply_count: 0,
      retweet_count: 0,
      quote_count: 0,
      favorite_count: 0,
    },
  };
}

function videoItem(url: string) {
  return {
    type: 'video' as const,
    url,
    media_url_https: 'https://example.com/thumb.jpg',
    variants: [{ content_type: 'video/mp4', bitrate: 1000, url }],
  };
}

function photoItem(url: string) {
  return { type: 'photo' as const, media_url_https: url };
}

function stubFetchWithSizes(sizes: Record<string, number>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') {
      const size = sizes[url];
      return new Response(null, {
        status: 200,
        headers: size !== undefined ? { 'content-length': String(size) } : {},
      });
    }
    return new Response(new Uint8Array([1, 2, 3]));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
  mockedSendMessage.mockResolvedValue({ message_id: 1 });
  mockedSendMediaGroup.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dispatchTweet routing (Bot API vs MTProto)', () => {
  it('routes every video through Bot API when all sizes are under the limit', async () => {
    const video = videoItem('https://example.com/small.mp4');
    mockedDownload.mockResolvedValue(makeTweet([video]));
    vi.stubGlobal('fetch', stubFetchWithSizes({ 'https://example.com/small.mp4': UNDER_LIMIT }));
    mockedIsConfigured.mockReturnValue(true);   // even if configured, small videos stay on Bot API

    await processDirectDownload(123, 'https://x.com/user/status/123');

    expect(mockedSendViaMtproto).not.toHaveBeenCalled();
    expect(mockedSendMediaGroup).toHaveBeenCalledTimes(1);
  });

  it('routes the whole group via MTProto when one video exceeds the limit and MTProto is configured', async () => {
    const video = videoItem('https://example.com/big.mp4');
    const photo = photoItem('https://example.com/pic.jpg');
    mockedDownload.mockResolvedValue(makeTweet([video, photo]));
    vi.stubGlobal(
      'fetch',
      stubFetchWithSizes({ 'https://example.com/big.mp4': OVER_LIMIT })
    );
    mockedIsConfigured.mockReturnValue(true);
    mockedSendViaMtproto.mockResolvedValue([]);

    await processDirectDownload(123, 'https://x.com/user/status/123');

    expect(mockedSendViaMtproto).toHaveBeenCalledTimes(1);
    const [, items] = mockedSendViaMtproto.mock.calls[0];
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('video');
    expect(items[1].type).toBe('photo');
    // no per-item "video too large" notice
    expect(
      mockedSendMessage.mock.calls.some((c) => String(c[1]).includes('视频过大'))
    ).toBe(false);
    // Bot API sendMediaGroup must not be called
    expect(mockedSendMediaGroup).not.toHaveBeenCalled();
  });

  it('falls back to the Bot API path when MTProto throws', async () => {
    const video = videoItem('https://example.com/big.mp4');
    const photo = photoItem('https://example.com/pic.jpg');
    mockedDownload.mockResolvedValue(makeTweet([video, photo]));
    vi.stubGlobal(
      'fetch',
      stubFetchWithSizes({ 'https://example.com/big.mp4': OVER_LIMIT })
    );
    mockedIsConfigured.mockReturnValue(true);
    mockedSendViaMtproto.mockRejectedValue(new Error('mtproto exploded'));

    await processDirectDownload(123, 'https://x.com/user/status/123');

    expect(mockedSendViaMtproto).toHaveBeenCalledTimes(1);
    // falls back to Bot API: sends the "video too large" notice AND the rest of the group
    expect(
      mockedSendMessage.mock.calls.some((c) => String(c[1]).includes('视频过大'))
    ).toBe(true);
    expect(mockedSendMediaGroup).toHaveBeenCalledTimes(1);
    // the group sent via Bot API contains only the photo
    const [, items] = mockedSendMediaGroup.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('photo');
  });

  it('skips oversized video with a notice when MTProto is not configured', async () => {
    const video = videoItem('https://example.com/big.mp4');
    const photo = photoItem('https://example.com/pic.jpg');
    mockedDownload.mockResolvedValue(makeTweet([video, photo]));
    vi.stubGlobal(
      'fetch',
      stubFetchWithSizes({ 'https://example.com/big.mp4': OVER_LIMIT })
    );
    mockedIsConfigured.mockReturnValue(false);

    await processDirectDownload(123, 'https://x.com/user/status/123');

    expect(mockedSendViaMtproto).not.toHaveBeenCalled();
    expect(
      mockedSendMessage.mock.calls.some((c) => String(c[1]).includes('视频过大'))
    ).toBe(true);
    expect(mockedSendMediaGroup).toHaveBeenCalledTimes(1);
    const [, items] = mockedSendMediaGroup.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('photo');
  });
});
