'use client';

// /roadmap: the interactive roadmap. It uses the token the hub page saved in this browser; without
// one it sends the reader to the hub to sign in first. The cards arrive live (/api/roadmap/stream),
// so a move by anyone shows within a couple of seconds while it is open next to the hub.
import { useCallback, useEffect, useState } from 'react';
import { RoadmapBoard, columnOf, duplicateOf, placeAt, shipText } from '../roadmap-board';
import { useMergedPrs } from '../merged';
import { ROADMAP_NOTE_MAX, type RoadmapColumn, type RoadmapItem } from '../../lib/roadmap';
import type { Attachment, Participant } from '../../lib/shared';
import { uploadRequest, useImageLoader } from '../attachments';
import { FlightBar } from '../flight';
import type { NewIdea } from '../compose-idea';
import { eitherSignal, watchNap } from '../nap';
import { ACTIVITY_EVENTS, REST_POLL_MS, cardsKey, paceFor } from '../roadmap-pace';
import { createSseParser, type SseEvent } from '../../lib/sse';

const TOKEN_KEY = 'collabHubToken';
/** Only when the live stream can't be had: how often the page asks for the cards instead. */
const POLL_MS = 20_000;
/** A stream that lasted less than this failed, rather than ran its course. */
const STREAM_MIN_MS = 10_000;

