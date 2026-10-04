/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: { unoptimized: true },
  // mtcute is a Node-only MTProto client with native bindings
  // (better-sqlite3). Tell Next.js to leave it as an external `require` in
  // the server bundle instead of trying to bundle it.
  experimental: {
    serverComponentsExternalPackages: ['@mtcute/node', '@mtcute/core', '@mtcute/html-parser', 'better-sqlite3'],
    // Next 13.5 需要显式开启 instrumentation hook(用于启动时自动注册 Telegram webhook);
    // 升级 Next 14+ 后此开关默认启用,可移除。
    instrumentationHook: true,
  },
  webpack: (config) => {
    // grammY pulls in node-fetch, whose optional `encoding` dependency is not
    // needed here because all Bot API requests use the native fetch provided
    // in bot.ts. Ignore that optional import to keep `next build` clean.
    config.resolve.fallback = { ...config.resolve.fallback, encoding: false };
    return config;
  },
};

module.exports = nextConfig;
