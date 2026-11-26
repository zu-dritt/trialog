// Learn by doing (app/tour.tsx): which real action completes which step, when the tour is offered,
// Skip and «Don't show again», what this browser keeps, and the markup of the panel. The ring
// around a control, the focus and the narrow layout need a real browser and are checked by hand
// (see the pull request).
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../lib/core';
import type { DecisionCard, Participant } from '../lib/shared';
import {
  NEW_TOUR, TOUR_STEPS, TourPanel, agreedBy, currentStep, findTarget, leadPane, hideTour, readTour, shouldOffer, skipStep, startTour, stepOf, stepText,
  toggleTour, tourKey, withEvent, writeTour, type Tour, type TourEvent, type TourState,
} from '../app/tour';

// Two people and two agents; the first person is shown as «Orchestrator».
const PARTICIPANTS = 'ana:human:Orchestrator,ben:human,scout:agent,quill:agent';
const TOKENS: Record<string, string> = {
  ana: 'ana-tour-token-0123456789abcdefgh',
  ben: 'ben-tour-token-0123456789abcdefgh',
  scout: 'scout-tour-token-0123456789abcdef',
  quill: 'quill-tour-token-0123456789abcdef',
};

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;
let participantsRoute: { GET: Handler };
let messagesRoute: { POST: Handler };
let reactionsRoute: { PUT: Handler };
let decisionsRoute: { POST: Handler };
let positionRoute: { PUT: Handler };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  for (const name of ['GROK_TOKEN', 'CLAUDE_TOKEN', 'DAVID_TOKEN']) delete process.env[name];
  process.env.PARTICIPANTS = PARTICIPANTS;
  for (const [name, token] of Object.entries(TOKENS)) process.env[`${name.toUpperCase()}_TOKEN`] = token;
  console.warn = () => {};
  participantsRoute = (await import('../app/api/participants/route')) as unknown as typeof participantsRoute;
  messagesRoute = (await import('../app/api/messages/route')) as unknown as typeof messagesRoute;
  reactionsRoute = (await import('../app/api/messages/[id]/reactions/[emoji]/route')) as unknown as typeof reactionsRoute;
  decisionsRoute = (await import('../app/api/decisions/route')) as unknown as typeof decisionsRoute;
  positionRoute = (await import('../app/api/decisions/[id]/route')) as unknown as typeof positionRoute;
});

const BASE = 'http://hub.test';
const json = (who: string) => ({ Authorization: `Bearer ${TOKENS[who]}`, 'Content-Type': 'application/json' });
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function storage(initial: Record<string, string> = {}) {
  const kept = new Map(Object.entries(initial));
  return { kept, getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } };
}

const ROSTER: Participant[] = [
  { name: 'ana', kind: 'human', color: 2, label: 'Orchestrator' },
  { name: 'ben', kind: 'human', color: 3 },
  { name: 'scout', kind: 'agent', color: 0 },
  { name: 'quill', kind: 'agent', color: 1 },
];
const open = (s: Partial<TourState> = {}): TourState => ({ ...startTour(NEW_TOUR), ...s });
const sent = (recipient: string | null, sender = 'ana'): TourEvent => ({ kind: 'sent', message: { sender, recipient } });

