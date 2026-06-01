## ADDED Requirements

### Requirement: Singleton Bot client

The system SHALL provide a single `Bot` instance constructed from `TELEGRAM_BOT_TOKEN` and reused across requests via `globalThis` caching.

#### Scenario: First access constructs the bot

- **WHEN** any module imports `bot` from `lib/telegram/bot.ts` and `globalThis.__telegramBot` is undefined
- **THEN** the system creates a new `Bot` instance, registers the `apiThrottler` plugin, and caches it on `globalThis.__telegramBot`

#### Scenario: Subsequent access returns cached bot

- **WHEN** any module imports `bot` from `lib/telegram/bot.ts` and `globalThis.__telegramBot` is already defined
- **THEN** the system returns the cached instance without constructing a new one

#### Scenario: Missing bot token throws at boot

- **WHEN** the application starts without `TELEGRAM_BOT_TOKEN` set
- **THEN** the system throws an error during `createBot()` execution

### Requirement: Built-in API throttling aligned with Telegram rate limits

The system SHALL apply a three-tier `apiThrottler` on the `Bot` instance to stay within Telegram's documented rate limits.

#### Scenario: Throttler is registered with three tiers

- **WHEN** the bot is created
- **THEN** the system registers `apiThrottler` from `@grammyjs/transformer-throttler` with:
  - `global: { maxConcurrent: 1, minTime: 35 }` (≈28 msg/s, leaving ~7% margin below Telegram's 30 msg/s broadcast ceiling)
  - `perChat: { maxConcurrent: 1, minTime: 1000 }` (1 msg/s per private chat, matching Telegram FAQ)
  - `perGroupChat: { maxConcurrent: 1, minTime: 3000 }` (20 msg/min per group, matching Telegram FAQ)

#### Scenario: 429 responses are retried automatically

- **WHEN** the Telegram API responds with HTTP 429 and a `retry_after` field
- **THEN** the SDK waits the suggested duration and retries the request without throwing to the caller

#### Scenario: Throttled requests are logged

- **WHEN** a request is throttled by the local throttler (not by Telegram)
- **THEN** the system logs the event via the `onThrottled` callback

### Requirement: Webhook adapter for Next.js App Router with Edge runtime

The system SHALL expose a webhook entry point that integrates with Next.js App Router `Request`/`Response` semantics, constrained to the Edge runtime.

#### Scenario: Webhook POST invokes the registered handlers

- **WHEN** `app/api/webhook/route.ts` receives a POST with a valid Telegram Update JSON body
- **THEN** the system uses `webhookCallback(bot, "std/http")` to dispatch the update through the bot's middleware chain

#### Scenario: Webhook route declares Edge runtime

- **WHEN** `app/api/webhook/route.ts` is loaded
- **THEN** the file exports `export const runtime = "edge"` because the `std/http` adapter requires Web Fetch `Request`/`Response` types that are only reliable in Edge runtime

#### Scenario: GET returns service status

- **WHEN** a GET request hits the webhook endpoint
- **THEN** the system returns HTTP 200 with `{ status: "Telegram webhook endpoint is running" }`

#### Scenario: Webhook errors are caught and logged

- **WHEN** a webhook update handler throws an error
- **THEN** the system logs the error via `bot.catch` and responds HTTP 200 so Telegram does not retry indefinitely

### Requirement: Bot instance is stateless between requests

The system SHALL NOT call `bot.start()` or maintain long-polling connections; the bot SHALL operate solely through the webhook callback and direct `bot.api.*` calls.

#### Scenario: No long-polling loop runs

- **WHEN** the application is deployed
- **THEN** no background polling is started by the bot module

#### Scenario: bot.api calls work without start

- **WHEN** `bot.api.sendMessage(...)` is invoked from an API route
- **THEN** the call succeeds without requiring `bot.start()` to be called first

### Requirement: Bot error handling via bot.catch

The system SHALL install a global `bot.catch` handler that distinguishes between `GrammyError` (Telegram API errors), `HttpError` (network errors), and unknown errors.

#### Scenario: GrammyError is logged with API error code

- **WHEN** a Telegram API call fails with a `GrammyError` (e.g., message too long, chat not found, message too old to delete)
- **THEN** the system logs the error code and description

#### Scenario: HttpError is logged as network failure

- **WHEN** an HTTP call to Telegram fails with a `HttpError` (network unreachable, DNS failure)
- **THEN** the system logs the error as a network error without crashing the request handler
