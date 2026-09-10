import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { GrammyError } from 'grammy';

// Mock the bot module so the messages module can be tested without touching
// the real Bot instance or the throttler transformer chain.
vi.mock('../bot', () => {
  const api = {
    sendMessage: vi.fn(),
    sendPhoto: vi.fn(),
    sendMediaGroup: vi.fn(),
    deleteMessage: vi.fn(),
  };
  return {
    bot: {
      api,
    },
  };
});

// Import after the mock is registered.
import {
  sendMessage,
  sendPhoto,
  sendMediaGroup,
  deleteMessage,
  sendLongCaption,
} from '../messages';
import { bot } from '../bot';
import { getTelegramApiRoot, getMaxUploadBytes } from '../limits';

const mockedBot = bot as NonNullable<typeof bot>;
const api = mockedBot.api as unknown as {
  sendMessage: Mock;
  sendPhoto: Mock;
  sendMediaGroup: Mock;
  deleteMessage: Mock;
};
const ORIGINAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function grammyHttpError(method: string): Error {
  const error = new Error(`Network request for '${method}' failed!`);
  error.name = 'HttpError';
  return error;
}

const ORIGINAL_API_ROOT = process.env.TELEGRAM_API_ROOT;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_TOKEN;
  }
  if (ORIGINAL_API_ROOT === undefined) {
    delete process.env.TELEGRAM_API_ROOT;
  } else {
    process.env.TELEGRAM_API_ROOT = ORIGINAL_API_ROOT;
  }
});


describe('Telegram API root configuration', () => {
  const ORIGINAL_API_ROOT = process.env.TELEGRAM_API_ROOT;

  afterEach(() => {
    if (ORIGINAL_API_ROOT === undefined) {
      delete process.env.TELEGRAM_API_ROOT;
    } else {
      process.env.TELEGRAM_API_ROOT = ORIGINAL_API_ROOT;
    }
  });

  it('uses the official API root by default', () => {
    delete process.env.TELEGRAM_API_ROOT;
        expect(getTelegramApiRoot()).toBe('https://api.telegram.org');
  });

  it('uses a configured self-hosted API root', () => {
    process.env.TELEGRAM_API_ROOT = 'http://localhost:8081';
        expect(getTelegramApiRoot()).toBe('http://localhost:8081');
  });

  it('strips a trailing slash from the API root', () => {
    process.env.TELEGRAM_API_ROOT = 'http://localhost:8081/';
        expect(getTelegramApiRoot()).toBe('http://localhost:8081');
  });

  it('picks the official 50MiB limit by default', () => {
    delete process.env.TELEGRAM_API_ROOT;
        expect(getMaxUploadBytes()).toBe(50 * 1024 * 1024);
  });

  it('picks the self-hosted 2000MiB limit when configured', () => {
    process.env.TELEGRAM_API_ROOT = 'http://localhost:8081';
        expect(getMaxUploadBytes()).toBe(2000 * 1024 * 1024);
  });
});

describe('sendMessage', () => {
  beforeEach(() => {
    api.sendMessage.mockReset();
    api.sendMessage.mockResolvedValue({ message_id: 1 });
  });

  it('calls bot.api.sendMessage with default HTML parse_mode', async () => {
    await sendMessage(123, 'hello');
    expect(api.sendMessage).toHaveBeenCalledWith(
      123,
      'hello',
      expect.objectContaining({ parse_mode: 'HTML' })
    );
  });

  it('honors an explicit parse_mode override', async () => {
    await sendMessage(123, 'hello', { parse_mode: 'MarkdownV2' });
    expect(api.sendMessage).toHaveBeenCalledWith(
      123,
      'hello',
      expect.objectContaining({ parse_mode: 'MarkdownV2' })
    );
  });
});

describe('sendPhoto', () => {
  beforeEach(() => {
    api.sendPhoto.mockReset();
    api.sendPhoto.mockResolvedValue({ message_id: 1 });
  });

  it('escapes and truncates the caption', async () => {
    const caption = '<b>not bold</b>'; // 16 chars, under limit
    await sendPhoto(123, 'https://example.com/x.jpg', caption);
    expect(api.sendPhoto).toHaveBeenCalledWith(
      123,
      'https://example.com/x.jpg',
      expect.objectContaining({
        caption: '&lt;b&gt;not bold&lt;/b&gt;',
        parse_mode: 'HTML',
      })
    );
  });

  it('truncates captions over 1024 chars to 1021 + ellipsis', async () => {
    const caption = 'a'.repeat(1500);
    await sendPhoto(123, 'https://example.com/x.jpg', caption);
    const call = api.sendPhoto.mock.calls[0][2] as { caption: string };
    expect(call.caption.length).toBe(1024);
    expect(call.caption.endsWith('...')).toBe(true);
  });

  it('falls back to native Bot API when grammY sendPhoto has a network error', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
    api.sendPhoto.mockRejectedValueOnce(grammyHttpError('sendPhoto'));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }))
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      sendPhoto(123, 'https://example.com/x.jpg', 'cap')
    ).resolves.toEqual({ message_id: 2 });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/sendPhoto'),
      expect.objectContaining({ method: 'POST' })
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: 123,
      photo: 'https://example.com/x.jpg',
      caption: 'cap',
      parse_mode: 'HTML',
    });
  });
});

