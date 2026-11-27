import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { NextConfig } from 'next';
import pkg from './package.json';
import { pullRequestOf, versionLabel } from './lib/build';

// An opaque id for this build, new on every build (and on every start of the dev server). The
// server reports it and the page knows the one it was built with; when they differ, the page tells
// the reader that a newer version is available. TRIALOG_BUILD_ID can set it, for a test or a
// build pipeline that has an id of its own. It is not a secret and says nothing about the host.
const buildId = process.env.TRIALOG_BUILD_ID || randomBytes(6).toString('hex');

// The version people say («v0.3», from package.json) and the build: the pull request the deployed
// commit came from. Vercel hands over the commit message; elsewhere git is asked, and without git
// there is simply no build number.
function lastCommitMessage(): string {
  if (process.env.VERCEL_GIT_COMMIT_MESSAGE) return process.env.VERCEL_GIT_COMMIT_MESSAGE;
  try {
    return execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}
const version = versionLabel(pkg.version);
const buildNumber = process.env.TRIALOG_BUILD_NUMBER ?? pullRequestOf(lastCommitMessage());

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Written into the server code and the page code at build time, so both carry the same value.
  env: { TRIALOG_BUILD_ID: buildId, TRIALOG_VERSION: version, TRIALOG_BUILD_NUMBER: buildNumber, TRIALOG_DEMO: process.env.TRIALOG_DEMO === '1' ? '1' : '', TRIALOG_DEMO_URL: process.env.TRIALOG_DEMO_URL ?? '', TRIALOG_REPO: process.env.TRIALOG_REPO ?? '' },
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
