#!/usr/bin/env node
// Fails when a commit in a range carries an email address that is not a no-reply address.
//
//   node scripts/check-commit-addresses.js origin/playground..HEAD
//
// Why: this repository is public, and GitHub keeps the commits of a pull request for ever,
// even after a force-push. An address that gets in can't be taken out again. So the author
// and the committer of every commit must use a GitHub no-reply address, and the addresses in
// "Co-authored-by" and "Signed-off-by" lines must be no-reply addresses of some kind.
//
// The output names the commit and the field, never the address itself: CI logs are public too.
//
// No dependencies, so it also runs before `npm install`.

import { execFileSync } from 'node:child_process';

// 12345+name@users.noreply.github.com, name@users.noreply.github.com, name[bot]@…, and GitHub's own
// noreply@github.com, which it uses as the committer of merges made on the website.
const GITHUB_NOREPLY = /^(?:(?:\d+\+)?[A-Za-z0-9-]+(?:\[bot\])?@users\.noreply\.github\.com|noreply@github\.com)$/;
// Trailers may also name a tool's no-reply address, such as noreply@anthropic.com.
const ANY_NOREPLY = /^(?:noreply|no-reply)@[A-Za-z0-9.-]+$/;
const TRAILER = /^(?:co-authored-by|signed-off-by):.*<([^<>]*)>\s*$/i;

const FIELD = '\x1f';
const RECORD = '\x1e';

function main() {
  const range = process.argv[2];
  if (!range || process.argv.length > 3) {
    console.error('usage: node scripts/check-commit-addresses.js <git range, for example origin/playground..HEAD>');
    process.exit(2);
  }

  let out;
  try {
    out = execFileSync('git', ['log', `--format=%H${FIELD}%ae${FIELD}%ce${FIELD}%B${RECORD}`, range, '--'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`check-commit-addresses: git log failed for "${range}"`);
    if (err && err.stderr) console.error(String(err.stderr).trim());
    process.exit(2);
  }

  const problems = [];
  let count = 0;
  for (const record of out.split(RECORD)) {
    const [hash, author, committer, body = ''] = record.replace(/^\s+/, '').split(FIELD);
    if (!hash) continue;
    count += 1;
    const short = hash.slice(0, 7);
    if (!GITHUB_NOREPLY.test(author)) problems.push(`${short}: the author address is not a GitHub no-reply address`);
    if (!GITHUB_NOREPLY.test(committer)) problems.push(`${short}: the committer address is not a GitHub no-reply address`);
    for (const line of body.split('\n')) {
      const m = TRAILER.exec(line.trim());
      if (!m) continue;
      const address = m[1].trim();
      if (!GITHUB_NOREPLY.test(address) && !ANY_NOREPLY.test(address)) {
        const key = line.trim().split(':')[0];
        problems.push(`${short}: a "${key}" line carries an address that is not a no-reply address`);
      }
    }
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error('');
    console.error('Use your GitHub no-reply address (GitHub: Settings, Emails, "Keep my email addresses private"):');
    console.error('  git config user.email "<id>+<username>@users.noreply.github.com"');
    console.error('then rewrite the commits and push them to a NEW branch. See CONTRIBUTING.md.');
    process.exit(1);
  }
  console.log(`check-commit-addresses: ${count} commit${count === 1 ? '' : 's'} checked, all addresses are no-reply addresses.`);
}

main();
