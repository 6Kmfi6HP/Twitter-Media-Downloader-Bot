import { NextResponse } from 'next/server';
import { enqueueAndWait } from '@/lib/queue';

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

    console.log('Enqueuing download job for:', { chatId, url });
    // 队列模式:先进队列由 worker 消费,同步等待终态以保持对外契约不变。
    // 超时(默认 8 分钟)返回 202,任务继续在后台执行。
    const outcome = await enqueueAndWait(Number(chatId), url);

    if (outcome.status === 'queued') {
      console.log('Job still running past wait timeout, returning 202');
      return NextResponse.json(
        { ok: true, dedup: 'processing', queued: true },
        { status: 202 }
      );
    }

    if (outcome.status === 'failed') {
      if (outcome.dedup === 'failed') {
        console.log('Download recently failed (dedup):', outcome.error);
        return NextResponse.json(
          { ok: false, dedup: 'failed', error: outcome.error || 'Download failed' },
          { status: 409 }
        );
      }
      console.log('Download process failed:', outcome.error);
      return NextResponse.json(
        { ok: false, error: outcome.error || 'Download failed' },
        { status: 400 }
      );
    }

    if (outcome.dedup === 'done') {
      console.log('Download already processed recently (dedup: done)');
      return NextResponse.json(
        { ok: true, dedup: 'done', message: 'already processed recently' },
        { status: 200 }
      );
    }

    if (outcome.dedup === 'processing') {
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
