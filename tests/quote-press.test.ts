// Pressing the Quote button that appears under a selection. The press and its click are two
// events, and a browser may drop the selection between them: a tap on a phone or tablet does,
// and delivers the click a moment after the finger has left. The button must still be there when
// the click arrives. A real tap needs a real device; what is checked here is the rule the page
// follows, and by hand the same sequence of events in a browser (see the pull request).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MAX_QUOTES, PRESS_GRACE_MS, createPressHold, isQuoteButton, quoteNotice } from '../app/quote';

/** The page's watcher in small: it shows the button while there is a selection, unless it is told to hold. */
function watcher(graceMs = PRESS_GRACE_MS) {
  let time = 0;
  const hold = createPressHold(graceMs, () => time);
  const page = { selection: 'some words' as string | null, button: true, quoted: [] as string[], picked: 'some words' as string | null };
  return {
    page,
    hold,
    /** What the page does on the next frame after something changed: look at the selection. */
    frame() {
      if (hold.holding()) return;
      page.picked = page.selection;
      page.button = page.selection !== null;
    },
    /** A click is delivered to the button, if it is still there. */
    click() {
      if (!page.button || page.picked === null) return false;
      page.quoted.push(page.picked);
      hold.done();
      page.selection = null;
      page.picked = null;
      page.button = false;
      return true;
    },
    wait(ms: number) { time += ms; },
  };
}

test('a tap: the selection goes when the finger lands, the click comes later, and the quote is still made', () => {
  const w = watcher();
  w.hold.press(); // the finger goes down on the Quote button
  w.page.selection = null; // the browser drops the selection
  w.frame();
  w.hold.release(); // the finger leaves
  w.frame();
  w.wait(120); // the click is on its way
  w.frame();
  assert.equal(w.page.button, true, 'the button is still there for the click');
  assert.equal(w.click(), true);
  assert.deepEqual(w.page.quoted, ['some words'], 'what was selected when the button appeared');
  w.frame();
  assert.equal(w.page.button, false, 'and then it goes');
});

test('without the hold, the same tap finds no button (this is what went wrong)', () => {
  const w = watcher();
  // The page as it was: it looked at the selection on the frame after the finger left.
  w.page.selection = null;
  w.page.picked = w.page.selection;
  w.page.button = false;
  w.wait(120);
  assert.equal(w.click(), false, 'the click lands on nothing');
  assert.deepEqual(w.page.quoted, []);
});

test('a mouse click: press, release and click in one go', () => {
  const w = watcher();
  w.hold.press();
  w.hold.release();
  assert.equal(w.click(), true);
  assert.equal(w.hold.holding(), false, 'handled: nothing is held any more');
});

test('a press that never becomes a click lets go after the wait', () => {
  const w = watcher();
  w.hold.press();
  w.page.selection = null;
  w.wait(5000);
  w.frame();
  assert.equal(w.page.button, true, 'held for as long as the finger is down');
  w.hold.release(); // moved off the button and lifted: no click follows
  w.wait(PRESS_GRACE_MS - 1);
  w.frame();
  assert.equal(w.page.button, true, 'still waiting for a click');
  w.wait(1);
  w.frame();
  assert.equal(w.page.button, false, 'no click came: the button follows the selection again');
  assert.equal(w.hold.holding(), false);
});

test('only a press on the Quote button holds anything', () => {
  const hold = createPressHold(PRESS_GRACE_MS, () => 0);
  assert.equal(hold.holding(), false);
  // A release without a press, as after selecting text with a drag, starts no wait.
  hold.release();
  assert.equal(hold.holding(), false);
  hold.press();
  assert.equal(hold.pressed(), true);
  assert.equal(hold.holding(), true);
  hold.done();
  assert.equal(hold.holding(), false);
  assert.equal(PRESS_GRACE_MS, 800);

  const button = { closest: (selector: string) => (selector === '[data-quote-selection]' ? button : null) };
  const inside = { closest: (selector: string) => (selector === '[data-quote-selection]' ? button : null) };
  const elsewhere = { closest: () => null };
  assert.equal(isQuoteButton(button), true);
  assert.equal(isQuoteButton(inside), true);
  assert.equal(isQuoteButton(elsewhere), false);
  for (const nothing of [null, undefined, {}, 'text']) assert.equal(isQuoteButton(nothing), false);
});

test('a quote that is not added says why', () => {
  assert.equal(quoteNotice(null), '');
  assert.equal(quoteNotice('full'), `A message can carry at most ${MAX_QUOTES} quotes.`);
  // The same selection quoted twice: without a word, the second click looks like a button that does nothing.
  assert.equal(quoteNotice('duplicate'), 'That quote is already attached to your message.');
});
