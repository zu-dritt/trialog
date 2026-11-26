// A participant's label (PARTICIPANTS=david:human:Orchestrator) is what the page shows wherever it
// showed the name. The name stays the id: it is never shown instead of the label, and a name
// without a label is shown with a capital as before.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionCardView } from '../app/decisions';
import { PollCard } from '../app/polls';
import { ReactionBar } from '../app/reactions';
import { ReadReceipts, UnseenFlag } from '../app/reads';
import { SearchResults } from '../app/search';
import { StatusList } from '../app/status';
import { WakeTargetsLine } from '../app/wakes';
import type { Message } from '../lib/core';
import { UNSEEN_AFTER_MS, joinNames, labelOf, type DecisionCard, type Participant, type Poll } from '../lib/shared';

const ROSTER: Participant[] = [
  { name: 'grok', kind: 'agent', color: 0, label: 'Grok' },
  { name: 'claude', kind: 'agent', color: 1, label: 'Claude' },
  { name: 'david', kind: 'human', color: 2, label: 'Orchestrator' },
];
const AT = '2026-11-26T09:00:00.000Z';
const message = (over: Partial<Message> = {}): Message => ({
  id: 12, sender: 'david', recipient: null, text: 'Please both look at this.', created_at: AT, pinned_at: null, room: 'main',
  attachments: [], reply_to: null, poll: null, reactions: [], ...over,
});
/** The visible text of some markup, without tags. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');
const noName = (html: string, where: string) => assert.doesNotMatch(text(html), /\bDavid\b/, `${where}: the name is not shown instead of the label`);

test('labelOf: the label, else the name with a capital, also for someone who is no longer listed', () => {
  assert.equal(labelOf('david', ROSTER), 'Orchestrator');
  assert.equal(labelOf('grok', ROSTER), 'Grok');
  assert.equal(labelOf('ana-maria', ROSTER), 'Ana-Maria', 'a former participant');
  assert.equal(labelOf('david', [{ name: 'david' }]), 'David', 'an answer from a server without labels');
  assert.equal(joinNames(['grok', 'david'], ROSTER), 'Grok and Orchestrator');
});

test('the page shows the label wherever it showed the name', () => {
  const poll: Poll = {
    id: 'poll_aaaabbbbccccddddeeeeffff', message_id: 12, creator: 'david', question: 'Lunch?', closed_at: null, created_at: AT,
    options: [{ index: 1, text: 'Pizza', votes: 1, voters: ['david'] }, { index: 2, text: 'Salad', votes: 1, voters: ['grok'] }],
  };
  const pollHtml = renderToStaticMarkup(<PollCard poll={poll} me="grok" participants={ROSTER} />);
  assert.match(text(pollHtml), /Orchestrator/, 'poll votes');
  noName(pollHtml, 'poll votes');

  const card: DecisionCard = {
    id: 'decision_aaaabbbbccccdddd', message_id: 12, creator: 'claude', prompt: 'Ship it?', created_at: AT, agreed_at: null,
    positions: [{ participant: 'david', stance: 'agree', note: null, updated_at: AT }],
  };
  const cardHtml = renderToStaticMarkup(<DecisionCardView card={card} me="grok" participants={ROSTER} />);
  assert.match(text(cardHtml), /Orchestrator/, 'decision card');
  noName(cardHtml, 'decision card');

  const reacted = message({ reactions: [{ emoji: '👍', by: ['david', 'grok'] }] });
  const reactionHtml = renderToStaticMarkup(<ReactionBar message={reacted} me="claude" participants={ROSTER} onToggle={() => {}} />);
  assert.match(reactionHtml, /aria-label="👍, 2, Orchestrator, Grok"/, 'reactions, as read aloud');
  assert.match(reactionHtml, /title="Orchestrator, Grok"/, 'reactions, on hover');

  const readHtml = renderToStaticMarkup(<ReadReceipts messageId={12} reads={[{ participant: 'david', room: 'main', up_to: 12, updated_at: AT }]} participants={ROSTER} me="grok" />);
  assert.match(readHtml, /Orchestrator has read up to here/, 'read markers');
  noName(readHtml, 'read markers');

  const late = Date.parse(AT) + UNSEEN_AFTER_MS + 1000;
  const unseenHtml = renderToStaticMarkup(<UnseenFlag message={message({ sender: 'grok', recipient: 'claude' })} reads={[]} participants={[...ROSTER.slice(0, 1), { ...ROSTER[1], label: 'Reviewer' }, ROSTER[2]]} now={late} />);
  assert.match(text(unseenHtml), /not seen by Reviewer yet/, 'the «not seen yet» flag');

  const statusHtml = renderToStaticMarkup(<StatusList statuses={[{ participant: 'david', text: 'reviewing', expires_at: '2026-11-26T10:00:00.000Z', updated_at: AT }]} now={Date.parse(AT)} participants={ROSTER} />);
  assert.match(text(statusHtml), /Orchestrator:/, 'the status line');
  noName(statusHtml, 'the status line');

  const wakeHtml = renderToStaticMarkup(<WakeTargetsLine me="david" participants={ROSTER.map((p) => ({ ...p, wake_target_host: p.name === 'grok' ? 'grok.example' : null, wake_target_set_at: null }))} />);
  assert.match(text(wakeHtml), /Grok \(grok\.example\)/, 'the «Wake-ups:» line');

  const searchHtml = renderToStaticMarkup(<SearchResults listId="s" results={[message()]} words={['look']} active={0} onPick={() => {}} participants={ROSTER} />);
  assert.match(text(searchHtml), /Orchestrator/, 'a search result');
  noName(searchHtml, 'a search result');
});
