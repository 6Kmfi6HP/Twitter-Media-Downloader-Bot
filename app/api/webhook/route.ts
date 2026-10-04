import { NextResponse } from 'next/server';
import { processUpdate } from '@/lib/telegram/handler';
import type { TelegramUpdate } from '@/lib/telegram/types';

export async function POST(request: Request): Promise<Response> {
  // 配置了 TELEGRAM_WEBHOOK_SECRET 时强制校验 Telegram 附带的 secret 头,
  // 防止回调地址泄露后被伪造 update 注入。webhook 通过 instrumentation
  // hook 注册时会自动带上同一 secret。
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    console.warn('[webhook] rejected: missing or invalid secret token');
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const update: TelegramUpdate = await request.json();
    await processUpdate(update);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[webhook] unhandled error:', err);
    // Return 200 to prevent Telegram from retrying indefinitely.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json({ status: 'Telegram webhook endpoint is running' });
}
