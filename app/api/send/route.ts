import { NextResponse } from 'next/server';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
// import { BigInteger } from 'telegram/tl/types';
import { generateRandomLong } from 'telegram/Helpers';

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
  throw new Error('Missing required Telegram API credentials');
}

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const apiId = process.env.TELEGRAM_API_ID;
const apiHash = process.env.TELEGRAM_API_HASH;
let client: TelegramClient;
let isClientInitialized = false;

async function getClient() {
  if (!client) {
    client = new TelegramClient(
      new StringSession(''), // Empty session for bot
      Number(apiId), 
      apiHash,
      {
        connectionRetries: 5,
      }
    );
  }
  
  if (!isClientInitialized) {
    try {
      await client.connect();
      await client.start({
        botAuthToken: botToken,
      });
      isClientInitialized = true;
    } catch (error) {
      console.error('Bot authorization error:', error);
      return { error: 'Failed to authorize bot' };
    }
  }
  
  return { client };
}

export async function POST(req: Request) {
  try {
    console.log('Starting GramJS send process...');
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

    const clientResult = await getClient();
    if ('error' in clientResult) {
      return NextResponse.json(
        { ok: false, error: clientResult.error },
        { status: 401 }
      );
    }

    try {
      // 使用 MTProto 请求发送消息
      const result = await clientResult.client.invoke(new Api.messages.SendMessage({
        peer: chatId,
        message: `Processing URL: ${url}`,
        randomId: generateRandomLong()
      }));

      console.log('Message sent successfully via GramJS');
      return NextResponse.json({ ok: true, message: 'Message sent successfully' });
    } catch (gramError) {
      console.error('GramJS error:', gramError);
      return NextResponse.json(
        { ok: false, error: 'Failed to send message via GramJS' },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error('Send webhook error:', error);
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
