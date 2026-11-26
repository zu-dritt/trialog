import { randomBytes } from 'node:crypto';
import type { NextConfig } from 'next';

// An opaque id for this build, new on every build (and on every start of the dev server). The
// server reports it and the page knows the one it was built with; when they differ, the page tells
// the reader that a newer version is available. TRIALOG_BUILD_ID can set it, for a test or a
// build pipeline that has an id of its own. It is not a secret and says nothing about the host.
const buildId = process.env.TRIALOG_BUILD_ID || randomBytes(6).toString('hex');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Written into the server code and the page code at build time, so both carry the same value.
  env: { TRIALOG_BUILD_ID: buildId },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;
