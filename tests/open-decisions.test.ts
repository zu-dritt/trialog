import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  canRecordDecisionPosition, decisionShouldMarkAgreed, openDecisionChipLabel, openDecisionsFor,
  promptPreview, waitingOnMe, type DecisionListing,
} from '../lib/open-decisions';
import type { DecisionCard, Participant } from '../lib/shared';

const P: Participant[] = [
  { name: 'grok', kind: 'agent', color: 0 },
  { name: 'claude', kind: 'agent', color: 1 },
  { name: 'david', kind: 'human', color: 2 },
];
const ROSTER = P.map((p) => p.name);

const card = (over: Partial<DecisionCard> = {}): DecisionCard => ({
  id: 'decision_1',
  message_id: 10,
  creator: 'grok',
  prompt: 'Ship the chip?',
  created_at: 't',
  agreed_at: null,
  positions: [],
  ...over,
});

const listing = (over: Partial<DecisionListing> & { decision?: DecisionCard } = {}): DecisionListing => ({
  decision: over.decision ?? card(),
  recipient: over.recipient === undefined ? 'david' : over.recipient,
  room: over.room ?? 'main',
});

test('canRecordDecisionPosition: only the addressed human may answer a human-addressed card', () => {
  assert.equal(canRecordDecisionPosition('david', 'david', P), true);
  assert.equal(canRecordDecisionPosition('claude', 'david', P), false);
  assert.equal(canRecordDecisionPosition('grok', 'david', P), false);
  assert.equal(canRecordDecisionPosition('claude', null, P), true, 'everyone: any participant may take a stance');
  assert.equal(canRecordDecisionPosition('david', 'claude', P), true, 'addressed to an agent: unchanged');
  assert.equal(canRecordDecisionPosition('claude', 'claude', P), true);
});

test('decisionShouldMarkAgreed: a human-addressed card is agreed once that human agrees', () => {
  const agreedByDavid = card({ positions: [{ participant: 'david', stance: 'agree', note: null, updated_at: 't' }] });
  assert.equal(decisionShouldMarkAgreed(agreedByDavid, ROSTER, 'david', P), true);
  assert.equal(decisionShouldMarkAgreed(agreedByDavid, ROSTER, null, P), false, 'to everyone still needs every participant');
  assert.equal(decisionShouldMarkAgreed(card(), ROSTER, 'david', P), false);
  const objected = card({ positions: [{ participant: 'david', stance: 'object', note: 'No', updated_at: 't' }] });
  assert.equal(decisionShouldMarkAgreed(objected, ROSTER, 'david', P), false);
});

test('waitingOnMe and the chip label: it goes once the person has answered', () => {
  assert.equal(waitingOnMe(listing({ recipient: 'david' }), 'david'), true);
  assert.equal(waitingOnMe(listing({ recipient: null }), 'david'), true);
  assert.equal(waitingOnMe(listing({ recipient: 'claude' }), 'david'), false, 'addressed to someone else');
  assert.equal(waitingOnMe(listing({ decision: card({ agreed_at: 't' }), recipient: 'david' }), 'david'), false);
  const answered = listing({
    decision: card({ positions: [{ participant: 'david', stance: 'agree', note: null, updated_at: 't' }] }),
    recipient: 'david',
  });
  assert.equal(waitingOnMe(answered, 'david'), false);
  assert.equal(waitingOnMe(listing({ recipient: 'david' }), 'claude'), false, "not waiting on Claude: it isn't addressed to him and he is not 'everyone'");
  const open = openDecisionsFor([
    listing({ decision: card({ id: 'decision_1' }), recipient: 'david' }),
    listing({ decision: card({ id: 'decision_2', prompt: 'Two?' }), recipient: null }),
    listing({ decision: card({ id: 'decision_3' }), recipient: 'claude' }),
  ], 'david');
  assert.deepEqual(open.map((i) => i.decision.id), ['decision_1', 'decision_2']);
  assert.equal(openDecisionChipLabel(1), '🗳 1 decision');
  assert.equal(openDecisionChipLabel(2), '🗳 2 decisions');
  assert.equal(promptPreview('Ship the chip?\nMore detail'), 'Ship the chip?');
});
