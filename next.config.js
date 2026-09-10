/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: { unoptimized: true },
  webpack: (config) => {
    // grammY pulls in node-fetch, whose optional `encoding` dependency is not
    // needed here because all Bot API requests use the native fetch provided
    // in bot.ts. Ignore that optional import to keep `next build` clean.
    config.resolve.fallback = { ...config.resolve.fallback, encoding: false };
    return config;
  },
};

module.exports = nextConfig;
