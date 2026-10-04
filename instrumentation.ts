/**
 * Next.js instrumentation hook — Node 运行时每次启动时执行一次。
 * 用于自动注册 Telegram webhook：本应用收到消息完全依赖 webhook,
 * 而 webhook 注册信息存在 Telegram 服务器侧、曾被外部清空且无任何
 * 告警导致长时间静默。启动时重新注册保证部署/重启后自愈。
 *
 * 需要环境变量:
 *   TELEGRAM_WEBHOOK_URL    — 完整回调地址,例如
 *                             https://site--xxx.code.run/api/webhook
 *   TELEGRAM_WEBHOOK_SECRET — 可选,设置后 webhook 路由会校验
 *                             X-Telegram-Bot-Api-Secret-Token 头
 * 两者未配置时静默跳过(本地开发、构建期不受影响)。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const url = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!url || !token) return;

  const apiRoot = process.env.TELEGRAM_API_ROOT?.trim() || 'https://api.telegram.org';
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  try {
    const body: Record<string, unknown> = {
      url,
      allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
    };
    if (secret) body.secret_token = secret;

    const res = await fetch(`${apiRoot}/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (data.ok) {
      console.log(`[webhook] registered: ${url}${secret ? ' (secret enabled)' : ''}`);
    } else {
      console.error(`[webhook] registration rejected: ${data.description}`);
    }
  } catch (err) {
    // 注册失败不应阻止服务启动;但必须在日志里显著暴露。
    console.error('[webhook] registration failed:', err);
  }
}
