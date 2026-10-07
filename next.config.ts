import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // The published package is a static export of the UI (out/) served by the
  // small Node server in server/, which also answers the API. Next itself is
  // only a dev and build tool, never a runtime dependency.
  output: isDev ? undefined : 'export',
  // API route handlers (app/api/*/route.dev.ts) are mounted for `next dev`
  // only: a static export cannot contain dynamic routes, so the build does not
  // see them. Production serves the identical handlers from server/http.ts.
  pageExtensions: isDev ? ['dev.ts', 'ts', 'tsx'] : ['ts', 'tsx'],
  images: { unoptimized: true },
};

export default nextConfig;
