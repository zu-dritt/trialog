// The version people say («v0.3») and the build (the pull request): how they are read and shown.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLabel, pullRequestOf, versionLabel } from '../lib/build';

test('package.json versions become v0.3; a patch of 0 is left out', () => {
  assert.equal(versionLabel('0.3.0'), 'v0.3');
  assert.equal(versionLabel('0.3.1'), 'v0.3.1');
  assert.equal(versionLabel('1.0'), 'v1.0');
  assert.equal(versionLabel('soon'), '');
});

test('the build is the pull request the commit came from: a squash title or a merge commit', () => {
  assert.equal(pullRequestOf('Give every trialog.dev page a favicon (#47)'), '47');
  assert.equal(pullRequestOf('Merge pull request #53 from zu-dritt/release/v0.2\n\nv0.2 into main'), '53');
  assert.equal(pullRequestOf('Split view: one room bar per pane'), '', 'no number: no build');
  assert.equal(pullRequestOf('Fix (#12) in the middle of a title'), '', 'only at the end');
});

test('the label under the message box says as much as is known', () => {
  assert.equal(buildLabel('v0.3', '51'), 'Trialog v0.3 · build 51');
  assert.equal(buildLabel('v0.3', ''), 'Trialog v0.3');
  assert.equal(buildLabel('', '51'), '', 'without a version, nothing');
});

test('package.json holds the version being built in the playground', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(versionLabel(pkg.version), 'v0.3');
});
