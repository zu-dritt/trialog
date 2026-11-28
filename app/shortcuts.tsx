'use client';

// Keyboard shortcuts, as in Gmail and X: step through messages without the mouse.
//   j / k   next (newer) / previous (older) message      r   reply to the selected message
//   n       to the message box                           /   to search
//   ?       this list                                    Esc close the list, then clear the selection
//   g 966 ↵ go to message #966, in whichever room it is (playground #970)
// They never fire while you type (in a text box, a field or anything editable), and never with
// Ctrl, ⌘ or Alt held, so the browser's own shortcuts keep working.
import { useEffect, useRef, useState } from 'react';

export type ShortcutAction = 'next' | 'previous' | 'reply' | 'compose' | 'search' | 'help' | 'escape';

export const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'j', action: 'Next message (newer)' },
  { keys: 'k', action: 'Previous message (older)' },
  { keys: 'r', action: 'Reply to the selected message' },
  { keys: 'n', action: 'Write a message' },
  { keys: '/', action: 'Search' },
  { keys: 'g 966 ↵', action: 'Go to message #966' },
  { keys: '?', action: 'Show these shortcuts' },
  { keys: 'Esc', action: 'Close this list, then clear the selection' },
];

interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target?: EventTarget | null; isComposing?: boolean }

/** Whether the key press happens while typing somewhere: then it belongs to the text, not to us. */
export function typing(target: EventTarget | null | undefined): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select' || el.isContentEditable) return true;
  if (tag === 'input') return !['checkbox', 'radio', 'button', 'submit', 'range'].includes((el.type ?? 'text').toLowerCase());
  return false;
}

/** The action for a key press, or null when it isn't ours. Esc is ours even while typing nowhere. */
export function shortcutFor(e: KeyLike): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
  if (typing(e.target)) return null;
  // Caps Lock or Shift gives «J»: the same key (Grok's nit on PR 79). «?» is Shift+/ and stays itself.
  switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
    case 'j': return 'next';
    case 'k': return 'previous';
    case 'r': return 'reply';
    case 'n': return 'compose';
    case '/': return 'search';
    case '?': return 'help';
    case 'Escape': return 'escape';
    default: return null;
  }
}

/**
 * The message to select after j or k. `ids` are the messages in the order shown (oldest first).
 * With nothing selected yet, both start at the newest, where the eyes are.
 */
export function stepTo(ids: readonly number[], current: number | null, action: 'next' | 'previous'): number | null {
  if (!ids.length) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return ids[ids.length - 1];
  const next = action === 'next' ? at + 1 : at - 1;
  return ids[Math.max(0, Math.min(ids.length - 1, next))];
}

/** Listens on the page while `enabled`; the handler gets the action and may say it handled it. */
export function useShortcuts(enabled: boolean, handle: (action: ShortcutAction) => boolean) {
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (action && handleRef.current(action)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/**
 * «g», then the number, then Enter: go to that message (playground #970). `digits` is null when no
 * «g» is pending. Backspace takes a digit back; Esc, or any other key, gives up.
 */
export const GO_TO_MAX_DIGITS = 7;
export function goToStep(digits: string | null, e: KeyLike): { digits: string | null; go?: number; handled: boolean } {
  if (digits === null) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || typing(e.target)) return { digits: null, handled: false };
    return e.key === 'g' || e.key === 'G' ? { digits: '', handled: true } : { digits: null, handled: false };
  }
  if (/^\d$/.test(e.key)) return { digits: digits.length < GO_TO_MAX_DIGITS ? digits + e.key : digits, handled: true };
  if (e.key === 'Backspace') return { digits: digits.slice(0, -1), handled: true };
  if (e.key === 'Enter') {
    const id = Number(digits);
    return digits && id > 0 ? { digits: null, go: id, handled: true } : { digits: null, handled: true };
  }
  if (e.key === 'Escape') return { digits: null, handled: true };
  if (e.key === 'Shift') return { digits, handled: false };
  return { digits: null, handled: false };
}

/** How long a «g» waits for its number before it gives up. */
export const GO_TO_TIMEOUT_MS = 6000;

/**
 * Listens for «g 966 ↵» on the page. Its listener runs before the others (capture), so while a
 * number is being typed, Esc and the digits don't also reach j/k/Esc of the panes. Returns the digits
 * typed so far (null: nothing pending), for a small hint on screen.
 */
export function useGoTo(enabled: boolean, onGo: (id: number) => void): string | null {
  const [digits, setDigits] = useState<string | null>(null);
  const state = useRef<string | null>(null);
  const goRef = useRef(onGo);
  goRef.current = onGo;
  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const set = (d: string | null) => {
      state.current = d;
      setDigits(d);
      clearTimeout(timer);
      if (d !== null) timer = setTimeout(() => set(null), GO_TO_TIMEOUT_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      const step = goToStep(state.current, e);
      if (step.digits !== state.current) set(step.digits);
      if (step.handled) { e.preventDefault(); e.stopImmediatePropagation(); }
      if (step.go !== undefined) goRef.current(step.go);
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); clearTimeout(timer); };
  }, [enabled]);
  return digits;
}

/** The hint while a «g» waits for its number. */
export function GoToHint({ digits }: { digits: string | null }) {
  if (digits === null) return null;
  return (
    <div role="status" data-go-to className="pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-panel px-3 py-1.5 font-mono text-sm shadow-lg">
      Go to #{digits}<span className="animate-pulse">▍</span> <span className="font-sans text-xs text-muted">↵ to go · Esc to cancel</span>
    </div>
  );
}

/** The «?» list. */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  // A real dialog (Grok's nits on PR 79): focus moves into it and stays there, and Esc closes it
  // even while the message box has focus, where the page's shortcuts don't listen.
  const close = useRef<HTMLButtonElement>(null);
  const before = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    before.current = document.activeElement;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      else if (e.key === 'Tab') { e.preventDefault(); close.current?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      (before.current as HTMLElement | null)?.focus?.();
    };
  }, []);
  return (
    <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="w-[min(26rem,100%)] rounded-xl border border-line bg-panel p-4 shadow-xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="m-0 text-base font-semibold">Keyboard shortcuts</h2>
          <button ref={close} type="button" onClick={onClose} aria-label="Close" className="cursor-pointer rounded px-1.5 text-muted hover:text-fg">✕</button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys}>
                <td className="w-20 whitespace-nowrap py-1 pr-3"><kbd className="rounded border border-line bg-[#2a2f3a] px-1.5 py-0.5 font-mono text-xs">{s.keys}</kbd></td>
                <td className="py-1">{s.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="m-0 mt-2 text-xs text-muted">They don't fire while you type in a box.</p>
      </div>
    </div>
  );
}
