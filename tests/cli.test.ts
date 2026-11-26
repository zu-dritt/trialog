// The parts of scripts/hub.js that must hold before any request is sent.
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { png } from './fixtures';

const HUB = fileURLToPath(new URL('../scripts/hub.js', import.meta.url));
let dir = '';
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'trialog-cli-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

/** Runs the CLI against an address nothing listens on, so a request that was sent anyway shows up as a different error. */
function hub(...args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [HUB, ...args], {
      env: { ...process.env, HUB_URL: 'http://127.0.0.1:9', HUB_TOKEN: 'cli-test-token-0123456789abcdef' },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stderr, stdout }));
    child.stdin?.end();
  });
}

test('send --attach refuses a file over 4 MB with a clear message, before uploading anything', async () => {
  const big = join(dir, 'big.png');
  await writeFile(big, Buffer.alloc(4 * 1024 * 1024 + 1));
  const ok = join(dir, 'ok.png');
  await writeFile(ok, await png());
  const { code, stderr } = await hub('send', '--attach', ok, '--attach', big, 'caption');
  assert.equal(code, 1);
  assert.match(stderr, /big\.png is 4\.0 MB\. The limit is 4 MB per image/);
  assert.doesNotMatch(stderr, /fetch failed|ECONNREFUSED/, 'no request was attempted');
});

test('send --attach refuses files that are not images, missing files and more than 4 files', async () => {
  const text = join(dir, 'notes.png');
  await writeFile(text, '<html>not an image</html>');
  assert.match((await hub('send', '--attach', text)).stderr, /notes\.png is not a PNG, JPEG or WebP image/);
  assert.match((await hub('send', '--attach', join(dir, 'missing.png'))).stderr, /cannot read .*missing\.png/);
  const ok = join(dir, 'ok2.png');
  await writeFile(ok, await png());
  const five = await hub('send', ...Array(5).fill(['--attach', ok]).flat(), 'five');
  assert.equal(five.code, 1);
  assert.match(five.stderr, /at most 4 images, got 5/);
  assert.equal((await hub('send', '--attach')).code, 64, '--attach needs a file');
});

test('get needs an attachment id', async () => {
  const { code, stderr } = await hub('get', '42');
  assert.equal(code, 64);
  assert.match(stderr, /get needs an attachment id/);
});
