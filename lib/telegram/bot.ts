import { Bot } from 'grammy';
import { apiThrottler } from '@grammyjs/transformer-throttler';

/**
 * Creates a fresh `Bot` instance with the three-tier throttler registered.
 *
 * Throws when `TELEGRAM_BOT_TOKEN` is missing so the deployment fails fast at
 * boot rather than at the first request.
 */
export function createBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  const bot = new Bot(token);

  // Three-tier throttler using Bottleneck groups:
  //   - global  : reservoir 30/s (Telegram free bot broadcast ceiling)
  //   - group   : per-group throttling: reservoir 20 msg/min (Telegram FAQ)
  //   - out     : per-user (private chat) throttling: maxConcurrent 1, 1 msg/s
  const throttler = apiThrottler({
    global: {
      reservoir: 30,
      reservoirRefreshAmount: 30,
      reservoirRefreshInterval: 1000,
    },
    group: {
      maxConcurrent: 1,
      minTime: 1000,
      reservoir: 20,
      reservoirRefreshAmount: 20,
      reservoirRefreshInterval: 60000,
    },
    out: {
      maxConcurrent: 1,
      minTime: 1000,
    },
  });
  bot.api.config.use(throttler);

  // Global error handler: log Telegram API errors (GrammyError), network
  // errors (HttpError), and any unknown errors. We avoid importing the
  // concrete error classes at module level because the Edge runtime webpack
  // bundle does not reliably re-export them — instead we duck-type on
  // `error_code` / `description` (GrammyError shape) and `message`
  // (HttpError shape).
  bot.catch((err) => {
    const error = err.error as Record<string, unknown> | undefined;
    const updateId = err.ctx?.update?.update_id;

    if (error && typeof error === 'object' && 'error_code' in error) {
      // GrammyError shape
      console.error('[telegram] GrammyError', {
        updateId,
        code: error.error_code,
        description: error.description,
        method: error.method,
      });
    } else if (error instanceof Error) {
      console.error('[telegram] HttpError / network error', {
        updateId,
        name: error.name,
        message: error.message,
      });
    } else {
      console.error('[telegram] unknown error', { updateId, error });
    }
  });

  return bot;
}

/**
 * Lazy singleton that only constructs the Bot when the token is present.
 * When `TELEGRAM_BOT_TOKEN` is missing, `bot` is `undefined` — this avoids
 * throwing at module-load time which makes unit testing impractical.
 *
 * Keep the singleton module-local rather than on `globalThis`. Next.js can
 * compile different route handlers into separate bundles; sharing a Bot across
 * those bundles breaks grammY's `InputFile instanceof` checks for uploads.
 */
function _initBot(): Bot | undefined {
  if (!process.env.TELEGRAM_BOT_TOKEN) return undefined;
  return createBot();
}

/**
 * Singleton bot for this module instance. Importing this module from the same
 * bundle always returns the same instance.
 */
export const bot: Bot | undefined = _initBot();
