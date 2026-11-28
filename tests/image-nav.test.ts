import { test } from 'vitest';
import assert from 'node:assert/strict';
import { imageNav, imageStep, lightboxKey, swipeStep } from '../lib/image-nav';

test('imageStep stops at the ends and does not move a single image', () => {
  assert.equal(imageStep(0, 1, 1), 0);
  assert.equal(imageStep(0, 1, -1), 0);
  assert.equal(imageStep(0, 4, -1), 0);
  assert.equal(imageStep(0, 4, 1), 1);
  assert.equal(imageStep(2, 4, 1), 3);
  assert.equal(imageStep(3, 4, 1), 3);
  assert.equal(imageStep(3, 4, -1), 2);
});

test('imageNav writes «2/4» and says which way is still open', () => {
  assert.deepEqual(imageNav(0, 1), { at: '1/1', prev: false, next: false });
  assert.deepEqual(imageNav(0, 4), { at: '1/4', prev: false, next: true });
  assert.deepEqual(imageNav(1, 4), { at: '2/4', prev: true, next: true });
  assert.deepEqual(imageNav(3, 4), { at: '4/4', prev: true, next: false });
});

test('a swipe goes previous when it is to the right, next when it is to the left', () => {
  assert.equal(swipeStep(100, 160), -1);
  assert.equal(swipeStep(100, 40), 1);
  assert.equal(swipeStep(100, 120), 0);
  assert.equal(swipeStep(100, 80), 0);
  assert.equal(swipeStep(0, 50), -1);
  assert.equal(swipeStep(50, 0), 1);
});

test('lightboxKey: Escape closes, arrows page, Tab stays in the dialog', () => {
  const many = { index: 1, count: 4, focusCount: 4, focusIndex: 1 };
  assert.deepEqual(lightboxKey({ key: 'Escape' }, many), { type: 'close' });
  assert.deepEqual(lightboxKey({ key: 'ArrowLeft' }, many), { type: 'step', index: 0 });
  assert.deepEqual(lightboxKey({ key: 'ArrowRight' }, many), { type: 'step', index: 2 });
  assert.deepEqual(lightboxKey({ key: 'ArrowLeft' }, { ...many, index: 0 }), { type: 'step', index: 0 });
  assert.deepEqual(lightboxKey({ key: 'ArrowRight' }, { ...many, index: 3 }), { type: 'step', index: 3 });
  assert.equal(lightboxKey({ key: 'ArrowRight' }, { index: 0, count: 1, focusCount: 2, focusIndex: 0 }), null);
  assert.deepEqual(lightboxKey({ key: 'Tab' }, { ...many, focusIndex: 3 }), { type: 'focus', index: 0 });
  assert.deepEqual(lightboxKey({ key: 'Tab', shiftKey: true }, { ...many, focusIndex: 0 }), { type: 'focus', index: 3 });
  assert.equal(lightboxKey({ key: 'Tab' }, many), null, 'in the middle the browser moves focus');
  assert.deepEqual(lightboxKey({ key: 'Tab' }, { ...many, focusIndex: -1 }), { type: 'focus', index: 0 });
});