test('the steps are done by the real actions, as the server answers them', async () => {
  const roster = ((await (await participantsRoute.GET(new Request(`${BASE}/api/participants`, { headers: json('ana') }))).json()) as { participants: Participant[] }).participants;
  const post = async (text: string) => {
    const res = await messagesRoute.POST(new Request(`${BASE}/api/messages`, { method: 'POST', headers: json('ana'), body: JSON.stringify({ text }) }));
    assert.equal(res.status, 201, text);
    return ((await res.json()) as { message: Message }).message;
  };
  let tour = open();
  assert.equal(currentStep(tour)?.id, 'everyone');

  // A message to a person is a message, but not the «one agent» step.
  const toBen = await post('@ben hello');
  assert.equal(toBen.recipient, 'ben');
  tour = withEvent(tour, { kind: 'sent', message: toBen }, roster);
  assert.deepEqual(tour.done, []);
  assert.equal(tour.posted, true);

  const hello = await post('Hello, everyone');
  assert.equal(hello.recipient, null);
  tour = withEvent(tour, { kind: 'sent', message: hello }, roster);
  assert.deepEqual(tour.done, ['everyone']);
  assert.equal(currentStep(tour)?.id, 'address');

  // "@scout" at the start: the server makes scout the recipient, and that is the step.
  const toScout = await post('@scout what do you think?');
  assert.equal(toScout.recipient, 'scout');
  tour = withEvent(tour, { kind: 'sent', message: toScout }, roster);
  assert.deepEqual(tour.done, ['everyone', 'address']);
  assert.equal(tour.addressed, 'scout');

  // Quoting is done in the page only; the page reports it once the chip is made.
  tour = withEvent(tour, { kind: 'quoted' }, roster);

  const reacted = await reactionsRoute.PUT(new Request(`${BASE}/api/messages/${hello.id}/reactions/${encodeURIComponent('👍')}`, { method: 'PUT', headers: json('ana') }), params({ id: String(hello.id), emoji: encodeURIComponent('👍') }));
  assert.equal(reacted.status, 200);
  tour = withEvent(tour, { kind: 'reacted' }, roster);

  // A card an agent asks: the step is done when the person presses Agree on it, not before.
  type Card = DecisionCard;
  const decide = async (who: string) => {
    const res = await decisionsRoute.POST(new Request(`${BASE}/api/decisions`, { method: 'POST', headers: json(who), body: JSON.stringify({ prompt: `Ship the tour? (${who})` }) }));
    assert.equal(res.status, 201);
    return ((await res.json()) as { decision: Card }).decision;
  };
  const asked = await decide('scout');
  assert.equal(agreedBy(asked, 'ana'), false);
  const objected = await positionRoute.PUT(new Request(`${BASE}/api/decisions/${asked.id}`, { method: 'PUT', headers: json('ana'), body: JSON.stringify({ stance: 'object', note: 'Not yet.' }) }), params({ id: asked.id }));
  assert.equal(agreedBy(((await objected.json()) as { decision: Card }).decision, 'ana'), false, 'Object is not the step');
  const agreed = await positionRoute.PUT(new Request(`${BASE}/api/decisions/${asked.id}`, { method: 'PUT', headers: json('ana'), body: JSON.stringify({ stance: 'agree' }) }), params({ id: asked.id }));
  assert.equal(agreed.status, 200);
  assert.equal(agreedBy(((await agreed.json()) as { decision: Card }).decision, 'ana'), true);
  // A card the human asks holds their Agree from the start: making it is the step as well.
  assert.equal(agreedBy(await decide('ana'), 'ana'), true);
  tour = withEvent(tour, { kind: 'agreed' }, roster);
  assert.equal(currentStep(tour)?.id, 'room');

  tour = withEvent(tour, { kind: 'room' }, roster);
  assert.deepEqual(tour.done, ['everyone', 'address', 'quote', 'react', 'decide', 'room']);
  assert.equal(currentStep(tour), null, 'all six done: the recap');
});

test('actions count only while the tour is open, in any order, and once each', () => {
  let tour = withEvent(NEW_TOUR, sent(null), ROSTER);
  assert.deepEqual(tour.done, [], 'closed: nothing counts');
  assert.equal(tour.posted, true, 'but a sent message is remembered, so the tour is not offered after it');

  tour = open();
  tour = withEvent(tour, { kind: 'reacted' }, ROSTER);
  assert.deepEqual(tour.done, ['react'], 'a later step done first counts');
  assert.equal(currentStep(tour)?.id, 'everyone', 'and the first one is still the one to do');
  assert.equal(withEvent(tour, { kind: 'reacted' }, ROSTER), tour, 'done twice: nothing changes');
  assert.equal(stepOf(sent('ana'), ROSTER), null, 'a message to oneself is no step');
  assert.equal(stepOf(sent('nobody'), ROSTER), null);
});

test('Skip moves on, a skipped step done later counts as done, and the recap follows the last one', () => {
  let tour = open();
  tour = skipStep(tour);
  assert.deepEqual(tour.skipped, ['everyone']);
  assert.equal(currentStep(tour)?.id, 'address');
  tour = withEvent(tour, sent(null), ROSTER);
  assert.deepEqual(tour.skipped, []);
  assert.deepEqual(tour.done, ['everyone']);
  for (let i = 0; i < TOUR_STEPS.length; i++) tour = skipStep(tour);
  assert.equal(currentStep(tour), null);
  assert.equal(skipStep(tour), tour, 'nothing left to skip');
});

