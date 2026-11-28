'use client';

// Dictation in the iPhone app (playground #1178/#1179): a «Speak» button next to «Image». The app
// listens with Apple's speech recognition, on the phone itself where the phone can (no cost either
// way) and sends the words back as you speak; they land in the message box, and you read them
// before Send. Only inside the app: a browser has no such bridge, so the button isn't there.
import { useCallback, useEffect, useRef, useState } from 'react';

/** What the app offers the page (ios/Trialog/HubView.swift, the «trialog» message handler). */
export interface NativeBridge { postMessage(message: unknown): void }

type WebkitWindow = { webkit?: { messageHandlers?: { trialog?: NativeBridge } }; trialogDictation?: DictationCallback };
/** The app calls this with everything heard so far; `final` when it stopped (or `error` when it couldn't). */
export type DictationCallback = (text: string, final: boolean, error?: string) => void;

export function nativeBridge(w: unknown = typeof window === 'undefined' ? undefined : window): NativeBridge | null {
  return (w as WebkitWindow | undefined)?.webkit?.messageHandlers?.trialog ?? null;
}

/** Each word once (ignoring case), empty ones dropped: «Grok» and «grok» are one hint. */
export function uniqueWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  return words.map((w) => w.trim()).filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
}

/** The draft with the spoken words after what was there when you started: one space between. */
export function withSpoken(before: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return before;
  if (!before) return said;
  return /\s$/.test(before) ? before + said : `${before} ${said}`;
}

/**
 * `available` only inside the app. `toggle` starts or stops listening; while listening, every update
 * of the words calls `onText` with the whole draft (what was there + what was said so far).
 */
export function useDictation(draft: string, onText: (draft: string) => void, hints: readonly string[] = []): { available: boolean; listening: boolean; error: string; toggle: () => void } {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const before = useRef('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const hintsRef = useRef(hints);
  hintsRef.current = hints;

  useEffect(() => {
    if (!nativeBridge()) return undefined;
    setAvailable(true);
    const w = window as unknown as WebkitWindow;
    w.trialogDictation = (text, final, problem) => {
      if (problem) { setError(problem); setListening(false); return; }
      onTextRef.current(withSpoken(before.current, text));
      if (final) setListening(false);
    };
    return () => { delete w.trialogDictation; };
  }, []);

  const toggle = useCallback(() => {
    const bridge = nativeBridge();
    if (!bridge) return;
    setError('');
    if (listening) {
      bridge.postMessage({ type: 'dictate', action: 'stop' });
      setListening(false);
    } else {
      before.current = draftRef.current;
      // The team's names as hints, so the phone hears «Grok», not «crack» (playground #1455).
      bridge.postMessage({ type: 'dictate', action: 'start', words: uniqueWords(hintsRef.current).slice(0, 30) });
      setListening(true);
    }
  }, [listening]);

  return { available, listening, error, toggle };
}
