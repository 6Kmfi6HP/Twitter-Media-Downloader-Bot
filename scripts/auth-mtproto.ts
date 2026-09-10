/**
 * scripts/auth-mtproto.ts
 *
 * 一次性交互脚本：用 bot token 在 mtcute 里登录 MTProto,
 * 生成可复用的 session 字符串并打印出来,方便贴到
 * TELEGRAM_MT_PROTO_SESSION 环境变量里。
 *
 * 用法:
 *   npx tsx scripts/auth-mtproto.ts
 *
 * 前提:
 *   .env.local 里已有 TELEGRAM_BOT_TOKEN / TELEGRAM_API_ID / TELEGRAM_API_HASH
 */
import 'dotenv/config';
import { config as loadDotenv } from 'dotenv';

// dotenv/config 只读 .env。Next.js 的本地开发实际读 .env.local,要明确载入。
loadDotenv({ path: '.env.local', override: true });

async function main() {
  const { TelegramClient } = await import('@mtcute/node');

  const apiIdRaw = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!apiIdRaw || !apiHash || !botToken) {
    console.error(
      '请先在 .env.local 里设置 TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_BOT_TOKEN'
    );
    process.exit(1);
  }

  const client = new TelegramClient({
    apiId: Number(apiIdRaw),
    apiHash,
    storage: '.mtcute-session.sqlite',
    disableUpdates: true,
    logLevel: 2,
  });

  console.log('正在以 bot token 登录 MTProto ...');
  const self = await client.start({ botToken });
  console.log('登录成功:', { id: self.id, username: (self as { username?: string }).username });

  const session = await client.exportSession();
  console.log('\n=== MTProto Session ===');
  console.log(session);
  console.log('======================\n');
  console.log('把上面这串字符串复制到:');
  console.log('  - .env.local 的 TELEGRAM_MT_PROTO_SESSION');
  console.log('  - Docker / secrets 管理器同名变量');

  await client.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
