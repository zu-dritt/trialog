import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpenDecisionChip } from '../app/open-decisions';
import { ComposerTools } from '../app/composer';
import type { DecisionListing } from '../lib/open-decisions';
import type { DecisionCard as Card } from '../lib/shared';

const card = (id: string, prompt: string, over: Partial<Card> = {}): Card => ({
  id, message_id: Number(id.replace(/\D/g, '') || 1), creator: 'grok', prompt, created_at: 't', agreed_at: null, positions: [], ...over,
});
const item = (id: string, prompt: string, recipient: string | null = 'david'): DecisionListing => ({
  decision: card(id, prompt), recipient, room: 'main',
});

test('the chip is absent when nothing is waiting, and names the count when something is', () => {
  const answered: DecisionListing = {
    decision: card('decision_1', 'Done?', { positions: [{ participant: 'david', stance: 'agree', note: null, updated_at: 't' }] }),
    recipient: 'david',
    room: 'main',
  };
  assert.equal(renderToStaticMarkup(<OpenDecisionChip listings={[answered]} me="david" onJump={() => {}} onAgree={() => {}} />), '');
  const html = renderToStaticMarkup(<OpenDecisionChip listings={[item('decision_1', 'Ship the chip?')]} me="david" onJump={() => {}} onAgree={() => {}} />);
  assert.match(html, /data-open-decisions="1"/);
  assert.match(html, /aria-label="1 decision waiting on you"/);
  assert.match(html, /🗳 1 decision/);
  const two = renderToStaticMarkup(<OpenDecisionChip listings={[item('decision_1', 'One?'), item('decision_2', 'Two?', null)]} me="david" onJump={() => {}} onAgree={() => {}} />);
  assert.match(two, /data-open-decisions="2"/);
  assert.match(two, /🗳 2 decisions/);
});

test('in the message box row the chip sits after the health slot, before Send', () => {
  const props = {
    to: '', onTo: () => {}, recipients: [], emoji: { open: false, onOpenChange: () => {}, onInsert: () => {}, boxRef: { current: null } },
    image: { disabled: false, onPick: () => {} }, decision: { open: false, onToggle: () => {} }, poll: { open: false, onToggle: () => {} },
    expand: { expanded: false, onToggle: () => {} }, send: { disabled: false, label: 'Send' }, fieldClassName: 'f', toolClassName: 't',
  };
  const chip = <OpenDecisionChip listings={[item('decision_1', 'Ship the chip?')]} me="david" onJump={() => {}} onAgree={() => {}} />;
  const row = renderToStaticMarkup(<ComposerTools {...props} guard={<i data-guard="" />} health={<i data-health="claude" />} openDecisions={chip} />);
  const guardAt = row.indexOf('data-guard');
  const healthAt = row.indexOf('data-health="claude"');
  const chipAt = row.indexOf('data-open-decisions="1"');
  const sendAt = row.indexOf('>Send<');
  assert.ok(guardAt < healthAt && healthAt < chipAt && chipAt < sendAt, row);
  assert.doesNotMatch(row, />Enter sends/);
});
