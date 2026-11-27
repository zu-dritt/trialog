'use client';

// /roadmap: the interactive roadmap. It uses the token the hub page saved in this browser; without
// one it sends the reader to the hub to sign in first. It reads the cards every 20 seconds, so it
// stays current while it is open next to the hub.
import { useCallback, useEffect, useState } from 'react';
import { RoadmapBoard, columnOf, placeAt } from '../roadmap-board';
import type { RoadmapColumn, RoadmapItem } from '../../lib/roadmap';
import type { Attachment, Participant } from '../../lib/shared';
import { uploadRequest, useImageLoader } from '../attachments';
import { FlightBar } from '../flight';
import type { NewIdea } from '../compose-idea';

const TOKEN_KEY = 'collabHubToken';
const POLL_MS = 20_000;

export default function RoadmapPage() {
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<RoadmapItem[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<string | null>(null);

  useEffect(() => { setToken(localStorage.getItem(TOKEN_KEY) || ''); document.title = 'Trialog Roadmap'; }, []);

  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(path, { ...init, cache: 'no-store', headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    if (res.status === 401) { setToken(''); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  }, [token]);

  const load = useCallback(async () => {
    try {
      setItems(((await api('/api/roadmap')) as { items: RoadmapItem[] }).items);
      setError('');
    } catch (e) { if (e instanceof Error && e.message !== 'unauthorized') setError(e.message); }
  }, [api]);

  useEffect(() => {
    if (!token) return undefined;
    void load();
    void api('/api/participants').then((d) => { const p = d as { me?: string; participants: Participant[] }; setParticipants(p.participants); setMe(p.me ?? null); }).catch(() => {});
    const timer = setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [token, load, api]);

  const place = useCallback(async (id: string, column: RoadmapColumn, index: number) => {
    const card = items.find((i) => i.id === id);
    if (!card) return;
    const ids = placeAt(columnOf(items, column).map((i) => i.id), id, index);
    // Show it at once; the hub's answer then replaces it.
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, column } : i)).map((i) => (i.column === column ? { ...i, position: ids.indexOf(i.id) } : i)));
    setBusy(true);
    try {
      if (card.column !== column) await api(`/api/roadmap/${id}`, { method: 'PATCH', body: JSON.stringify({ column }) });
      await api('/api/roadmap', { method: 'PUT', body: JSON.stringify({ column, ids }) });
      setError('');
    } catch (e) {
      if (e instanceof Error && e.message !== 'unauthorized') setError(`Not saved: ${e.message}`);
    } finally {
      setBusy(false);
      void load();
    }
  }, [items, api, load]);

  const claim = useCallback(async (id: string, take: boolean) => {
    // Look before you build: the claim says what you found. Empty keeps the card's note.
    let note: string | null = null;
    if (take) {
      const answer = window.prompt('Look first: what did you find? e.g. «new» or «exists, small fix» (empty: keep the note)', '');
      if (answer === null) return; // cancelled: no claim
      note = answer.trim() || null;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/roadmap/${id}/claim`, { method: take ? 'POST' : 'DELETE', cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: take ? JSON.stringify(note ? { note } : {}) : undefined });
      const data = (await res.json().catch(() => ({}))) as { error?: string; owner?: string };
      if (res.status === 409) setError(`Already ${participants.find((p) => p.name === data.owner)?.label ?? data.owner}'s. Nothing changed.`);
      else if (!res.ok) setError(data.error || `HTTP ${res.status}`);
      else setError('');
    } finally {
      setBusy(false);
      void load();
    }
  }, [token, participants, load]);

  // A picture for the Compose window: the same upload as a message's (resized, scale noted).
  const upload = useCallback(async (file: Blob, pasted: boolean): Promise<Attachment> => {
    const request = await uploadRequest(file, pasted);
    const res = await fetch('/api/attachments', { ...request, headers: { ...request.headers, Authorization: `Bearer ${token}` } });
    if (res.status === 401) { setToken(''); throw new Error('unauthorized'); }
    const data = (await res.json().catch(() => ({}))) as Attachment & { error?: string };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }, [token]);
  const loadImage = useImageLoader(token, () => setToken(''));

  // An idea: a card at the top of «Later», noted as whose idea it is. No message: nobody is woken.
  const addIdea = useCallback(async ({ title, description, attachments }: NewIdea) => {
    setBusy(true);
    try {
      const who = participants.find((p) => p.name === me)?.label ?? me ?? '';
      // «top»: the hub puts it first in Later in the same step, so no second request can race it.
      await api('/api/roadmap', { method: 'POST', body: JSON.stringify({ column: 'later', title, note: `💡 idea from ${who}`.slice(0, 120), description, attachments, top: true }) });
      setError('');
      return true;
    } catch (e) {
      if (e instanceof Error && e.message !== 'unauthorized') setError(`Not saved: ${e.message}`);
      return false;
    } finally {
      setBusy(false);
      void load();
    }
  }, [api, items, me, participants, load]);

  if (token === null) return null;
  if (!token) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-xl font-bold">Roadmap</h1>
        <p className="text-muted">Sign in on the <a href="/">hub</a> first; this page uses the same token.</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-[1500px] p-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="m-0 text-2xl font-bold">Roadmap</h1>
        <p className="m-0 text-sm text-muted">Drag a card to change the order, or use ↑ ↓. The top of «Next» is what we do next; the dashed line shows what we likely still do today.</p>
        <a href="/" className="ml-auto text-sm">← Hub</a>
      </header>
      {/* One line per participant: what each is doing now and what waits on whom, so nobody has to
          read the cards to find out (playground #641). The same strip as on the hub. */}
      <div className="-mx-4 mb-3" data-roadmap-flight="">
        <FlightBar token={token} onUnauthorized={() => setToken('')} participants={participants} position="top" />
      </div>
      {error && <p role="alert" className="mb-2 text-sm text-bad">{error}</p>}
      <RoadmapBoard items={items} participants={participants} me={me} busy={busy} actions={{ place: (id, c, i) => { void place(id, c, i); }, claim: (id, take) => { void claim(id, take); }, addIdea, upload }} loadImage={loadImage} />
    </main>
  );
}
