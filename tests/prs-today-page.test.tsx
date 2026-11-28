// The «PRs today: n/100» chip on the page: its label, where it sits, and that it hides without a count.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerTools } from '../app/composer';
import { PrsTodayChip } from '../app/prs-today';

test('the chip says «PRs today: 28/100», and a count of zero still shows', () => {
  const html = renderToStaticMarkup(<PrsTodayChip count={28} />);
  assert.match(html, /data-prs-today="28"/);
  assert.match(html, /PRs today: 28\/100/);
  assert.match(html, /aria-label="PRs today: 28\/100"/);
  assert.match(html, /midnight Europe\/Zurich/);
  assert.equal(renderToStaticMarkup(<PrsTodayChip count={0} />).includes('PRs today: 0/100'), true, 'zero is a real count and stays visible');
});

test('in the message box row the chip sits after the health and decision chips, before Send', () => {
  const props = {
    to: '', onTo: () => {}, recipients: [], emoji: { open: false, onOpenChange: () => {}, onInsert: () => {}, boxRef: { current: null } },
    image: { disabled: false, onPick: () => {} }, decision: { open: false, onToggle: () => {} }, poll: { open: false, onToggle: () => {} },
    expand: { expanded: false, onToggle: () => {} }, send: { disabled: false, label: 'Send' }, fieldClassName: 'f', toolClassName: 't',
  };
  const row = renderToStaticMarkup(
    <ComposerTools
      {...props}
      guard={<i data-guard="" />}
      health={<i data-health="claude" />}
      openDecisions={<i data-open-decisions="1" />}
      prsToday={<PrsTodayChip count={28} />}
    />,
  );
  const guardAt = row.indexOf('data-guard');
  const healthAt = row.indexOf('data-health="claude"');
  const decisionsAt = row.indexOf('data-open-decisions="1"');
  const chipAt = row.indexOf('data-prs-today="28"');
  const sendAt = row.indexOf('>Send<');
  assert.ok(guardAt < healthAt && healthAt < decisionsAt && decisionsAt < chipAt && chipAt < sendAt, row);
  assert.doesNotMatch(row, />Enter sends/);
  const plain = renderToStaticMarkup(<ComposerTools {...props} />);
  assert.match(plain, />Enter sends · Shift\+Enter for a new line</);
  const onlyChip = renderToStaticMarkup(<ComposerTools {...props} prsToday={<PrsTodayChip count={28} />} />);
  assert.doesNotMatch(onlyChip, />Enter sends/);
});
