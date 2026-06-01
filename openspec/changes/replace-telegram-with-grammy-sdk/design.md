## Context

- 项目是一个 Next.js 13.5（App Router）+ TypeScript 的 Twitter 媒体下载 Bot，部署在 Vercel 上，通过 Telegram Webhook 接收用户消息后下载并回传媒体
- 现有 Telegram 集成存在**三套分散实现**：
  - `lib/telegram.ts`（11.6 KB 单体）：完整 `processUpdate`/`processDirectDownload` 实现，含 t.co 短链展开、提示消息清理、FormData 视频上传
  - `lib/telegram/`（模块化拆分但**行为降级**）：`api.ts` 简化为 JSON `sendMediaGroup`（**无视频上传分支**）、`handler.ts:processUpdate` 丢失 t.co 替换与消息清理、`formatter.ts:formatTweetCaption` 改为同步不做 t.co 替换
  - `app/api/send/route.ts`：使用 `telegram`（GramJS/MTProto）走 MTProto 协议，需要 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`
- **审计发现的关键问题**：
  - `app/api/download/route.ts:2` 通过 `@/lib/telegram` 导入 `processDirectDownload`，但 `lib/telegram/index.ts` 只 re-export `processUpdate` —— **download 路由实际仍走旧 `lib/telegram.ts`**，新模块化结构未被 download 路由采用
  - 同名类型 `MediaItem` 语义相反：旧 `lib/telegram.ts:19-26` 是 Twitter 源（含 `variants[]`），新 `lib/telegram/types.ts:13-18` 是 Telegram 目标（无 `variants`）
- `package.json` 包含 `telegram: ^2.26.16`（GramJS），但只用 `/api/send` 路由
- 没有单测（`lib/__tests__/` 为空），错误处理只通过 `console.error`
- Vercel 部署是 serverless，冷启动期间重复构造 fetch 客户端可接受，但持久化 Bot 实例需 `globalThis` 缓存

## Goals / Non-Goals

**Goals:**

- 用 grammY 统一所有 Bot API 调用，消除三套实现的重复并修复行为降级
- 替换 `app/api/send/route.ts` 的 MTProto 路径，删除 GramJS 依赖与 `TELEGRAM_API_ID/HASH` 环境变量
- 保持 webhook 端点 URL 兼容（`/api/webhook`），对 Telegram 一侧零变更
- 引入 `apiThrottler`（`@grammyjs/transformer-throttler`）按 Telegram 官方限流配置（global 30 msg/s、perChat 1 msg/s、perGroupChat 20 msg/min）
- 用 `InputFile` / `InputMediaBuilder` 替换手写的 FormData + `attach://` 视频上传
- 保持 `processDirectDownload` 对外行为（`{ success, error? }`），调用方零修改
- 利用 `globalThis` 单例模式让 Bot 实例跨冷启动共享
- **修复新模块化结构的三个回归**：t.co 短链展开、提示消息删除清理、5 秒延迟错误清理、视频上传路径

**Non-Goals:**

- 不实现 Bot 命令路由的语义化重构（仅替换调用层）
- 不引入数据库或持久化状态
- 不迁移到 long polling（仍用 webhook，匹配 Vercel 部署）
- 不升级 Next.js 版本
- 不修改 `lib/telegram/index.ts` 公共导出契约（保持 `import { processUpdate } from '@/lib/telegram'` 兼容）
- 不做 e2e 自动化（保留手动 webhook 验证流程）

## Decisions

### Decision 1: 选择 grammY 而非 Telegraf / node-telegram-bot-api

- **理由**：grammY 是 TypeScript 一等公民（基准 90.3，远高于 Telegraf 78.4 与 node-telegram-bot-api 72.4），自带的 `webhookCallback` 适配器直接对接 Vercel Edge Runtime，内置 `apiThrottler` + `autoRetry` 替换手写 429 处理，`InputMediaBuilder` 让媒体组构造变成类型安全的链式调用
- **备选 Telegraf**：JavaScript 起家，类型定义弱，社区版 TS 支持不及 grammY
- **备选 node-telegram-bot-api**：仅基本类型，缺限流/重试，需要 long polling
- **结论**：采用 `grammy` 主体 + `@grammyjs/transformer-throttler` 限流

