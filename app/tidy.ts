'use client';

// «✨ Tidy» under the message box (lib/tidy.ts, hub decision 1420): an AI model tidies the draft, the
// tidied text replaces it in the box, and «↩ Undo» brings the original back until you edit again.
// Nothing is sent: you read it, then press Send. Offered only when the hub has an API key.
import { useCallback, useEffect, useRef, useState } from 'react';

type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;

/** What the button offers now: tidy the draft, undo the last tidy, or nothing. */
export function tidyButton(draft: string, undo: { before: string; after: string } | null, busy: boolean): { label: string; action: 'tidy' | 'undo' } | null {
  if (busy) return { label: '✨ Tidying…', action: 'tidy' };
  if (undo && draft === undo.after) return { label: '↩ Undo tidy', action: 'undo' };
  return draft.trim() ? { label: '✨ Tidy', action: 'tidy' } : null;
}

export function useTidy(api: ApiFn | null, draft: string, setDraft: (text: string) => void) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  // The draft as it is now, so an answer for an older draft is dropped (Grok's nit on PR 154).
  const current = useRef(draft);
  current.current = draft;
  useEffect(() => {
    if (!api) return;
    let gone = false;
    api('/api/tidy').then((r) => r.json()).then((d: { available?: boolean }) => { if (!gone) setAvailable(Boolean(d.available)); }, () => {});
    return () => { gone = true; };
  }, [api]);
  const button = available ? tidyButton(draft, undo, busy) : null;
  const press = useCallback(async () => {
    if (!api || !button || busy) return;
    setError('');
    if (button.action === 'undo' && undo) { setDraft(undo.before); setUndo(null); return; }
    setBusy(true);
    try {
      const res = await api('/api/tidy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: draft }) });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok || typeof data.text !== 'string') { setError(data.error || `Tidy didn't work (HTTP ${res.status}). Your text is unchanged.`); return; }
      if (current.current !== draft) { setError('You changed the text while it was being tidied, so it stays as you wrote it. Press Tidy again.'); return; }
      setUndo({ before: draft, after: data.text });
      setDraft(data.text);
    } catch (e) {
      // The page's api() throws with the hub's own message on any error status.
      const said = e instanceof Error && e.message !== 'unauthorized' ? e.message : '';
      setError(`${said || 'Tidy didn\'t work.'} Your text is unchanged.`.replace('unchanged. Your text is unchanged.', 'unchanged.'));
    } finally { setBusy(false); }
  }, [api, button, busy, undo, draft, setDraft]);
  return { button, busy, error, press };
}
