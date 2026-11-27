// The docs-only «Deploy your own» pass (hub #799): a tight checklist in README and
// docs/deploy.md, no Deploy Button, and no organisation names or ids in those guides.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../docs/deploy.md', import.meta.url), 'utf8');

const HEADING = 'Deploy your own: your accounts, your billing';

/** The section that starts at `heading` and runs to the next heading of the same or higher level. */
function section(src: string, heading: string): string {
  const match = src.match(new RegExp(`^(#{1,3}) ${heading}\\s*$`, 'm'));
  assert.ok(match && match.index !== undefined, `missing heading: ${heading}`);
  const start = match.index;
  const rest = src.slice(start + match[0].length);
  const next = rest.search(new RegExp(`^#{1,${match[1].length}} `, 'm'));
  return src.slice(start, start + match[0].length + (next < 0 ? rest.length : next));
}

test('README and docs/deploy.md both open with the same «your accounts, your billing» checklist', () => {
  for (const [name, text] of [['README', section(readme, HEADING)], ['deploy.md', section(deploy, HEADING)]] as const) {
    assert.match(text, /\*\*your\*\* GitHub/, `${name} names the visitor's GitHub`);
    assert.match(text, /\*\*Fork\*\* this repository/, `${name} starts with a fork of this repository`);
    assert.match(text, /`-pooler`/, `${name} asks for the pooled Neon URL`);
    assert.match(text, /your own Neon account/, `${name} uses the visitor's Neon`);
    assert.match(text, /your own Vercel account/, `${name} uses the visitor's Vercel`);
    assert.match(text, /openssl rand -hex 32/, `${name} generates tokens locally`);
    assert.match(text, /At least `DATABASE_URL` and a token per participant/, `${name} requires DATABASE_URL and a token`);
    assert.match(text, /`PARTICIPANTS` only if you want other names/, `${name} treats PARTICIPANTS as optional`);
    assert.match(text, /`TRIALOG_REPO` is \*your\* fork as `owner\/name`/, `${name} points TRIALOG_REPO at the visitor's fork`);
    assert.match(text, /Their billing is yours/, `${name} says billing stays with the visitor`);
    assert.match(text, /free Neon tier the database sleeps/, `${name} warns that a free Neon database sleeps`);
  }
});

test('this pass has no Deploy Button, and the guides name no organisation or project ids', () => {
  const guides: [string, string][] = [
    ['README «Run your own»', section(readme, 'Run your own')],
    ['deploy.md', deploy],
  ];
  for (const [name, text] of guides) {
    assert.doesNotMatch(text, /vercel\.com\/new\/clone/, `${name} has no Deploy Button`);
    assert.doesNotMatch(text, /\[Deploy with Vercel\]/i, `${name} has no Deploy Button label`);
    // Talk about "this repository" and "your fork". No hardcoded GitHub owner, no Vercel/Neon
    // team or project query, no deployment id.
    assert.doesNotMatch(text, /github\.com\/[A-Za-z0-9_.-]+/i, `${name} names no GitHub owner`);
    assert.doesNotMatch(text, /[?&](?:teamId|projectId|orgId|store(?:s)?Id)=/i, `${name} names no project or billing ids`);
    assert.doesNotMatch(text, /\bdpl_[A-Za-z0-9]+\b/, `${name} names no deployment id`);
  }
  assert.doesNotMatch(readme, /vercel\.com\/new\/clone/, 'README has no Deploy Button');
});
