import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to reset the module cache between tests so the singleton behavior
// can be observed, and we need to control the env var.
const ORIGINAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

describe('createBot + bot singleton', () => {
  beforeEach(() => {
    // Wipe the global singleton so each test gets a fresh evaluation.
    // eslint-disable-next-line
    delete (globalThis as any).__telegramBot;
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_TOKEN;
    }
  });

  it('createBot throws when TELEGRAM_BOT_TOKEN is missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { createBot } = await import('../bot');
    expect(() => createBot()).toThrowError(/TELEGRAM_BOT_TOKEN/);
  });

  it('bot singleton is undefined when token is missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { bot } = await import('../bot');
    expect(bot).toBeUndefined();
  });

  it('returns the same singleton across imports', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const first = await import('../bot');
    const second = await import('../bot');
    expect(first.bot).toBe(second.bot);
  });

  it('registers a throttler transformer on the bot config', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const { createBot } = await import('../bot');
    const bot = createBot();

    // The throttler installs a transformer; we just assert the bot has at
    // least one transformer registered so the throttler wiring is in place.
    // grammY exposes `installedTransformers()` on `bot.api.config`.
    const transformers = bot.api.config.installedTransformers();
    expect(transformers.length).toBeGreaterThan(0);
  });
});