/** Waits `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

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

  // Each agent's one pick in Next (migration 021). Read with the cards, and every minute: a pick
  // changes no card, so the stream doesn't carry it.
  const [picks, setPicks] = useState<{ participant: string; item_id: string }[]>([]);
  const loadPicks = useCallback(async () => {
    try { setPicks(((await api('/api/roadmap/picks')) as { picks: { participant: string; item_id: string }[] }).picks); } catch { /* the board works without them */ }
  }, [api]);
  useEffect(() => {
    if (!token) return undefined;
    void loadPicks();
    const t = setInterval(() => { if (!document.hidden) void loadPicks(); }, 60_000);
    return () => clearInterval(t);
  }, [token, loadPicks, items.length]);
  const load = useCallback(async () => {
    try {
      setItems(((await api('/api/roadmap')) as { items: RoadmapItem[] }).items);
      setError('');
    } catch (e) { if (e instanceof Error && e.message !== 'unauthorized') setError(e.message); }
  }, [api]);

  useEffect(() => {
    if (!token) return undefined;
    void api('/api/participants').then((d) => { const p = d as { me?: string; participants: Participant[] }; setParticipants(p.participants); setMe(p.me ?? null); }).catch(() => {});
    // The cards arrive live (/api/roadmap/stream), a second or two after any change, while someone is
    // there. A hidden tab asks nothing; a visible one nobody has touched for 10 minutes rests and looks
    // once every 6, so the database can scale to zero (app/roadmap-pace.ts, Grok's review of PR 121).
    // When the stream can't be had, the page asks every 20 seconds until it can.
    const abort = new AbortController();
    let conn: AbortController | null = null;
    let lastActive = Date.now();
    let wakeUp: (() => void) | null = null;
    const stirred = () => { lastActive = Date.now(); wakeUp?.(); };
    const onVisible = () => { if (!document.hidden) stirred(); };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, stirred, { passive: true });
    document.addEventListener('visibilitychange', onVisible);
    // Hidden: the stream stops at once (afterMs 0), not after the hub's 15 minutes.
    const nap = watchNap(document, () => conn?.abort(), { afterMs: 0 });
    // While live: nobody there for REST_AFTER_MS ends the stream, and the loop below rests.
    const check = setInterval(() => { if (paceFor(document.hidden, Date.now(), lastActive) === 'rest') conn?.abort(); }, 30_000);
    let seen = '';
    // A change of a card counts as activity, like a movement on the page.
    const take = (list: RoadmapItem[]) => {
      const key = cardsKey(list);
      if (seen && key !== seen) lastActive = Date.now();
      seen = key;
      setItems(list);
      setError('');
    };
    const look = async () => {
      try { take(((await api('/api/roadmap')) as { items: RoadmapItem[] }).items); } catch (e) { if (e instanceof Error && e.message !== 'unauthorized') setError(e.message); }
    };
    const run = async () => {
      while (!abort.signal.aborted) {
        if (nap.napping) await nap.awake(abort.signal);
        if (abort.signal.aborted) return;
        if (paceFor(document.hidden, Date.now(), lastActive) === 'rest') {
          await look();
          if (paceFor(document.hidden, Date.now(), lastActive) === 'rest') {
            await new Promise<void>((resolve) => { wakeUp = resolve; void pause(REST_POLL_MS, abort.signal).then(resolve); });
            wakeUp = null;
          }
          continue;
        }
        const opened = Date.now();
        try {
          conn = new AbortController();
          const res = await fetch('/api/roadmap/stream', { cache: 'no-store', headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: eitherSignal(abort.signal, conn.signal) });
          if (res.status === 401) { setToken(''); return; }
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          const parser = createSseParser((event: SseEvent) => {
            if (event.event === 'roadmap') take((JSON.parse(event.data) as { items: RoadmapItem[] }).items);
          });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        // A stream that ran its course (4 minutes), napped or went to rest: straight back to the top.
        // One that failed at once: poll a while.
        if (nap.napping || paceFor(document.hidden, Date.now(), lastActive) !== 'live' || Date.now() - opened >= STREAM_MIN_MS) continue;
        for (const until = Date.now() + POLL_MS * 3; !abort.signal.aborted && !nap.napping && paceFor(document.hidden, Date.now(), lastActive) === 'live' && Date.now() < until;) {
          await look();
          await pause(POLL_MS, abort.signal);
        }
      }
    };
    void run();
    return () => {
      abort.abort();
      nap.stop();
      clearInterval(check);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, stirred);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token, api]);

  useEffect(() => {
    const id = window.location.hash.replace(/^#/, '');
    if (!id || !items.some((i) => i.id === id)) return;
    document.getElementById(id)?.scrollIntoView({ block: 'center' });
  }, [items]);

  const place = useCallback(async (id: string, column: RoadmapColumn, index: number) => {
    const card = items.find((i) => i.id === id);
    if (!card) return;
    const ids = placeAt(columnOf(items, column).map((i) => i.id), id, index);
    // Show it at once; the hub's answer then replaces it.
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, column } : i)).map((i) => (i.column === column ? { ...i, position: ids.indexOf(i.id) } : i)));
    setBusy(true);
    try {
      if (card.column !== column) await api(`/api/roadmap/${id}`, { method: 'PATCH', body: JSON.stringify({ column }) });
      await api('/api/roadmap', { method: 'PUT', body: JSON.stringify({ column, ids, moved: id }) });
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
      // Said here, not only by the API after the round trip (Grok's nit on PR 78).
      if (note && [...note].length > ROADMAP_NOTE_MAX) { setError(`The note is ${[...note].length} characters; at most ${ROADMAP_NOTE_MAX}. Nothing changed.`); return; }
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/roadmap/${id}/claim`, { method: take ? 'POST' : 'DELETE', cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: take ? JSON.stringify(note ? { note } : {}) : undefined });
      const data = (await res.json().catch(() => ({}))) as { error?: string; owner?: string };
      // A 409 is a card someone else holds, or a done card, or one that changed meanwhile: say which.
      if (res.status === 409 && data.owner) setError(`Already ${participants.find((p) => p.name === data.owner)?.label ?? data.owner}'s. Nothing changed.`);
      else if (res.status === 409) setError(data.error || 'Nothing changed.');
      else if (!res.ok) setError(data.error || `HTTP ${res.status}`);
      else setError('');
    } finally {
      setBusy(false);
      void load();
    }
  }, [token, participants, load]);

  // «🚀 Ship it!» from a card (playground #617): a message to the card's reviewer, with the 🚀 on it,
  // the same go as pressing Ship it on a message. The reviewer merges, as always.
  // PRs named on cards that are not done yet: once merged, their cards stop being red (#813).
  const merged = useMergedPrs(token, items.filter((i) => i.column !== 'done').map((i) => i.note));

  const ship = useCallback(async (card: RoadmapItem, prs: readonly number[]): Promise<boolean> => {
    setBusy(true);
    try {
      const { message } = (await api('/api/messages', { method: 'POST', body: JSON.stringify({ text: shipText(card, prs), ...(card.reviewer ? { to: card.reviewer } : {}) }) })) as { message: { id: number } };
      await api(`/api/messages/${message.id}/reactions/${encodeURIComponent('🚀')}`, { method: 'PUT' });
      setError('');
      return true;
    } catch (e) {
      if (e instanceof Error && e.message !== 'unauthorized') setError(`Ship it didn't go out: ${e.message}`);
      return false;
    } finally { setBusy(false); }
  }, [api]);

  // «🚀 Build it!» from a card in Next or Later (playground #1185): one call. The hub moves the card
  // to the top of Now and posts the go (to its owner, or to everyone: the first claim wins), which
  // wakes the agents. Only the orchestrator may; a card already under way answers 409, no second go.
  const build = useCallback(async (card: RoadmapItem): Promise<boolean> => {
    setBusy(true);
    try {
      await api(`/api/roadmap/${card.id}/build-it`, { method: 'POST' });
      setError('');
      return true;
    } catch (e) {
      if (e instanceof Error && e.message !== 'unauthorized') setError(`Build it didn't go out: ${e.message}`);
      return false;
    } finally {
      setBusy(false);
      void load();
    }
  }, [api, load]);

  // Editing a card in Next or Later (playground #1098): its title and text, or delete it.
  const edit = useCallback(async (id: string, change: { title: string; description: string; attachments?: string[] }): Promise<boolean> => {
    setBusy(true);
    try {
      const { attachments, ...text } = change;
      await api(`/api/roadmap/${id}`, { method: 'PATCH', body: JSON.stringify(text) });
      // The pictures, when the window could change them (playground #1403): the new list, in order.
      if (attachments) await api(`/api/roadmap/${id}/pictures`, { method: 'PUT', body: JSON.stringify({ attachments }) });
      setError('');
      return true;
    } catch (e) {
      if (e instanceof Error && e.message !== 'unauthorized') setError(`Not saved: ${e.message}`);
      return false;
    } finally { setBusy(false); void load(); }
  }, [api, load]);
  const remove = useCallback(async (id: string): Promise<boolean> => {
    setBusy(true);
    try {
      await api(`/api/roadmap/${id}`, { method: 'DELETE' });
      setError('');
      return true;
    } catch (e) {
      if (e instanceof Error && e.message !== 'unauthorized') setError(`Not deleted: ${e.message}`);
      return false;
    } finally { setBusy(false); void load(); }
  }, [api, load]);

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

  // «⧉ Duplicate»: the copy (duplicateOf) right below the original, or at the top of Next for a card
  // in Now. The copy's id comes back, so the board can open it for editing.
  const duplicate = useCallback(async (card: RoadmapItem): Promise<string | null> => {
    const copy = duplicateOf(card);
    setBusy(true);
    try {
      const { item } = (await api('/api/roadmap', { method: 'POST', body: JSON.stringify({ column: copy.column, title: copy.title, note: '', description: copy.description, attachments: copy.attachments, top: copy.top }) })) as { item: RoadmapItem };
      if (!copy.top) {
        const ids = columnOf(items, card.column).map((i) => i.id).filter((id) => id !== item.id);
        ids.splice(ids.indexOf(card.id) + 1, 0, item.id);
        await api('/api/roadmap', { method: 'PUT', body: JSON.stringify({ column: card.column, ids }) });
      }
      setError('');
      return item.id;
    } catch (e) {
      if (e instanceof Error && e.message !== 'unauthorized') setError(`Not duplicated: ${e.message}`);
      return null;
    } finally {
      setBusy(false);
      void load();
    }
  }, [api, items, load]);

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
      <RoadmapBoard merged={merged} picks={picks} items={items} participants={participants} me={me} busy={busy} actions={{ place: (id, c, i) => { void place(id, c, i); }, claim: (id, take) => { void claim(id, take); }, addIdea, upload, ship, build, edit, remove, duplicate }} loadImage={loadImage} />
    </main>
  );
}