### Decision 2: 删除 MTProto 路径

- **理由**：`/api/send` 路由用 MTProto 仅做"发送一条消息"演示，与 webhook 路径不一致；Bot API `sendMessage` 完全等效
- **代价**：删除 `app/api/send/route.ts`（**BREAKING**）、删除 `telegram` npm 依赖、`.env.example` 移除 `TELEGRAM_API_ID/HASH`
- **回退**：未来若需 userbot 能力（GramJS 优势），可单独建 `lib/telegram/userbot.ts` 走 MTProto 单独管理

### Decision 3: 单例 Bot + globalThis 缓存

- **理由**：Vercel serverless 冷启动期间重复构造 `new Bot()` 浪费延迟；跨请求复用同一实例让 webhook 与 `/api/download` 共享连接
- **实现**：

  ```ts
  declare global { var __telegramBot: Bot | undefined }
  export const bot = globalThis.__telegramBot ??= createBot()
  ```
- **回退**：dev/production 统一单例；不增加 `NODE_ENV` 判断

### Decision 4: Next.js Edge runtime 约束

- **理由**：`webhookCallback(bot, "std/http")` 适配器要求 Web Fetch 风格 `Request`/`Response`；**grammY 官方 Vercel 文档仅演示 `api/bot.ts` 文件模式**（含 Edge Function 示例 `export const config = { runtime: "edge" }`），**未演示 Next.js App Router `route.ts` 模式**。Next.js App Router 在 Node.js runtime 下早期版本不直接提供 Web Request，必须显式声明 `export const runtime = "edge"`
- **方案**：在 `app/api/webhook/route.ts` 顶部声明 `export const runtime = "edge"`；handler 仅依赖 grammY + Web 标准 API，不使用 Node 专属 API
- **回退**：若 Edge runtime 出现冷启动或兼容性回退问题，备选方案是用 Node.js runtime 手动桥接 `"https"` 适配器（`webhookCallback(bot, "https")(await req.text(), headers)`），但需额外胶水代码

### Decision 5: 限流配置对齐 Telegram 官方文档

- **依据**（来源 https://core.telegram.org/bots/faq#broadcasting-to-users）：
  - 同一 chat 私聊：≤ 1 msg/s
  - 同一 group：≤ 20 msg/min（≈ 0.33 msg/s/group）
  - 全局广播（免费 bot）：≤ ~30 msg/s
  - 付费 bot：≤ 1000 msg/s
- **方案**（用 `apiThrottler`）：

  ```ts
  const throttler = apiThrottler({
    global:       { maxConcurrent: 1, minTime: 35 },     // ~28 msg/s, 留 ~7% 余量
    perChat:      { maxConcurrent: 1, minTime: 1000 },   // 1 msg/s/chat
    perGroupChat: { maxConcurrent: 1, minTime: 3000 },   // 20 msg/min/group
    onThrottled:  (retryAfter) => console.warn('throttled', retryAfter),
  });
  bot.api.config.use(throttler);
  ```
- **结论**：提案中"25 msg/s"是错的——25 不是 Telegram 限流数字，应以 30 为基准并按 perChat/perGroupChat 分别限速

### Decision 6: caption 截断与 HTML 转义

- **理由**：现有 `processDirectDownload` 在 caption > 1024 字符时截断为 `...`，但 `parse_mode: 'HTML'` 下未转义 `<`/`>`/`&`/`，长文本会触发 400（"400 Bad Request: Cannot parse entities"）
- **方案**：新建 `lib/telegram/caption.ts` 暴露：
  - `escapeHtml(text)`：转义 `&`、`<`、`>`、`"`、`'`，对齐 grammY `entity-parser` 插件推荐的 `textSanitizer` 集合
  - `truncateForCaption(text, limit = 1024)`：先转义再截断到 `limit - 3` 字符 + `...`
