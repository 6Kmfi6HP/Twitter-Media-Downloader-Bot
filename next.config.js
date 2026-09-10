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
    serverComponentsExternalPackages: ['@mtcute/node', '@mtcute/core', '@mtcute/html-parser'],
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
