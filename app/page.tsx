'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Author, Message, Sender } from '../lib/core';
import { MAX_ATTACHMENTS_PER_MESSAGE, firstLine, type Attachment } from '../lib/shared';
import { createSseParser, type SseEvent } from '../lib/sse';
import { ACCEPT, DraftChips, MessageImages, prepareForUpload, useImageLoader, withoutSent, type Draft } from './attachments';
import { ExpandButton, draftFor, readDraft, useBoxHeight, useViewportHeight, writeDraft } from './composer';
import { EmojiPicker, insertAtCursor } from './emoji';
import { MessageBody } from './markdown';

const NAMES: Record<Author, string> = { grok: 'Grok', claude: 'Claude', david: 'David', hub: 'Hub' };
// The key keeps its first name, so browsers that already hold a token don't have to ask for it again.
const TOKEN_KEY = 'collabHubToken';
const POLL_MS = 1500;
// How long to poll after the live stream failed before trying the stream again.
const FALLBACK_MS = 30_000;
// A stream that ends sooner than this without the server saying goodbye counts as a failure.
const MIN_STREAM_MS = 5_000;

// Full class names per sender, so Tailwind sees them at build time.
const STYLE: Record<Author, { text: string; bg: string; border: string }> = {
  grok: { text: 'text-grok', bg: 'bg-grok', border: 'border-l-grok' },
  claude: { text: 'text-claude', bg: 'bg-claude', border: 'border-l-claude' },
  david: { text: 'text-david', bg: 'bg-david', border: 'border-l-david' },
  hub: { text: 'text-hub', bg: 'bg-hub', border: 'border-l-hub' },
};

const BUTTON = 'cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] hover:bg-[#343a47] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-[#2a2f3a]';
const FIELD = 'rounded-md border border-line bg-panel px-2 py-1.5';
// The buttons in the row under the message box: a little narrower on a phone, so the row fits.
const TOOL = `${BUTTON} max-sm:px-2`;

const timeFmt = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });

interface MessagesResponse {
  me: Sender;
  messages: Message[];
  pinned: Message[];
}

/** Merge new messages into the list, de-duplicated by id and sorted. */
function merge(list: Message[], incoming: Message[]): Message[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function TokenForm({ onSave }: { onSave: (token: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="mx-auto mt-[18vh] max-w-[420px] px-4">
      <h1 className="my-[0.67em] text-[2em] font-bold">Trialog</h1>
      <p className="my-4 text-muted">Paste your token once. It stays in this browser (localStorage) and is only sent to this site.</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSave(value.trim()); }}>
        <input
          type="password" autoFocus autoComplete="off" placeholder="Token" value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 rounded-md border border-line bg-panel px-2.5 py-[7px]"
        />
        <button type="submit" className={BUTTON}>Open hub</button>
      </form>
    </main>
  );
}

