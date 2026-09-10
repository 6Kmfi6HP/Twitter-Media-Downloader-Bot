import type { TelegramClient } from '@mtcute/node';
import type { Message } from '@mtcute/core';
import type { PhotoMediaItem, VideoMediaItem } from './messages';

export type MtprotoMediaItem = PhotoMediaItem | VideoMediaItem;

interface MtprotoConfig {
  apiId: number;
  apiHash: string;
  botToken: string;
  session: string | undefined;
}

function readConfig(): MtprotoConfig | undefined {
  const apiIdRaw = process.env.TELEGRAM_API_ID?.trim();
  const apiHash = process.env.TELEGRAM_API_HASH?.trim();
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!apiIdRaw || !apiHash || !botToken) return undefined;

  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId) || apiId <= 0) return undefined;

  return {
    apiId,
    apiHash,
    botToken,
    session: process.env.TELEGRAM_MT_PROTO_SESSION?.trim() || undefined,
  };
}

export function isMtprotoConfigured(): boolean {
  return readConfig() !== undefined;
}

interface ClientState {
  promise: Promise<TelegramClient> | undefined;
  ready: boolean;
  failed: boolean;
}

const state: ClientState = {
  promise: undefined,
  ready: false,
  failed: false,
};

async function createClient(config: MtprotoConfig): Promise<TelegramClient> {
  const { TelegramClient } = await import('@mtcute/node');

  const client = new TelegramClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage: '.mtcute-session.sqlite',
    disableUpdates: true,
    logLevel: 2,
  });

  if (config.session) {
    await client.importSession(config.session, true);
    await client.connect();
    return client;
  }

  await client.start({ botToken: config.botToken });
  return client;
}

/**
 * Returns the singleton mtcute client. Lazily initialises on first call and
 * caches the Promise so concurrent callers share the same connection attempt.
 * If the connection fails permanently, subsequent calls throw the cached
 * error until the process restarts.
 */
export function getMtprotoClient(): Promise<TelegramClient> {
  if (state.failed) {
    return Promise.reject(
      new Error('MTProto client previously failed to initialise; restart required')
    );
  }
  if (!state.promise) {
    const config = readConfig();
    if (!config) {
      state.failed = true;
      return Promise.reject(
        new Error(
          'MTProto credentials not configured. Set TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_BOT_TOKEN.'
        )
      );
    }
    state.promise = createClient(config)
      .then((client) => {
        state.ready = true;
        return client;
      })
      .catch((err) => {
        state.failed = true;
        state.promise = undefined;
        throw err;
      });
  }
  return state.promise;
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

type AnyInputMedia = ReturnType<
  (typeof import('@mtcute/node'))['InputMedia']['photo']
> | ReturnType<(typeof import('@mtcute/node'))['InputMedia']['video']>;

async function uploadOne(
  item: MtprotoMediaItem,
  index: number,
  captionHtmlForFirst: string
): Promise<AnyInputMedia> {
  const { InputMedia, html } = await import('@mtcute/node');

  const file =
    item.type === 'video'
      ? item.media
      : typeof item.media === 'string'
      ? await downloadToBuffer(item.media)
      : item.media;

  const caption = index === 0 && captionHtmlForFirst.length > 0 ? html(captionHtmlForFirst) : undefined;

  if (item.type === 'video') {
    return InputMedia.video(file as never, {
      fileName: item.filename ?? `video_${index}.mp4`,
      caption,
      supportsStreaming: true,
    });
  }

  return InputMedia.photo(file as never, {
    fileName: `photo_${index}.jpg`,
    caption,
  });
}

/**
 * Sends a media group through MTProto. Used when any item exceeds the Bot
 * API 50 MB upload limit.
 *
 * `captionHtml` is already HTML-escaped upstream by `formatTweetCaption`;
 * we re-parse it into mtcute's TextWithEntities via the bundled `html`
 * helper so it renders exactly the same as on the Bot API side.
 */
export async function sendMediaGroupViaMtproto(
  chatId: number | string,
  media: MtprotoMediaItem[],
  captionHtml: string
): Promise<Message[]> {
  if (media.length === 0) {
    throw new Error('sendMediaGroupViaMtproto: media must be non-empty');
  }
  if (media.length > 10) {
    throw new Error(
      `sendMediaGroupViaMtproto: media.length=${media.length} exceeds Telegram media group limit of 10`
    );
  }

  const client = await getMtprotoClient();

  const inputMedias = [];
  for (let i = 0; i < media.length; i++) {
    inputMedias.push(await uploadOne(media[i], i, captionHtml));
  }

  const sent = await client.sendMediaGroup(chatId, inputMedias as never);
  return Array.isArray(sent) ? (sent as Message[]) : ([sent] as unknown as Message[]);
}

/** Test-only helper to reset the cached client state between tests. */
export function __resetMtprotoStateForTests(): void {
  state.promise = undefined;
  state.ready = false;
  state.failed = false;
}
