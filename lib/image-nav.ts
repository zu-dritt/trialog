// Paging through a message's images in the full-size view (playground #1198).
// One image is unchanged: these helpers leave a single item where it is.

/** The index after a step of `delta`. Stops at the ends; a single image does not move. */
export function imageStep(index: number, count: number, delta: number): number {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(count - 1, index + delta));
}

/** The counter and whether each direction can still move. `at` is «2/4». */
export function imageNav(index: number, count: number): { at: string; prev: boolean; next: boolean } {
  const i = count <= 0 ? 0 : Math.max(0, Math.min(count - 1, index));
  return { at: `${i + 1}/${Math.max(1, count)}`, prev: i > 0, next: i < count - 1 };
}

/**
 * A swipe: right (positive dx) goes to the previous image, left to the next.
 * Below the threshold, nothing happens. The ends are the caller's to stop.
 */
export function swipeStep(fromX: number, toX: number, threshold = 50): -1 | 0 | 1 {
  const dx = toX - fromX;
  if (dx >= threshold) return -1;
  if (dx <= -threshold) return 1;
  return 0;
}

export type LightboxAction =
  | { type: 'close' }
  | { type: 'step'; index: number }
  | { type: 'focus'; index: number };

/**
 * Keys in the full-size view: Escape closes, ← → page when there is more than one image,
 * Tab stays inside the dialog (a wrap at the ends, so focus cannot leave).
 * `focusIndex` is -1 when focus is not on one of the dialog's controls.
 */
export function lightboxKey(
  e: { key: string; shiftKey?: boolean },
  state: { index: number; count: number; focusCount: number; focusIndex: number },
): LightboxAction | null {
  if (e.key === 'Escape') return { type: 'close' };
  if (e.key === 'ArrowLeft' && state.count > 1) return { type: 'step', index: imageStep(state.index, state.count, -1) };
  if (e.key === 'ArrowRight' && state.count > 1) return { type: 'step', index: imageStep(state.index, state.count, 1) };
  if (e.key === 'Tab' && state.focusCount > 0) {
    const n = state.focusCount;
    const i = state.focusIndex;
    if (e.shiftKey) {
      if (i <= 0) return { type: 'focus', index: n - 1 };
    } else if (i === n - 1 || i < 0) {
      return { type: 'focus', index: 0 };
    }
    return null; // in the middle, the browser moves focus as usual
  }
  return null;
}