test('«Don\'t show again» ends the tour and it is not offered again; the «?» still opens it', () => {
  const ctx = { me: 'ana', roster: ROSTER, loaded: true, history: [] };
  assert.equal(shouldOffer(NEW_TOUR, ctx), true);
  const hidden = hideTour(open({ done: ['everyone'] }));
  assert.equal(hidden.open, false);
  assert.equal(hidden.hidden, true);
  assert.equal(shouldOffer(hidden, ctx), false);
  const back = toggleTour(hidden);
  assert.equal(back.open, true, 'the «?» opens it');
  assert.equal(back.hidden, false);
  assert.deepEqual(back.done, ['everyone'], 'where it stopped');
  assert.equal(toggleTour(back).open, false, 'and closes it again');
  const through = { ...open({ done: TOUR_STEPS.map((s) => s.id) }), open: false };
  assert.deepEqual(toggleTour(through).done, [], 'a tour that was through starts again');
});

test('the tour is offered once, to a human who has never posted, and never to an agent', () => {
  const ctx = { me: 'ana', roster: ROSTER, loaded: true, history: [{ sender: 'scout' }, { sender: 'hub' }] };
  assert.equal(shouldOffer(NEW_TOUR, ctx), true);
  assert.equal(shouldOffer(NEW_TOUR, { ...ctx, me: 'scout' }), false, 'an agent');
  assert.equal(shouldOffer(NEW_TOUR, { ...ctx, history: [{ sender: 'scout' }, { sender: 'ana' }] }), false, 'has posted: the page shows it');
  assert.equal(shouldOffer({ ...NEW_TOUR, posted: true }, ctx), false, 'has posted from this browser');
  assert.equal(shouldOffer({ ...NEW_TOUR, offered: true }, ctx), false, 'offered before');
  assert.equal(shouldOffer(NEW_TOUR, { ...ctx, loaded: false }), false, 'before the messages are in, the page can\'t tell');
  assert.equal(shouldOffer(NEW_TOUR, { ...ctx, me: null }), false);
  assert.equal(shouldOffer(NEW_TOUR, { ...ctx, me: 'mallory' }), false, 'not on the roster');
});

test('progress is kept per participant in this browser and survives a broken entry', () => {
  const s = storage();
  assert.deepEqual(readTour(s, 'ana'), NEW_TOUR);
  const tour = withEvent(open(), sent('scout'), ROSTER);
  writeTour(s, 'ana', tour);
  assert.deepEqual(readTour(s, 'ana'), tour);
  assert.deepEqual(readTour(s, 'ben'), NEW_TOUR, 'another participant at the same browser starts fresh');
  assert.equal([...s.kept.keys()].join(), tourKey('ana'));
  for (const junk of ['not json', '[]', 'null', '"x"', '{"open":"yes","done":["everyone","nope","everyone"],"addressed":7}']) {
    const read = readTour(storage({ [tourKey('ana')]: junk }), 'ana');
    assert.deepEqual(read, junk.includes('nope') ? { ...NEW_TOUR, done: ['everyone'] } : NEW_TOUR, junk);
  }
  const off = { getItem: () => { throw new Error('off'); }, setItem: () => { throw new Error('off'); } };
  assert.deepEqual(readTour(off, 'ana'), NEW_TOUR);
  assert.doesNotThrow(() => writeTour(off, 'ana', tour));
});

const noop = () => {};
const tourOf = (view: Tour['view'], state: TourState): Tour => ({ view, state, step: currentStep(state), start: noop, skip: noop, hide: noop, close: noop, toggle: noop, note: noop });
const panel = (tour: Tour) => renderToStaticMarkup(<TourPanel tour={tour} me="ana" participants={ROSTER} />);
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].replace('&#x27;', "'"));

