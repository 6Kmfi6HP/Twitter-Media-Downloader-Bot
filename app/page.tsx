export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="max-w-2xl w-full space-y-6 text-center">
        <h1 className="text-4xl font-bold">Twitter Media Downloader Bot</h1>
        <p className="text-lg text-gray-600">
          Send Twitter/X links to the Telegram bot to download media content.
        </p>
        <div className="bg-gray-50 p-6 rounded-lg">
          <p className="text-sm text-gray-500">
            Webhook endpoint is active and ready to receive updates.
          </p>
        </div>
      </div>
    </main>
  );
}