- **回退**：若用 `MarkdownV2` 需更激进转义（所有 `_` `*` `[` `]` `(` `)` `~` `` ` `` `>` `#` `+` `-` `=` `|` `{` `}` `.` `!`）；保持 HTML

### Decision 7: 视频上传用 `InputFile` + `InputMediaBuilder`

- **理由**：新 `lib/telegram/api.ts:sendMediaGroup` 仅做 JSON 调用，**没有视频分支**；旧 `lib/telegram.ts` 用 FormData + `attach://` 协议。grammY `InputMediaBuilder.video(new InputFile(buffer, 'video.mp4'))` 抽象掉 FormData 构造
- **方案**：

  ```ts
  const media = items.map((it, i) => {
    const opts = { caption: i === 0 ? caption : undefined, parse_mode: 'HTML' as const };
    return it.type === 'video'
      ? InputMediaBuilder.video(new InputFile(it.buffer, 'video.mp4'), opts)
      : InputMediaBuilder.photo(it.url, opts);
  });
  await bot.api.sendMediaGroup(chatId, media);
  ```
- **已知限制**：`InputFile` 仍要求 `Buffer` 或可读流；本路由依赖 `fetch` 下载到 `ArrayBuffer` 再 `Buffer.from(...)`。流式优化留待未来
- **修复的回归**：让 `handler.ts:processUpdate` 调用的 `sendMediaGroup` 支持视频，恢复旧 `lib/telegram.ts:51-107` 的行为

### Decision 8: 错误处理用 `GrammyError` / `HttpError`

- **理由**：Telegram Bot API 错误（如消息太旧、chat 未找到、解析失败）抛 `GrammyError`；网络错误（无法连接）抛 `HttpError`
- **方案**：在 `messages.ts` 包装层 `try/catch`，对 `deleteMessage` 旧消息（>48h）显式忽略 `GrammyError`；其他错误向上抛出，handler 用 `try/catch` 包裹业务逻辑并发送降级提示

### Decision 9: 单测范围

- **范围**：单测以下纯函数（不依赖网络）：
  - `truncateForCaption`
  - `escapeHtml`
  - `formatTweetCaption`
  - `createBot()` 单例行为（mock `globalThis.__telegramBot`）
- **不单测**：`bot.api.*`（依赖真实 Telegram）、webhook 端到端
- **框架**：项目当前无测试框架；引入 `vitest` 最小配置（dev dep），不引入 jest（避免与 Next 13 兼容问题）

## Risks / Trade-offs

- **Risk**：grammY 单例在 Vercel 实例上累积内部状态（如 token 解析缓存），长期运行可能内存增长 → **Mitigation**：webhook 模型不调用 `bot.start()`，仅实例化 `Bot` 用于 `bot.api.*` 调用，无长驻连接
- **Risk**：删除 MTProto 路径后任何依赖 `/api/send` 的外部脚本失效 → **Mitigation**：`/api/download` 已提供等效功能；记录在 commit message 与 README
- **Risk**：grammY 文档更新频繁，API 可能在 v1.x → v2 变化 → **Mitigation**：固定到 `grammy@^1.x` 直至人工升级
- **Risk**：HTML 转义不完整（emoji 变体选择器、ZWNJ）触发 Telegram 400 → **Mitigation**：仅转义 `&`/`<`/`>`/`"`/`'`，与 grammY `entity-parser` 推荐的 `textSanitizer` 对齐
- **Risk**：vitest 引入增加 dev 依赖 → **Mitigation**：仅 dev 安装，不入 production bundle
- **Risk**：未启用限流触发 429 → **Mitigation**：强制 `apiThrottler` 三层配置（global 30、perChat 1、perGroupChat 0.33）
- **Risk**：Next.js Edge runtime 限制（部分 npm 包不可用）→ **Mitigation**：本 webhook handler 仅依赖 grammY + Web 标准，函数体无文件 I/O 或 Node Buffer 操作；若 `telegram` 删后无 Node-only 依赖则安全
- **Risk**：std/http 适配器在 Next.js Node.js runtime 下不工作 → **Mitigation**：显式声明 `export const runtime = "edge"`，CI/Vercel 部署均可识别
- **Risk**：迁移后未恢复 t.co 短链展开 → **Mitigation**：tasks 5.x 显式要求 `replaceShortLinks` 工具函数从旧 `lib/telegram.ts:190-226` 移植到 `lib/telegram/handler.ts`
- **Risk**：迁移后未恢复提示消息清理 → **Mitigation**：tasks 5.x 显式要求在 `processUpdate` 成功路径与错误路径都调用 `deleteMessage(processingMsg.result.message_id)`，错误路径用 `setTimeout(..., 5000)`

