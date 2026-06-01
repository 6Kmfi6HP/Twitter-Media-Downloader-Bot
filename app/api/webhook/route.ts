import { NextResponse } from 'next/server';
import { processUpdate } from '@/lib/telegram/handler';
import type { TelegramUpdate } from '@/lib/telegram/types';

export async function POST(request: Request): Promise<Response> {
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
