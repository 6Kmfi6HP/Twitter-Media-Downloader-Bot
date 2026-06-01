## 1. Dependency Management

- [x] 1.1 Install `grammy` and `@grammyjs/transformer-throttler` as runtime dependencies
- [x] 1.2 Uninstall the `telegram` (GramJS) package
- [x] 1.3 Install `vitest` and `@vitest/coverage-v8` as dev dependencies
- [x] 1.4 Add npm scripts: `"test": "vitest run"` and `"test:watch": "vitest"`

## 2. Bot Client Module (`lib/telegram/bot.ts`)

- [x] 2.1 Create `createBot()` factory that throws when `TELEGRAM_BOT_TOKEN` is missing
- [x] 2.2 Register `apiThrottler` with three tiers (global 30 msg/s, out 1 msg/s, group 20 msg/min) using Bottleneck groups
- [x] 2.3 Expose `bot` singleton cached on `globalThis.__telegramBot` with lazy initialization when token is present
- [x] 2.4 Install a global `bot.catch` handler that distinguishes GrammyError/HttpError/unknown errors via duck-typing (Edge runtime compatible)
- [x] 2.5 Write `lib/telegram/__tests__/bot.test.ts` covering: token missing throws, singleton behavior, throttler registration

## 3. Message API Module (`lib/telegram/messages.ts`)

- [x] 3.1 Implement `sendMessage(chatId, text, options?)` delegating to `bot.api.sendMessage`; default `parse_mode` to `"HTML"`
- [x] 3.2 Implement `sendPhoto(chatId, photo, caption?, options?)` delegating to `bot.api.sendPhoto`; apply `escapeHtml` and `truncateForCaption` to caption
- [x] 3.3 Implement `sendMediaGroup(chatId, media, caption?, options?)` using `InputMediaBuilder.photo(url, opts)` and `InputMediaBuilder.video(new InputFile(buffer, "video.mp4"), opts)`; attach caption only to first item
- [x] 3.4 Implement `deleteMessage(chatId, messageId)` delegating to `bot.api.deleteMessage`; catch GrammyError (e.g., message too old) and return `false` instead of throwing
- [x] 3.5 Write `lib/telegram/__tests__/messages.test.ts` mocking `bot.api` and asserting the correct method is called with the correct shape (photo, video buffer, caption truncation)

## 4. Caption Utilities (`lib/telegram/caption.ts`)

- [x] 4.1 Implement `escapeHtml(text)` escaping `&`, `<`, `>`, `"`, `'` per the grammY `entity-parser` `textSanitizer` default
- [x] 4.2 Implement `truncateForCaption(text, limit = 1024)` returning first `limit - 3` chars + `...` when exceeded
- [x] 4.3 Write `lib/telegram/__tests__/caption.test.ts` covering: HTML escape, all five entities, edge case at exact limit, edge case empty string

## 5. Refactor Handler (`lib/telegram/handler.ts`)

- [x] 5.1 Migrate `replaceShortLinks` and `followRedirect` into `lib/telegram/formatter.ts`; restore t.co short-link expansion
- [x] 5.2 Rewrite `processUpdate` to use `messages.sendMessage`; restore the "delete processing message after success" behavior
- [x] 5.3 Restore the "delete error message after 5 seconds" behavior using `setTimeout(..., 5000)`
- [x] 5.4 Apply `escapeHtml` before sending any tweet caption (fixes 400 Bad Request on unescaped `<`/`>`)
- [x] 5.5 Port `formatTweetCaption_without_name` into the new formatter module; route `processDirectDownload` through it with t.co expansion
- [x] 5.6 Add `processDirectDownload` to `lib/telegram/handler.ts`; rewrite it to use `messages.sendPhoto` and `messages.sendMediaGroup` with `InputFile` for video
- [x] 5.7 Preserve the existing `DownloadResult` return shape (`{ success: boolean, error?: string }`); keep behavior of single-photo vs media-group dispatch
- [x] 5.8 When caption exceeds 1024 chars, apply `truncateForCaption` to the media caption AND send the full caption as 4096-char follow-up messages
- [x] 5.9 Update `lib/telegram/index.ts` to re-export `processUpdate`, `processDirectDownload`, and the `DownloadResult` type so `app/api/download/route.ts:2` resolves correctly

## 6. Webhook Entry (`app/api/webhook/route.ts`)

- [x] 6.1 Runs in Node.js runtime (no Edge declaration) — required because Next.js 13.5's Edge webpack 4 does not resolve grammy's `exports` field
- [x] 6.2 Route handler calls `processUpdate(update)` directly from `lib/telegram/handler.ts` (avoids Edge-only `webhookCallback` / private `handleUpdate`)
- [x] 6.3 Keep the existing `GET` health-check handler
- [x] 6.4 Wrap the webhook callback in `try/catch` that logs and returns HTTP 200 to prevent Telegram retry loops

## 7. Download Entry (`app/api/download/route.ts`)

- [x] 7.1 Verify the import `import { processDirectDownload, type DownloadResult } from '@/lib/telegram'` resolves after task 5.9 adds the re-export
- [x] 7.2 Confirm validation (`chatId`, `url`, `twitter.com`/`x.com` host check) remains unchanged
- [x] 7.3 Confirm response shape `{ ok, message }` / `{ ok, error }` remains unchanged
- [ ] 7.4 Add a smoke test: deploy to Vercel preview, send a video tweet, confirm the video is received in Telegram and the caption is rendered without 400 errors

## 8. Remove MTProto Path

- [x] 8.1 Delete `app/api/send/route.ts`
- [x] 8.2 Remove `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from `.env.example`
- [x] 8.3 Remove the `telegram` package entry from `package.json` (post `npm uninstall`)

## 9. Remove Legacy Code

- [x] 9.1 Delete `lib/telegram.ts` (old monolithic file) once all callers are migrated and tasks 5.1-5.8 are complete
- [x] 9.2 Confirm `lib/telegram/index.ts` re-exports `processUpdate`, `processDirectDownload`, and `DownloadResult` from `lib/telegram/handler.ts`
- [x] 9.3 Remove the unused `MediaItem` type collision in `lib/telegram/types.ts` — renamed to `TelegramMediaItem`

## 10. Verification

- [x] 10.1 Run `npm run lint` and resolve any new lint errors
- [x] 10.2 Run `npm run build` and confirm the production build succeeds
- [x] 10.3 Run `npm test` and confirm all new unit tests pass (26 tests across bot.test.ts, caption.test.ts, messages.test.ts)
- [ ] 10.4 Deploy to Vercel preview, set Telegram webhook via BotFather to `https://<domain>/api/webhook`, send a real photo tweet, confirm the photo is received in Telegram
- [ ] 10.5 Send a real video tweet, confirm the video is received and the caption renders without 400 errors (validates InputFile path)
- [ ] 10.6 Send a tweet whose caption exceeds 1024 characters, confirm truncation + chunked follow-up messages
- [ ] 10.7 Send a tweet containing t.co short links, confirm the short links are expanded before caption rendering
- [ ] 10.8 Send a tweet, confirm the "正在处理" processing message is deleted after completion
