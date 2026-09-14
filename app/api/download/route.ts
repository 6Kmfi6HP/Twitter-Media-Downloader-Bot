import { NextResponse } from 'next/server';
import { processDirectDownload, type DownloadResult } from '@/lib/telegram';

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
    const downloadResult: DownloadResult = await processDirectDownload(Number(chatId), url);
    
    if (!downloadResult.success) {
      if (downloadResult.dedup === 'failed') {
        console.log('Download recently failed (dedup):', downloadResult.error);
        return NextResponse.json(
          { ok: false, dedup: 'failed', error: downloadResult.error || 'Download failed' },
          { status: 409 }
        );
      }
      console.log('Download process failed:', downloadResult.error);
      return NextResponse.json(
        { ok: false, error: downloadResult.error || 'Download failed' },
        { status: 400 }
      );
    }

    if (downloadResult.dedup === 'done') {
      console.log('Download already processed recently (dedup: done)');
      return NextResponse.json(
        { ok: true, dedup: 'done', message: 'already processed recently' },
        { status: 200 }
      );
    }

    if (downloadResult.dedup === 'processing') {
      console.log('Download already in progress (dedup: processing)');
      return NextResponse.json(
        { ok: true, dedup: 'processing' },
        { status: 202 }
      );
    }

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