describe('sendMediaGroup', () => {
  beforeEach(() => {
    api.sendMediaGroup.mockReset();
    api.sendMediaGroup.mockResolvedValue([]);
  });

  it('attaches the caption to the first item only', async () => {
    await sendMediaGroup(
      123,
      [
        { type: 'photo', media: 'https://example.com/a.jpg' },
        { type: 'photo', media: 'https://example.com/b.jpg' },
      ],
      'hello'
    );
    const arg = api.sendMediaGroup.mock.calls[0][1] as Array<{
      type: string;
      caption?: string;
    }>;
    expect(arg).toHaveLength(2);
    expect(arg[0].caption).toBe('hello');
    expect(arg[1].caption).toBeUndefined();
  });

  it('wraps a video Buffer in an InputFile named video.mp4', async () => {
    const buf = Buffer.from([1, 2, 3]);
    await sendMediaGroup(123, [{ type: 'video', media: buf }], 'cap');
    const arg = api.sendMediaGroup.mock.calls[0][1] as Array<{
      type: string;
      media: { filename?: string; _fileName?: string };
    }>;
    expect(arg[0].type).toBe('video');
    // InputFile exposes the filename internally — accept either spelling.
    const fileRef = arg[0].media as unknown as Record<string, unknown>;
    const filename = (fileRef.filename as string) ?? (fileRef._fileName as string);
    expect(filename).toBe('video.mp4');
  });

  it('uses configured Telegram API root for native sendPhoto fallback', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
    process.env.TELEGRAM_API_ROOT = 'http://localhost:8081';
    api.sendPhoto.mockRejectedValueOnce(grammyHttpError('sendPhoto'));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }))
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await sendPhoto(123, 'https://example.com/x.jpg', 'cap');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:8081/bot123:test-token/sendPhoto'
    );
  });

  it('falls back to native FormData upload when grammY sendMediaGroup has a network error', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
    api.sendMediaGroup.mockRejectedValueOnce(grammyHttpError('sendMediaGroup'));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: [{ message_id: 3 }] }))
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      sendMediaGroup(
        123,
        [{ type: 'video', media: Buffer.from([1, 2, 3]), filename: 'clip.mp4' }],
        'cap'
      )
    ).resolves.toEqual([{ message_id: 3 }]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);

    const formData = init.body as FormData;
    expect(formData.get('chat_id')).toBe('123');
    expect(JSON.parse(formData.get('media') as string)).toEqual([
      {
        type: 'video',
        media: 'attach://video0',
        caption: 'cap',
        parse_mode: 'HTML',
      },
    ]);
    expect(formData.get('video0')).toBeInstanceOf(Blob);
  });
});

describe('deleteMessage', () => {
  beforeEach(() => {
    api.deleteMessage.mockReset();
  });

  it('returns true on success', async () => {
    api.deleteMessage.mockResolvedValueOnce(true);
    await expect(deleteMessage(123, 1)).resolves.toBe(true);
  });

  it('returns false on GrammyError (e.g. message too old)', async () => {
    api.deleteMessage.mockRejectedValueOnce(
      new GrammyError('Call to deleteMessage failed', {
        ok: false,
        error_code: 400,
        description: "message can't be deleted",
      }, 'deleteMessage', { chat_id: 123, message_id: 999 })
    );
    await expect(deleteMessage(123, 999)).resolves.toBe(false);
  });

  it('rethrows non-Grammy errors', async () => {
    api.deleteMessage.mockRejectedValueOnce(new Error('boom'));
    await expect(deleteMessage(123, 1)).rejects.toThrow('boom');
  });
});

describe('sendLongCaption', () => {
  beforeEach(() => {
    api.sendMessage.mockReset();
    api.sendMessage.mockResolvedValue({ message_id: 1 });
  });

  it('chunks text into 4096-char messages', async () => {
    const long = 'a'.repeat(9000);
    await sendLongCaption(123, long);
    // 9000 / 4096 = 3 chunks (4096, 4096, 808)
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    const chunks = api.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(chunks[0].length).toBe(4096);
    expect(chunks[1].length).toBe(4096);
    expect(chunks[2].length).toBe(808);
  });
});
