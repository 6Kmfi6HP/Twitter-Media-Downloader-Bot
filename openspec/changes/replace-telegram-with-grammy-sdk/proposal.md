## Why

项目当前通过两套自实现路径访问 Telegram：Bot API 直接 `fetch`（`lib/telegram.ts` + `lib/telegram/api.ts`）与 MTProto/GramJS（`app/api/send/route.ts`）。这两条路径各自维护请求构造、FormData 视频上传、HTML 转义、429 限流、错误重试与本地 `TelegramUpdate` 类型，重复且脆弱——任何 Bot API 字段更新都需要手动同步，长期累积技术债。**审计揭示的额外事实**：（1）`app/api/download/route.ts:2` 通过 `@/lib/telegram` 导入 `processDirectDownload` 但 `lib/telegram/index.ts` 未 re-export，该路由实际仍走旧 `lib/telegram.ts`；（2）新的 `lib/telegram/handler.ts:processUpdate` 相比旧版丢失了 t.co 短链展开、提示消息删除与 5 秒延迟清理三处行为；（3）新 `lib/telegram/api.ts:sendMediaGroup` 缺少视频上传分支，video 推文会发送失败。替换为单一标准 SDK（grammY）后，可一次性获得类型安全、自动限流、统一错误处理与官方 Webhook 适配，并修复以上三处行为降级。

## What Changes

- 引入 `grammy` 与官方 `@grammyjs/transformer-throttler` 作为 Bot API 调用的唯一入口
- 新建 `lib/telegram/bot.ts` 暴露单例 `Bot` 实例，复用 `TELEGRAM_BOT_TOKEN` 并应用 `apiThrottler`（global 30 msg/s + per-chat 1 msg/s + per-group 20 msg/min，对齐 Telegram 官方限流）
- 新建 `lib/telegram/messages.ts` 封装 `sendMessage`/`sendPhoto`/`sendMediaGroup`/`deleteMessage`，使用 `InputMediaBuilder` 构造媒体项，捕获 `GrammyError`
- 改造 `app/api/webhook/route.ts` 使用 `webhookCallback(bot, "std/http")`，**必须**在文件顶部声明 `export const runtime = "edge"`，因为 std/http 适配器需要 Web Fetch 风格 Request/Response（Next.js Node.js runtime 不直接提供）
- 改造 `app/api/download/route.ts` 走 SDK 通道处理媒体下载与分段发送；修复当前 re-export 路径断裂
- 删除 `app/api/send/route.ts` 的 MTProto 路径（**BREAKING**：删除 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` 环境变量）
- 删除 `lib/telegram.ts` 旧单体文件（**BREAKING**：`@/lib/telegram.ts` 不再可导入），迁移 `processDirectDownload` 与 `formatTweetCaption_without_name` 等旧版独有行为到 `lib/telegram/handler.ts` 与 `lib/telegram/caption.ts`
- 恢复旧 `processUpdate` 的三处行为：t.co 短链展开（`replaceShortLinks`）、"正在处理"提示消息删除、5 秒延迟错误清理
- 移除 `telegram`（GramJS）npm 依赖与 `.env.example` 中相关键
- 新增 `lib/telegram/caption.ts` 暴露 `escapeHtml`（转义 `&`/`<`/`>`）与 `truncateForCaption`（默认 1024 字符，含溢出文本的分段消息回退）
- 新增 `lib/telegram/__tests__/` 下的 vitest 单测，覆盖 `escapeHtml`、`truncateForCaption`、`formatTweetCaption`、`createBot()` 单例行为

## Capabilities

### New Capabilities

- `telegram-bot-client`: 统一 Bot 实例、`apiThrottler` 配置（global/perChat/perGroupChat）、单例导出与 Next.js Webhook 适配（Edge runtime 约束）
- `telegram-message-api`: 消息与媒体发送 API（`sendMessage`、`sendPhoto`、`sendMediaGroup`、`deleteMessage`），含 caption 截断、HTML 转义、`GrammyError` 捕获

### Modified Capabilities

<!-- 无现有 specs；首次提交时全部为新增 -->

## Impact

- **代码**：`lib/telegram.ts`（删除）、`lib/telegram/api.ts`（重写以支持视频 InputFile）、`lib/telegram/handler.ts`（合并 `processDirectDownload`、恢复 `replaceShortLinks` 与提示消息清理、修复 video 路径）、`lib/telegram/formatter.ts`（改为薄包装，复杂度下沉到 caption.ts）、`app/api/webhook/route.ts`（改用 webhookCallback + `runtime = "edge"`）、`app/api/download/route.ts`（修复 re-export 路径）、`app/api/send/route.ts`（删除）
- **依赖**：`+ grammy`、`+ @grammyjs/transformer-throttler`、`+ vitest` (dev)、`- telegram`（GramJS）
- **环境变量**：删除 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`；保留 `TELEGRAM_BOT_TOKEN`
- **API 契约**：webhook 接口仍接受原始 Telegram Update JSON（grammY 内部解构），对 Telegram 一侧零变更
- **运行时约束**：`app/api/webhook/route.ts` 必须声明 `export const runtime = "edge"`，因为 std/http 适配器依赖 Web Fetch `Request`/`Response`；Edge runtime 不支持部分 Node API，本路由不依赖文件系统/Buffer 之外的 Node 能力
- **限流**：global 30 msg/s、perChat 1 msg/s、perGroupChat 20 msg/min；429 由 Telegram 返回 `retry_after` 字段，transformer-throttler 自动重试
- **测试**：当前 `lib/__tests__/` 为空，新增 vitest 最小配置；行为类回归仍通过手动 webhook + 真实 Telegram Bot Token 验证
