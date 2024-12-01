import { NextResponse } from 'next/server';
import { processDirectDownload } from '@/lib/telegram';

export async function POST(req: Request) {
  try {
    const { chatId, url } = await req.json();
    
    if (!chatId || !url) {
      return NextResponse.json(
        { ok: false, error: 'Missing required parameters' },
        { status: 400 }
      );
    }

    if (!url.includes('twitter.com') && !url.includes('x.com')) {
      return NextResponse.json(
        { ok: false, error: 'Invalid Twitter URL' },
        { status: 400 }
      );
    }

    await processDirectDownload(Number(chatId), url);
    return NextResponse.json({ ok: true, message: 'Download success.' });
  } catch (error) {
    console.error('Download webhook error:', error);
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