test('the offer says «the human orchestrator»; every step shows Skip and «Don\'t show again»', () => {
  const offer = panel(tourOf('offer', NEW_TOUR));
  assert.match(offer, /the human orchestrator/);
  assert.deepEqual(buttons(offer), ['Start', "Don't show again"]);
  assert.equal(panel(tourOf(null, NEW_TOUR)), '', 'nothing to show: nothing on the page');

  let tour = open();
  for (const [i, step] of TOUR_STEPS.entries()) {
    const html = panel(tourOf('step', tour));
    assert.deepEqual(buttons(html), ['Skip', "Don't show again"], step.id);
    assert.match(html, new RegExp(`Step ${i + 1} of ${TOUR_STEPS.length}`));
    assert.ok(html.includes(stepText(step.id, 'scout')), step.id);
    tour = skipStep(tour);
  }
  assert.match(stepText('address', 'scout'), /@scout/, 'the «one agent» step names a real agent');
});

test('the recap shows what was done in the page\'s colours, with the label, who was woken and the explainer', () => {
  const tour = open({ done: ['everyone', 'address', 'quote', 'react', 'decide'], skipped: ['room'], addressed: 'scout' });
  const html = panel(tourOf('recap', tour));
  assert.match(html, /Done, Orchestrator\./, 'the label, not the name');
  assert.doesNotMatch(html, />Ana</);
  assert.match(html, /href="https:\/\/trialog\.dev"/);
  assert.deepEqual(buttons(html), ['Close', "Don't show again"]);
  // A message from a human wakes every agent (lib/shared.ts whoToWake), never a person.
  assert.match(html, /data-participant="scout" data-woken="yes"/);
  assert.match(html, /data-participant="quill" data-woken="yes"/);
  assert.match(html, /data-participant="ben" data-woken="no"/);
  assert.match(html, /Orchestrator → everyone · Scout, Quill woken/);
  assert.match(html, /stroke="#f0883e" stroke-width="3"/, 'the line to the addressed agent, in its colour, is the thick one');
  assert.match(html, /fill="#4fb3ff"/, 'the person\'s own dot in their colour');
  assert.match(html, /data-step="room" data-state="skipped"/);
  assert.match(html, /data-step="decide" data-state="done"/);

  // Nothing went to everyone: no path, and the rule instead of «woken».
  const skippedAll = panel(tourOf('recap', open({ skipped: TOUR_STEPS.map((s) => s.id) })));
  assert.doesNotMatch(skippedAll, /<line/);
  assert.doesNotMatch(skippedAll, />woken</);
  assert.match(skippedAll, /A message from Orchestrator to everyone wakes Scout, Quill\./);
});

test('with two rooms side by side, the tour points into the left pane only; the room tabs are the page\'s', () => {
  type Fake = { name: string; getClientRects: () => object[] };
  const el = (name: string, visible = true): Fake => ({ name, getClientRects: () => (visible ? [{}] : []) });
  const leftBox = el('left box');
  const rightBox = el('right box');
  const hiddenLeft = el('hidden', false);
  const tabs = el('tabs');
  const lists: Record<string, Fake[]> = { '[data-tour="box"]': [hiddenLeft, leftBox], '[data-tour="rooms"]': [] };
  const lead = { querySelector: () => null, querySelectorAll: (sel: string) => lists[sel] ?? [] };
  const page = {
    querySelector: (sel: string) => (sel === '[data-tour-pane="lead"]' ? lead : null),
    querySelectorAll: (sel: string) => ({ '[data-tour="box"]': [leftBox, rightBox], '[data-tour="rooms"]': [tabs] } as Record<string, Fake[]>)[sel] ?? [],
  };
  const find = (selectors: string[], root: unknown) => findTarget(selectors, root as ParentNode) as unknown as Fake | null;
  assert.equal(find(['[data-tour="box"]'], leadPane(page as unknown as ParentNode)), leftBox, 'the left pane\'s box, the visible one');
  assert.equal(find(['[data-tour="box"]'], page), rightBox, 'the whole page would have picked the right pane\'s');
  assert.equal(find(['[data-tour="rooms"]'], page), tabs);
  const noPanes = { querySelector: () => null };
  assert.equal(leadPane(noPanes as unknown as ParentNode), noPanes, 'no pane: the whole page');
  assert.deepEqual(TOUR_STEPS.filter((s) => s.scope === 'page').map((s) => s.id), ['room'], 'only the room tabs are outside the pane');
});
