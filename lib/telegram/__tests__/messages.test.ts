import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
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

const api = bot.api as unknown as {
  sendMessage: Mock;
  sendPhoto: Mock;
  sendMediaGroup: Mock;
  deleteMessage: Mock;
};

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
      new GrammyError('Bad Request: message can\'t be deleted', {
        ok: false,
        error_code: 400,
        description: "message can't be deleted",
        method: 'deleteMessage',
      } as unknown as Response)
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