## Migration Plan

1. **依赖更新**：在分支中 `npm install grammy @grammyjs/transformer-throttler vitest --save-dev`，`npm uninstall telegram`
2. **并行实现**：
   - 写 `lib/telegram/bot.ts`（单例 + `apiThrottler`）
   - 写 `lib/telegram/messages.ts`（包装 `sendMessage`/`sendPhoto`/`sendMediaGroup`/`deleteMessage`，使用 `InputMediaBuilder`）
   - 写 `lib/telegram/caption.ts`（`escapeHtml` + `truncateForCaption`）
3. **迁移调用点**：
   - 重写 `lib/telegram/handler.ts`：
     - `processUpdate`：恢复 `replaceShortLinks`、提示消息删除、5 秒延迟清理；改用 `messages.ts` 包装层
     - 新建 `processDirectDownload`：从旧 `lib/telegram.ts:242-362` 迁入并用 SDK 重写（视频走 `InputFile`，HTML 转义 + caption 截断）
   - `app/api/webhook/route.ts` 顶部声明 `export const runtime = "edge"`，POST handler 改为 `webhookCallback(bot, "std/http")`
   - `app/api/download/route.ts` 修复 `import` 路径（`processDirectDownload` 现在 re-export 自 `@/lib/telegram`）
4. **删除**：`lib/telegram.ts`（旧单体）、`app/api/send/route.ts`（MTProto 路径）
5. **环境**：`update .env.example` 移除 `TELEGRAM_API_ID/HASH`，README 更新
6. **测试**：`lib/telegram/__tests__/` 下新增 `bot.test.ts`、`caption.test.ts`、`handler.test.ts`
7. **验证**：
   - `npm run lint` 通过
   - `npm run build` 通过
   - `npx vitest run` 单测全绿
   - Vercel preview 部署，BotFather 设置 webhook 到 `https://<domain>/api/webhook`，发送真实 Twitter 链接验证端到端
   - 测试 video 推文、photo 推文、长 caption 推文（>1024 字符）、含 t.co 短链的推文
8. **回滚**：若验证失败，保留旧 `lib/telegram.ts` 在 git 历史中，`git revert` 合并提交即可恢复

## Open Questions

- Q1：是否需要支持 inline keyboard（如 "下载音频/无水印" 按钮）？当前不在范围，未来可在 `bot.on("message")` 内挂 action
- Q2：`processDirectDownload` 是否需要返回更结构化的错误码（如 `DOWNLOAD_FAILED` / `NO_MEDIA`）以让前端判断？本期仅保留 `success: boolean` 与 `error: string`
- Q3：是否在 webhook 入口加 `secret_token` 校验？Telegram 支持通过 `setWebhook` 设置，grammY `webhookCallback` 提供 `secretToken` 选项；本期为最小变更不启用，建议在 follow-up 中加入
- Q4：Edge runtime 冷启动延迟相对 Node runtime 的实际差异（Vercel 公开数据 ~50ms vs ~250ms）？如果用户体验出现明显卡顿，考虑回退到 Node runtime + `"https"` 适配器