export default function Page() {
  const [token, setToken] = useState<string | null>(null); // null: not read yet; '': none saved
  const [me, setMe] = useState<Sender | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pinned, setPinned] = useState<Message[]>([]);
  const [status, setStatus] = useState('connecting…');
  const [draft, setDraft] = useState('');
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]); // images waiting in the composer
  const [dragging, setDragging] = useState(false);
  const lastId = useRef(0);
  const listRef = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const nextDraftKey = useRef(1);
  const draftsRef = useRef<Draft[]>([]);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null); // the message box
  const cursorAfterInsert = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(false); // the tall writing area
  const draftOwner = useRef<Sender | null>(null); // whose text is in the message box
  const viewportHeight = useViewportHeight();
  draftsRef.current = drafts;

  useEffect(() => { setToken(localStorage.getItem(TOKEN_KEY) || ''); }, []);

  const saveToken = (t: string) => { localStorage.setItem(TOKEN_KEY, t); setToken(t); };
  const forgetToken = useCallback(() => { localStorage.removeItem(TOKEN_KEY); setToken(''); setMe(null); }, []);

  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const res = await fetch(path, {
      ...options,
      cache: 'no-store',
      headers: { ...(options.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) { forgetToken(); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
    return res;
  }, [token, forgetToken]);

  const loadImage = useImageLoader(token, forgetToken);

  // Release the local previews when the page goes away.
  useEffect(() => () => { for (const d of draftsRef.current) URL.revokeObjectURL(d.preview); }, []);

  /**
   * Adds images to the composer: from the clipboard, a drop or the file picker. Each one gets a
   * preview chip at once and is uploaded in the background (shrunk first when it is over 4 MB).
   */
  const addImages = useCallback((files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    const accepted = images.filter((f) => ACCEPT.split(',').includes(f.type));
    const room = MAX_ATTACHMENTS_PER_MESSAGE - draftsRef.current.length;
    const taken = accepted.slice(0, Math.max(0, room));
    if (accepted.length < images.length) setNotice('Only PNG, JPEG and WebP images can be attached.');
    else if (taken.length < accepted.length) setNotice(`A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} images.`);
    else setNotice('');

    const added: Draft[] = taken.map((file) => ({ key: nextDraftKey.current++, name: file.name || 'image', preview: URL.createObjectURL(file), state: 'uploading' }));
    if (!added.length) return;
    draftsRef.current = [...draftsRef.current, ...added]; // so a second paste right away counts these
    setDrafts((list) => [...list, ...added]);
    const update = (key: number, change: Partial<Draft>) => setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...change } : d)));
    added.forEach((d, i) => {
      void (async () => {
        try {
          const blob = await prepareForUpload(taken[i]);
          const res = await api('/api/attachments', { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
          update(d.key, { state: 'ready', attachment: (await res.json()) as Attachment });
        } catch (e) {
          update(d.key, { state: 'failed', error: errorMessage(e) === 'unauthorized' ? 'not signed in' : errorMessage(e) });
        }
      })();
    });
  }, [api]);

  const removeDraft = (key: number) => {
    // An upload that is removed here is never linked; the server deletes it within the hour.
    setDrafts((list) => list.filter((d) => {
      if (d.key === key) URL.revokeObjectURL(d.preview);
      return d.key !== key;
    }));
  };

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); dragDepth.current += 1; setDragging(true); } },
    onDragOver: (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (e: React.DragEvent) => { if (hasFiles(e)) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); } },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // otherwise the browser leaves the page to show the dropped file
      dragDepth.current = 0;
      setDragging(false);
      addImages(Array.from(e.dataTransfer.files));
    },
  };

  // Live updates. The page reads /api/stream (new messages and pin changes pushed by the server).
  // If the stream can't be opened or breaks, it polls /api/messages instead and tries the stream
  // again after a while, so the page keeps working either way.
  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    const abort = new AbortController();
    lastId.current = 0;
    setMessages([]);

    const addMessages = (incoming: Message[]) => {
      if (!incoming.length) return;
      lastId.current = Math.max(lastId.current, incoming[incoming.length - 1].id);
      setMessages((list) => merge(list, incoming));
    };
    const pause = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });

    /** One request to the polling endpoint. */
    const pollOnce = async () => {
      const query = lastId.current ? `?since=${lastId.current}` : '';
      const data = (await (await api(`/api/messages${query}`, { signal: abort.signal })).json()) as MessagesResponse;
      if (stopped) return;
      setMe(data.me);
      addMessages(data.messages);
      setPinned(data.pinned);
    };

    /** Reads the stream until it ends. Returns true if it ended the way the server intends (so: reconnect at once). */
    const readStream = async (): Promise<boolean> => {
      const query = lastId.current ? `?since=${lastId.current}` : '';
      const res = await api(`/api/stream${query}`, { headers: { Accept: 'text/event-stream' }, signal: abort.signal });
      if (!res.body) throw new Error('no stream');
      const opened = Date.now();
      let goodbye = false;
      const parser = createSseParser((event: SseEvent) => {
        if (stopped) return;
        if (event.event === 'hello') { setMe((JSON.parse(event.data) as { me: Sender }).me); setStatus('live'); }
        else if (event.event === 'messages') addMessages(JSON.parse(event.data) as Message[]);
        else if (event.event === 'pins') setPinned(JSON.parse(event.data) as Message[]);
        else if (event.event === 'bye') goodbye = true;
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      return goodbye || Date.now() - opened >= MIN_STREAM_MS;
    };

    const run = async () => {
      while (!stopped) {
        let clean = false;
        try {
          clean = await readStream();
        } catch (e) {
          if (stopped || errorMessage(e) === 'unauthorized') return;
        }
        if (stopped) return;
        if (clean) continue; // the server ended the stream on schedule: reconnect from the last id

        // Fallback: poll for a while, then try the stream again.
        const until = Date.now() + FALLBACK_MS;
        while (!stopped && Date.now() < until) {
          try {
            await pollOnce();
            if (!stopped) setStatus('live · polling');
          } catch (e) {
            if (stopped || errorMessage(e) === 'unauthorized') return;
            setStatus('offline, retrying…');
          }
          await pause(POLL_MS);
        }
      }
    };
    void run();
    return () => { stopped = true; abort.abort(); };
  }, [token, api]);

  // Auto-scroll, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  // The stream also changes height when the message box below it grows or shrinks, or the window
  // does. A reader who was at the newest message stays there.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let heightBefore = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const wasAtEnd = stick.current || el.scrollHeight - el.scrollTop - heightBefore < 80;
      heightBefore = el.clientHeight;
      if (wasAtEnd) { el.scrollTop = el.scrollHeight; stick.current = true; }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [token]);

  // The box grows with its text up to a share of the window, or is the tall writing area.
  useBoxHeight(boxRef, draft, expanded, viewportHeight);

  // An unsent draft survives a reload: the text only, per participant, in this browser.
  // (This effect comes first on purpose. In the render where `me` changes, the box still holds
  // the previous text, and it must not be saved under the new name.)
  useEffect(() => {
    if (me && draftOwner.current === me) writeDraft(localStorage, me, draft);
  }, [draft, me]);
  // Once the page knows who is signed in, that participant's draft comes back.
  useEffect(() => {
    if (!me || draftOwner.current === me) return;
    const owner = draftOwner.current;
    const stored = readDraft(localStorage, me);
    draftOwner.current = me;
    setDraft((current) => draftFor(current, owner, me, stored));
  }, [me]);
  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /** Puts an emoji into the message box at the cursor, replacing a selection. The box keeps its place. */
  const insertEmoji = useCallback((char: string, focusBox: boolean) => {
    const box = boxRef.current;
    if (!box) return;
    const next = insertAtCursor(box.value, box.selectionStart, box.selectionEnd, char);
    cursorAfterInsert.current = next.cursor;
    setDraft(next.text);
    if (focusBox) box.focus();
  }, []);
  // React puts the cursor at the end when it writes the new text into the box. Move it back
  // behind the emoji, so the next one, or the next key, lands where the reader expects.
  useLayoutEffect(() => {
    const at = cursorAfterInsert.current;
    if (at === null) return;
    cursorAfterInsert.current = null;
    boxRef.current?.setSelectionRange(at, at);
  }, [draft]);

  const uploading = drafts.some((d) => d.state === 'uploading');
  const ready = drafts.filter((d) => d.state === 'ready' && d.attachment);
  const canSend = !sending && !uploading && (draft.trim() !== '' || ready.length > 0);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setNotice('');
    setEmojiOpen(false);
    try {
      const body: { text: string; to?: string; attachments?: string[] } = { text: draft };
      if (to) body.to = to;
      const sent = ready; // the images that go out with this message, as they are right now
      if (sent.length) body.attachments = sent.map((d) => d.attachment!.id);
      const res = await api('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const { message } = (await res.json()) as { message: Message };
      // Don't move lastId forward here: the next poll picks up anything sent in between.
      setMessages((list) => merge(list, [message]));
      if (message.pinned_at) setPinned((p) => merge(p, [message]));
      setDraft(''); // which also removes the stored draft and lets the box shrink back
      setExpanded(false);
      // Only what was sent leaves the composer. An image added while the message was on its way stays.
      for (const d of sent) URL.revokeObjectURL(d.preview);
      setDrafts((list) => withoutSent(list, sent));
      stick.current = true;
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setNotice(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const togglePin = async (m: Message, isPinned: boolean) => {
    try {
      const res = await api(`/api/messages/${m.id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !isPinned }),
      });
      const data = (await res.json()) as { message: Message; pinned: Message[] };
      setPinned(data.pinned);
      setMessages((list) => merge(list, [data.message]));
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setNotice(errorMessage(e));
    }
  };

  const exportTranscript = async () => {
    try {
      const blob = await (await api('/api/export')).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trialog-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setNotice(errorMessage(e));
    }
  };

  if (token === null) return null;
  if (!token) return <TokenForm onSave={saveToken} />;

  const pinnedIds = new Set(pinned.map((m) => m.id));
  let lastDay = '';

  return (
    <div className="mx-auto flex h-screen max-w-[1000px] flex-col" {...dropHandlers}>
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <h1 className="m-0 text-[17px] font-bold">Trialog</h1>
        <span className={`text-[13px] ${status.startsWith('live') ? 'text-ok' : 'text-bad'}`}>● {status}</span>
        <span className="flex-1" />
        {me && <span className="text-[13px] font-semibold">You: {NAMES[me]}</span>}
        <button className={BUTTON} onClick={exportTranscript}>Export .md</button>
        <button className={`${BUTTON} bg-transparent`} onClick={forgetToken}>Switch token</button>
      </header>

      {pinned.length > 0 && (
        <section className="max-h-[25vh] overflow-auto border-b border-line bg-[#1a1712] px-4 py-2">
          <h2 className="mb-1 text-xs font-bold uppercase tracking-[.08em] text-decision">Decisions</h2>
          <ul className="text-sm">
            {pinned.map((m) => (
              <li key={m.id} className="overflow-hidden text-ellipsis whitespace-nowrap">
                <a href={`#m-${m.id}`}>#{m.id}</a> <span className={`font-bold ${STYLE[m.sender].text}`}>{NAMES[m.sender]}</span>{' '}
                <span>{firstLine(m, 160)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <main className="flex-1 overflow-y-auto px-4 py-3" ref={listRef} onScroll={onScroll}>
        {messages.map((m) => {
          const date = new Date(m.created_at);
          const day = dayFmt.format(date);
          const showDay = day !== lastDay;
          lastDay = day;
          const isPinned = pinnedIds.has(m.id);
          const s = STYLE[m.sender];
          return (
            <div key={m.id}>
              {showDay && <div className="mb-1.5 mt-3.5 text-center text-xs text-muted">{day}</div>}
              <article
                id={`m-${m.id}`}
                className={`group flex gap-2.5 rounded border-l-[3px] px-2.5 py-2 ${s.border} ${isPinned ? 'bg-[#1f1b12]' : 'hover:bg-panel'}`}
              >
                <div className={`grid h-[30px] w-[30px] flex-none place-items-center rounded-full text-sm font-bold text-bg ${s.bg}`}>
                  {NAMES[m.sender]?.[0] ?? '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-[13px] text-muted">
                    <span className={`font-bold ${s.text}`}>{NAMES[m.sender] ?? m.sender}</span>
                    {m.recipient && (
                      <span className={m.recipient === me ? 'font-semibold text-fg' : ''}>→ {NAMES[m.recipient]}</span>
                    )}
                    <time dateTime={m.created_at} title={date.toLocaleString('de-CH')}>{timeFmt.format(date)}</time>
                    <span className="text-xs">#{m.id}</span>
                    <button
                      className={`ml-auto cursor-pointer border-none bg-transparent px-1.5 text-[13px] ${isPinned ? 'opacity-100' : 'opacity-25 group-hover:opacity-60'}`}
                      title={isPinned ? 'Unpin decision' : 'Pin as decision'}
                      onClick={() => togglePin(m, isPinned)}
                    >📌</button>
                  </div>
                  {m.text.trim() !== '' && (
                    <div className="md wrap-anywhere">
                      <MessageBody text={m.text} />
                    </div>
                  )}
                  <MessageImages attachments={m.attachments ?? []} load={loadImage} />
                </div>
              </article>
            </div>
          );
        })}
      </main>

      <footer className={`relative border-t px-4 py-2.5 ${dragging ? 'border-david bg-panel' : 'border-line'}`}>
        {dragging && <div className="mb-1.5 text-[13px] text-david">Drop the image to attach it.</div>}
        {notice && <div className="mb-1.5 text-[13px] text-bad">{notice}</div>}
        <DraftChips drafts={drafts} onRemove={removeDraft} />
        {/* The message box has the full width on every screen. The controls sit in one row below it. */}
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea
            ref={boxRef}
            rows={2}
            value={draft}
            aria-label="Message"
            placeholder="Message (Markdown). @claude / @grok to address, DECISION: to pin. Paste or drop an image to attach it."
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
              if (!files.length) return; // plain text: paste as usual
              e.preventDefault();
              addImages(files);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            // The height is set from the text (see useBoxHeight), so the browser's own resize
            // handle is switched off: at the bottom of the window there is nowhere to drag it.
            className={`${FIELD} block min-h-[60px] w-full resize-none`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Recipient" className={FIELD}>
              <option value="">to everyone</option>
              <option value="grok">to Grok</option>
              <option value="claude">to Claude</option>
              <option value="david">to David</option>
            </select>
            <input
              ref={fileInput} type="file" accept={ACCEPT} multiple hidden
              onChange={(e) => { addImages(Array.from(e.target.files ?? [])); e.target.value = ''; }}
            />
            <button
              type="button" className={TOOL} onClick={() => fileInput.current?.click()}
              disabled={drafts.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              title="Attach an image (PNG, JPEG or WebP). You can also paste one or drop it here."
            >Image</button>
            <EmojiPicker open={emojiOpen} onOpenChange={setEmojiOpen} onInsert={insertEmoji} boxRef={boxRef} buttonClassName={TOOL} />
            <ExpandButton expanded={expanded} onToggle={() => { setExpanded((v) => !v); boxRef.current?.focus(); }} className={TOOL} />
            <span className="ml-auto hidden text-xs text-muted md:inline">Enter sends · Shift+Enter for a new line</span>
            <button type="submit" className={`${TOOL} ml-auto md:ml-0`} disabled={!canSend}>{uploading ? 'Uploading…' : 'Send'}</button>
          </div>
        </form>
      </footer>
    </div>
  );
}
