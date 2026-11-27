'use client';

// Keyboard shortcuts, as in Gmail and X: step through messages without the mouse.
//   j / k   next (newer) / previous (older) message      r   reply to the selected message
//   n       to the message box                           /   to search
//   ?       this list                                    Esc close the list, then clear the selection
// They never fire while you type (in a text box, a field or anything editable), and never with
// Ctrl, ⌘ or Alt held, so the browser's own shortcuts keep working.
import { useEffect, useRef } from 'react';

export type ShortcutAction = 'next' | 'previous' | 'reply' | 'compose' | 'search' | 'help' | 'escape';

export const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'j', action: 'Next message (newer)' },
  { keys: 'k', action: 'Previous message (older)' },
  { keys: 'r', action: 'Reply to the selected message' },
  { keys: 'n', action: 'Write a message' },
  { keys: '/', action: 'Search' },
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
  switch (e.key) {
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

/** The «?» list. */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="false" aria-label="Keyboard shortcuts" onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="w-[min(26rem,100%)] rounded-xl border border-line bg-panel p-4 shadow-xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="m-0 text-base font-semibold">Keyboard shortcuts</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer rounded px-1.5 text-muted hover:text-fg">✕</button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys}>
                <td className="w-16 py-1 pr-3"><kbd className="rounded border border-line bg-[#2a2f3a] px-1.5 py-0.5 font-mono text-xs">{s.keys}</kbd></td>
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
