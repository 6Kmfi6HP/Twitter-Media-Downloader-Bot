import { NextResponse } from 'next/server';
import { processUpdate } from '@/lib/telegram';

export async function POST(req: Request) {
  try {
    const update = await req.json();
    await processUpdate(update);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: 'Telegram webhook endpoint is running' });
}