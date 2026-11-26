import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Runs the real script against a throwaway git repository. All addresses below are made up.
const script = path.resolve(__dirname, '../scripts/check-commit-addresses.js');
const GOOD = '12345+some-agent@users.noreply.github.com';
const BAD = 'someone@example.com';

let repo = '';
let n = 0;

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  }).trim();
}

function commit(message: string, author = GOOD, committer = GOOD): string {
  n += 1;
  writeFileSync(path.join(repo, 'file.txt'), `${n}\n`);
  git(['add', 'file.txt']);
  git(['commit', '-q', '-m', message], {
    GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: committer,
  });
  return git(['rev-parse', 'HEAD']);
}

function check(range: string) {
  const r = spawnSync(process.execPath, [script, range], { cwd: repo, encoding: 'utf8' });
  return { status: r.status, text: r.stdout + r.stderr };
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'trialog-addresses-'));
  git(['init', '-q', '-b', 'main']);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test('passes when author, committer and trailers all use no-reply addresses', () => {
  const base = commit('first');
  commit('second', GOOD, 'noreply@github.com');
  commit('third\n\nCo-authored-by: Some Agent <some-agent@users.noreply.github.com>\nCo-Authored-By: A Tool <noreply@anthropic.com>');
  const r = check(`${base}..HEAD`);
  assert.equal(r.status, 0, r.text);
  assert.match(r.text, /2 commits checked/);
});

test('fails on a real author address, and never prints it', () => {
  const base = git(['rev-parse', 'HEAD']);
  const bad = commit('by a person', BAD, GOOD);
  const r = check(`${base}..HEAD`);
  assert.equal(r.status, 1, r.text);
  assert.match(r.text, new RegExp(`${bad.slice(0, 7)}: the author address`));
  assert.ok(!r.text.includes(BAD), 'the address must not appear in the output');
});

test('fails on a real committer address', () => {
  const base = git(['rev-parse', 'HEAD']);
  commit('committed by a person', GOOD, BAD);
  const r = check(`${base}..HEAD`);
  assert.equal(r.status, 1, r.text);
  assert.match(r.text, /the committer address/);
  assert.ok(!r.text.includes(BAD));
});

test('fails on a real address in a Co-authored-by or Signed-off-by line', () => {
  for (const key of ['Co-authored-by', 'Signed-off-by']) {
    const base = git(['rev-parse', 'HEAD']);
    commit(`with a trailer\n\n${key}: Some One <${BAD}>`);
    const r = check(`${base}..HEAD`);
    assert.equal(r.status, 1, r.text);
    assert.match(r.text, new RegExp(`"${key}" line`));
    assert.ok(!r.text.includes(BAD));
  }
});

test('an address that only looks like a no-reply address is refused', () => {
  for (const address of ['me@users.noreply.github.com.example.com', 'noreply@github.com.example.com', 'a b@users.noreply.github.com']) {
    const base = git(['rev-parse', 'HEAD']);
    commit('lookalike', address, GOOD);
    assert.equal(check(`${base}..HEAD`).status, 1, address);
  }
});

test('an address mentioned in ordinary message text is not a trailer and is ignored', () => {
  const base = git(['rev-parse', 'HEAD']);
  commit('docs: the example uses <user@example.com> as a placeholder');
  assert.equal(check(`${base}..HEAD`).status, 0);
});

test('a single commit instead of a range checks that commit and what came before it', () => {
  // CI passes a bare commit for the very first commit of a repository, which has no parent to start a range from.
  const root = git(['rev-list', '--max-parents=0', 'HEAD']);
  const r = check(root);
  assert.equal(r.status, 0, r.text);
  assert.match(r.text, /1 commit checked/);
  assert.equal(check('HEAD').status, 1, 'the history above contains bad addresses');
});

test('a missing or broken range is a usage error, not a pass', () => {
  assert.equal(spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' }).status, 2);
  assert.equal(check('no-such-branch..HEAD').status, 2);
});
