import { NextResponse } from 'next/server';
import { processDirectDownload } from '@/lib/telegram';

export async function POST(req: Request) {
  try {
    console.log('Starting download process...');
    const { chatId, url } = await req.json();
    console.log('Received parameters:', { chatId, url });
    
    if (!chatId || !url) {
      console.log('Missing required parameters:', { chatId, url });
      return NextResponse.json(
        { ok: false, error: 'Missing required parameters' },
        { status: 400 }
      );
    }

    if (!url.includes('twitter.com') && !url.includes('x.com')) {
      console.log('Invalid URL received:', url);
      return NextResponse.json(
        { ok: false, error: 'Invalid Twitter URL' },
        { status: 400 }
      );
    }

    console.log('Starting direct download process for:', { chatId, url });
    await processDirectDownload(Number(chatId), url);
    console.log('Download process completed successfully');
    return NextResponse.json({ ok: true, message: 'Download success.' });
  } catch (error) {
    console.error('Download webhook error:', error);
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
