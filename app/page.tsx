'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import type { Message, Poll, Sender } from '../lib/core';
import { MAX_ATTACHMENTS_PER_MESSAGE, attachmentLabel, colorOf, displayName, firstLine, type Attachment, type Participant } from '../lib/shared';
import { createSseParser, type SseEvent } from '../lib/sse';
import { ACCEPT, DraftChips, MessageImages, uploadRequest, useImageLoader, withoutSent, type Draft } from './attachments';
import { ExpandButton, draftFor, readDraft, useBoxHeight, useViewportHeight, writeDraft } from './composer';
import { DecisionBadge, isDecision, pinnedListTitle } from './decision';
import { EmojiPicker, insertAtCursor } from './emoji';
import { MessageBody } from './markdown';
import { ChipRow } from './chips';
import { PollCard, PollComposer, withPolls } from './polls';
import {
  MAX_QUOTES, MESSAGE_TEXT_ATTRIBUTE, QuoteChips, QuoteMessageButton, QuoteSelectionButton, addQuote as withQuote, composeMessage,
  pickSelection, tooLong, typedIntent, useQuotableSelection, type QuoteChip,
} from './quote';
import { ReactionBar, applyReactionList, replaceMatching } from './reactions';
import { ReplyButton, ReplyContext, ReplyingTo } from './replies';
import { StatusBar } from './status';
import { NewVersionPill, useWaitingLong } from './version';
import { BUILD_ID, isOtherBuild } from '../lib/build';

// The key keeps its first name, so browsers that already hold a token don't have to ask for it again.
const TOKEN_KEY = 'collabHubToken';
const POLL_MS = 1500;
// How long to poll after the live stream failed before trying the stream again.
const FALLBACK_MS = 30_000;
// A stream that ends sooner than this without the server saying goodbye counts as a failure.
const MIN_STREAM_MS = 5_000;

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
  polls?: Poll[];
  reactions?: { message_id: number; reactions: Message['reactions'] }[];
}
/** GET /api/participants: who takes part here. The page has no names of its own. */
interface ParticipantsResponse {
  me: Sender;
  participants: Participant[];
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
  const [serverBuild, setServerBuild] = useState<string | null>(null); // the build the server says it runs
  // The server runs another build than this page was loaded with. The page says so and waits for a click.
  const newVersion = isOtherBuild(BUILD_ID, serverBuild);
  const newVersionWaitsLong = useWaitingLong(newVersion);
  const [draft, setDraft] = useState('');
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [participants, setParticipants] = useState<Participant[]>([]);
  // The names alone, for the rules that read how a message starts ("@name", "DECISION:").
  const names = useMemo(() => participants.map((p) => p.name), [participants]);
  const [setupError, setSetupError] = useState(''); // the server's settings can't be used; it says which
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
  const [pollOpen, setPollOpen] = useState(false);
  const [pollBusy, setPollBusy] = useState(false);
  const [pollError, setPollError] = useState('');
  const boxRef = useRef<HTMLTextAreaElement>(null); // the message box
  const cursorAfterInsert = useRef<number | null>(null);
  const markTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [expanded, setExpanded] = useState(false); // the tall writing area
  const [replyTo, setReplyTo] = useState<Message | null>(null); // the message the next one will answer
  const [marked, setMarked] = useState<number | null>(null); // a message that was just jumped to
  const draftOwner = useRef<Sender | null>(null); // whose text is in the message box
  const [quotes, setQuotes] = useState<QuoteChip[]>([]); // quotes waiting above the message box
  const quotesRef = useRef<QuoteChip[]>([]);
  const draftRef = useRef('');
  const nextQuoteKey = useRef(1);
  quotesRef.current = quotes;
  draftRef.current = draft;
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
  const addImages = useCallback((files: File[], pasted = false) => {
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
          const res = await api('/api/attachments', await uploadRequest(taken[i], pasted));
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
    setParticipants([]);
    setSetupError('');

    /**
     * Asks who takes part and who this token belongs to: the names, the recipient picker and the
     * colours all come from the answer. Asked again whenever the stream reconnects, so a change to
     * the server's setting shows up without a reload. A failure here stops nothing: messages are
     * still shown, in the neutral colour, until an answer arrives.
     */
    const loadParticipants = async () => {
      try {
        const data = (await (await api('/api/participants', { signal: abort.signal })).json()) as ParticipantsResponse;
        if (stopped) return;
        setParticipants(data.participants);
        setMe(data.me);
        setSetupError('');
      } catch (e) {
        if (errorMessage(e) === 'unauthorized') throw e; // the token was refused: the caller stops
        if (!stopped && errorMessage(e).startsWith('Configuration error')) setSetupError(errorMessage(e));
      }
    };

    const addMessages = (incoming: Message[]) => {
      if (!incoming.length) return;
      lastId.current = Math.max(lastId.current, incoming[incoming.length - 1].id);
      setMessages((list) => merge(list, incoming));
      setPinned((list) => replaceMatching(list, incoming));
    };
    const pause = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });

    /** One request to the polling endpoint. */
    const pollOnce = async () => {
      const params = new URLSearchParams({ polls: '1', reactions: '1' });
      if (lastId.current) params.set('since', String(lastId.current));
      const data = (await (await api(`/api/messages?${params}`, { signal: abort.signal })).json()) as MessagesResponse;
      if (stopped) return;
      setMe(data.me);
      addMessages(data.messages);
      setPinned(data.pinned);
      if (data.polls?.length) setMessages((list) => withPolls(list, data.polls ?? []));
      if (data.reactions) {
        setMessages((list) => applyReactionList(list, data.reactions ?? []));
        setPinned((list) => applyReactionList(list, data.reactions ?? []));
      }
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
        if (event.event === 'hello') {
          // Every (re)connect of the stream says who we are and which build the server runs.
          const hello = JSON.parse(event.data) as { me: Sender; build?: unknown };
          setMe(hello.me);
          if (typeof hello.build === 'string') setServerBuild(hello.build);
          setStatus('live');
        }
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
          await loadParticipants();
          if (stopped) return;
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

  // A recipient who is no longer a participant can't stay selected.
  useEffect(() => {
    if (to && participants.length && !participants.some((p) => p.name === to)) setTo('');
  }, [to, participants]);

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

  // An unsent draft survives a reload: the text and the quotes, never the images, per participant,
  // in this browser. (This effect comes first on purpose. In the render where `me` changes, the
  // composer still holds the previous draft, and it must not be saved under the new name.)
  useEffect(() => {
    if (me && draftOwner.current === me) writeDraft(localStorage, me, { text: draft, quotes });
  }, [draft, quotes, me]);
  // Once the page knows who is signed in, that participant's draft comes back.
  useEffect(() => {
    if (!me || draftOwner.current === me) return;
    const owner = draftOwner.current;
    draftOwner.current = me;
    const current = { text: draftRef.current, quotes: quotesRef.current };
    const next = draftFor(current, owner, me, readDraft(localStorage, me));
    if (next === current) return;
    setDraft(next.text);
    setQuotes(next.quotes.map((q) => ({ ...q, key: nextQuoteKey.current++ })));
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
    const box = boxRef.current;
    if (!box) return;
    box.setSelectionRange(at, at);
    // Something long, like a quote, can put the cursor below what the box shows. Bring it into view.
    if (at >= box.value.length) box.scrollTop = box.scrollHeight;
  }, [draft]);

  // Quote a selection: text selected inside one message becomes a quote chip above the message box.
  const [quotable, clearQuotable] = useQuotableSelection();
  /** Quotes `selected` from message `m`, or the whole message when `selected` is null. */
  const addQuote = useCallback((m: Message, selected: string | null) => {
    const source = m.text.trim() !== '' ? m.text : (m.attachments ?? []).map(attachmentLabel).join('\n');
    const text = selected ?? source;
    if (text.trim() === '') return;
    const chip: QuoteChip = { key: nextQuoteKey.current++, author: displayName(m.sender), messageId: m.id, kind: selected === null ? 'message' : 'selection', text };
    const result = withQuote(quotesRef.current, chip);
    setNotice(result.refused === 'full' ? `A message can carry at most ${MAX_QUOTES} quotes.` : '');
    quotesRef.current = result.quotes; // so a second quote right away counts this one
    setQuotes(result.quotes);
    clearQuotable();
    boxRef.current?.focus(); // the box stays free for what the writer wants to say
  }, [clearQuotable]);
  const removeQuote = (key: number) => {
    setQuotes((list) => list.filter((q) => q.key !== key));
    boxRef.current?.focus();
  };
  const quotedMessage = quotable ? messages.find((m) => m.id === quotable.messageId) : undefined;

  const uploading = drafts.some((d) => d.state === 'uploading');
  const ready = drafts.filter((d) => d.state === 'ready' && d.attachment);
  // What will be sent: the quotes written out as Markdown, then the typed text. The 20 KB limit is
  // the server's and counts all of it, so the writer is told before sending, not after.
  const composed = composeMessage(quotes, draft);
  const overLimit = tooLong(composed, quotes.length);
  const canSend = !sending && !uploading && !overLimit && (draft.trim() !== '' || ready.length > 0 || quotes.length > 0);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setNotice('');
    setEmojiOpen(false);
    try {
      const sentQuotes = quotes; // the quotes that go out with this message, as they are right now
      const body: { text: string; to?: string; attachments?: string[]; reply_to?: number } = { text: composed };
      // "@name" and "DECISION:" at the start of what was typed mean what they always mean. The
      // server looks for them at the start of the message, where the quotes now stand, so the
      // page asks for the recipient here, and for the pin below.
      const typed = sentQuotes.length ? typedIntent(draft, names) : { to: null, decision: false };
      if (to) body.to = to;
      else if (typed.to) body.to = typed.to;
      if (replyTo) body.reply_to = replyTo.id;
      const sent = ready; // the images that go out with this message, as they are right now
      if (sent.length) body.attachments = sent.map((d) => d.attachment!.id);
      const res = await api('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let { message } = (await res.json()) as { message: Message };
      if (typed.decision && !message.pinned_at) {
        try {
          const pinnedNow = await api(`/api/messages/${message.id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) });
          message = ((await pinnedNow.json()) as { message: Message }).message;
        } catch (e) {
          if (errorMessage(e) !== 'unauthorized') setNotice(`The message was sent, but it could not be pinned: ${errorMessage(e)}`);
        }
      }
      // Don't move lastId forward here: the next poll picks up anything sent in between.
      setMessages((list) => merge(list, [message]));
      if (message.pinned_at) setPinned((p) => merge(p, [message]));
      setDraft(''); // which also removes the stored draft and lets the box shrink back
      // Only what was sent leaves the composer: a quote added while the message was on its way stays.
      setQuotes((list) => list.filter((q) => !sentQuotes.some((sentQuote) => sentQuote.key === q.key)));
      setExpanded(false);
      setReplyTo(null);
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

  /** Starts a reply to `m`: the composer shows whom it answers, and the cursor goes to the message box. */
  const startReply = (m: Message) => {
    setReplyTo(m);
    boxRef.current?.focus();
  };
  /** Goes to a message in the stream and marks it for a moment, so the eye finds it. */
  const jumpTo = (id: number) => {
    const target = document.getElementById(`m-${id}`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true }); // for a screen reader, and so Tab goes on from there
    setMarked(id);
    clearTimeout(markTimer.current);
    markTimer.current = setTimeout(() => setMarked(null), 2000);
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

  const toggleReaction = async (m: Message, emoji: string, on: boolean) => {
    try {
      const path = `/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`;
      const res = await api(path, { method: on ? 'PUT' : 'DELETE' });
      const data = (await res.json()) as { message: Message };
      setMessages((list) => merge(list, [data.message]));
      setPinned((list) => replaceMatching(list, [data.message]));
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

  const applyPoll = (poll: Poll) => {
    setMessages((list) => withPolls(list, [poll]));
    setPinned((list) => withPolls(list, [poll]));
  };

  const createPoll = async (question: string, options: string[]) => {
    setPollBusy(true);
    setPollError('');
    try {
      const body: { question: string; options: string[]; to?: string } = { question, options };
      if (to) body.to = to;
      const res = await api('/api/polls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await res.json()) as { message: Message; poll: Poll };
      setMessages((list) => merge(list, [data.message]));
      setPollOpen(false);
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setPollError(errorMessage(e));
    } finally {
      setPollBusy(false);
    }
  };

  const voteOnPoll = async (pollId: string, option: number | null) => {
    try {
      if (option === null) {
        const data = (await (await api(`/api/polls/${pollId}/vote`, { method: 'DELETE' })).json()) as { poll: Poll };
        applyPoll(data.poll);
      } else {
        const data = (await (await api(`/api/polls/${pollId}/vote`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ option }),
        })).json()) as { poll: Poll };
        applyPoll(data.poll);
      }
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setNotice(errorMessage(e));
    }
  };

  const closePoll = async (pollId: string) => {
    try {
      const data = (await (await api(`/api/polls/${pollId}/close`, { method: 'POST' })).json()) as { poll: Poll; message: Message | null };
      applyPoll(data.poll);
      if (data.message) setMessages((list) => merge(list, [data.message!]));
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setNotice(errorMessage(e));
    }
  };


  if (token === null) return null;
  if (!token) return <TokenForm onSave={saveToken} />;

  const pinnedIds = new Set(pinned.map((m) => m.id));
  const byId = new Map(messages.map((m) => [m.id, m])); // to find the message a reply answers
  let lastDay = '';
  // A name the server doesn't list (the hub's welcome, a former participant) gets the neutral colour.
  const color = (name: string) => colorOf(name, participants);
  const others = participants.filter((p) => p.name !== me).slice(0, 2).map((p) => `@${p.name}`);
  const addressHint = `${others.length ? others.join(' / ') : '@name'} to address`;
  const reload = () => window.location.reload();

  return (
    <div className="mx-auto flex h-screen max-w-[1000px] flex-col" {...dropHandlers}>
      {/* On a narrow screen the row has no room for the pill, so the header grows by a line for it. */}
      <header className={`relative flex items-center gap-3 border-b border-line px-4 py-2.5 ${newVersion ? 'max-md:pb-9' : ''}`}>
        <h1 className="m-0 text-[17px] font-bold">Trialog</h1>
        <span className={`text-[13px] ${status.startsWith('live') ? 'text-ok' : 'text-bad'}`}>● {status}</span>
        {/* The free space of the header starts with the "New version available" pill, directly after
            the status, so the state of the page reads in one spot and nothing else moves when it
            appears. On a narrow screen the pill sits on a line of its own, under the status. */}
        <span role="status" className="flex flex-1">
          {newVersion && <NewVersionPill onReload={reload} accent={newVersionWaitsLong} className="max-md:absolute max-md:bottom-2 max-md:left-4" />}
        </span>
        {me && <span className="text-[13px] font-semibold">You: {displayName(me)}</span>}
        <button className={BUTTON} onClick={exportTranscript}>Export .md</button>
        <button className={`${BUTTON} bg-transparent`} onClick={forgetToken}>Switch token</button>
      </header>

      {pinned.length > 0 && (
        <section className="max-h-[25vh] overflow-auto border-b border-line bg-[#1a1712] px-4 py-2">
          {/* Every pinned message is listed here. A decision carries its badge; a message pinned by hand does not. */}
          <h2 className="mb-1 text-xs font-bold uppercase tracking-[.08em] text-decision">{pinnedListTitle(pinned, names)}</h2>
          <ul className="text-sm">
            {pinned.map((m) => (
              <li key={m.id} className="overflow-hidden text-ellipsis whitespace-nowrap">
                <a href={`#m-${m.id}`}>#{m.id}</a> <span className="font-bold" style={{ color: color(m.sender) }}>{displayName(m.sender)}</span>{' '}
                {isDecision(m.text, names) && <><DecisionBadge />{' '}</>}
                <span>{firstLine(m, 160)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {quotable && quotedMessage && <QuoteSelectionButton at={quotable} onQuote={() => addQuote(quotedMessage, quotable.text)} />}

      <main className="flex-1 overflow-y-auto px-4 py-3" ref={listRef} onScroll={onScroll}>
        {messages.map((m) => {
          const date = new Date(m.created_at);
          const day = dayFmt.format(date);
          const showDay = day !== lastDay;
          lastDay = day;
          const isPinned = pinnedIds.has(m.id);
          const own = color(m.sender);
          return (
            <div key={m.id}>
              {showDay && <div className="mb-1.5 mt-3.5 text-center text-xs text-muted">{day}</div>}
              <article
                id={`m-${m.id}`}
                tabIndex={-1}
                className={`group flex gap-2.5 rounded border-l-[3px] px-2.5 py-2 outline-none transition-shadow duration-300 ${isPinned ? 'bg-[#1f1b12]' : 'hover:bg-panel'} ${marked === m.id ? 'shadow-[inset_0_0_0_2px_var(--color-accent)]' : ''}`}
                style={{ borderLeftColor: own }}
              >
                <div className="grid h-[30px] w-[30px] flex-none place-items-center rounded-full text-sm font-bold text-bg" style={{ backgroundColor: own }}>
                  {displayName(m.sender)[0] ?? '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-[13px] text-muted">
                    <span className="font-bold" style={{ color: own }}>{displayName(m.sender)}</span>
                    {m.recipient && (
                      <span className={m.recipient === me ? 'font-semibold text-fg' : ''}>→ {displayName(m.recipient)}</span>
                    )}
                    <time dateTime={m.created_at} title={date.toLocaleString('de-CH')}>{timeFmt.format(date)}</time>
                    <span className="text-xs">#{m.id}</span>
                    {/* On a narrow screen the header line has no room for the badge: there it gets a line of its own, below. */}
                    {isDecision(m.text, names) && <DecisionBadge className="max-sm:hidden" />}
                    <ReplyButton
                      messageId={m.id}
                      onReply={() => startReply(m)}
                      className="ml-auto cursor-pointer rounded border-none bg-transparent px-1.5 text-xs text-muted opacity-40 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                    />
                    <QuoteMessageButton
                      messageId={m.id}
                      // With text selected in this message, the button quotes that text; otherwise the whole message.
                      onQuote={() => { const pick = pickSelection(window.getSelection()); addQuote(m, pick?.messageId === m.id ? pick.text : null); }}
                      className="cursor-pointer rounded border-none bg-transparent px-1.5 text-xs text-muted opacity-40 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                    />
                    <button
                      className={`cursor-pointer border-none bg-transparent px-1.5 text-[13px] ${isPinned ? 'opacity-100' : 'opacity-25 group-hover:opacity-60'}`}
                      // The pin only pins. Whether a message is a decision is told by its badge, not by this button.
                      title={isPinned ? 'Unpin this message' : 'Pin this message'}
                      aria-label={isPinned ? 'Unpin this message' : 'Pin this message'}
                      aria-pressed={isPinned}
                      onClick={() => togglePin(m, isPinned)}
                    >📌</button>
                  </div>
                  {isDecision(m.text, names) && <div className="mt-0.5 sm:hidden"><DecisionBadge /></div>}
                  {m.reply_to != null && (() => {
                    const parent = byId.get(m.reply_to);
                    return (
                      <ReplyContext
                        replyTo={m.reply_to} parent={parent} onJump={jumpTo}
                        author={parent ? displayName(parent.sender) : undefined}
                        authorColor={parent ? color(parent.sender) : undefined}
                      />
                    );
                  })()}
                  {m.text.trim() !== '' && !(m.poll && m.text === m.poll.question) && (
                    <div className="md wrap-anywhere" {...{ [MESSAGE_TEXT_ATTRIBUTE]: m.id }}>
                      <MessageBody text={m.text} />
                    </div>
                  )}
                  {m.poll && (
                    <PollCard
                      poll={m.poll}
                      me={me}
                      participants={participants}
                      onVote={(pollId, option) => { void voteOnPoll(pollId, option); }}
                      onClose={(pollId) => { void closePoll(pollId); }}
                    />
                  )}
                  <MessageImages attachments={m.attachments ?? []} load={loadImage} />
                  <ReactionBar message={m} me={me} participants={participants} onToggle={(emoji, on) => { void toggleReaction(m, emoji, on); }} />
                </div>
              </article>
            </div>
          );
        })}
      </main>

      <StatusBar token={token} onUnauthorized={forgetToken} participants={participants} />

      <footer className={`relative border-t px-4 py-2.5 ${dragging ? 'border-accent bg-panel' : 'border-line'}`}>
        {dragging && <div className="mb-1.5 text-[13px] text-accent">Drop the image to attach it.</div>}
        {setupError && <div role="alert" className="mb-1.5 text-[13px] text-bad">{setupError}</div>}
        {notice && <div className="mb-1.5 text-[13px] text-bad">{notice}</div>}
        {overLimit && <div className="mb-1.5 text-[13px] text-bad" role="alert">{overLimit}</div>}
        {/* Everything that goes with the next message, in one row: the message it answers, quotes, images. */}
        {(replyTo || quotes.length > 0 || drafts.length > 0) && (
          <ChipRow>
            {replyTo && <ReplyingTo parent={replyTo} author={displayName(replyTo.sender)} onCancel={() => { setReplyTo(null); boxRef.current?.focus(); }} />}
            <QuoteChips quotes={quotes} onRemove={removeQuote} />
            <DraftChips drafts={drafts} onRemove={removeDraft} />
          </ChipRow>
        )}
        {pollOpen && (
          <PollComposer
            busy={pollBusy}
            error={pollError}
            onCancel={() => { setPollOpen(false); setPollError(''); }}
            onCreate={(question, options) => { void createPoll(question, options); }}
          />
        )}
        {/* The message box has the full width on every screen. The controls sit in one row below it. */}
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea
            ref={boxRef}
            rows={2}
            value={draft}
            aria-label="Message"
            placeholder={`Message (Markdown). ${addressHint}, DECISION: to pin. Paste or drop an image to attach it.`}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
              if (!files.length) return; // plain text: paste as usual
              e.preventDefault();
              addImages(files, true); // from the clipboard: see uploadRequest
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            // The height is set from the text (see useBoxHeight), so the browser's own resize
            // handle is switched off: at the bottom of the window there is nowhere to drag it.
            className={`${FIELD} block min-h-[60px] w-full resize-none`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Recipient" className={FIELD}>
              <option value="">to everyone</option>
              {participants.map((p) => <option key={p.name} value={p.name}>to {displayName(p.name)}</option>)}
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
            <button
              type="button"
              className={TOOL}
              aria-pressed={pollOpen}
              aria-expanded={pollOpen}
              aria-controls={pollOpen ? 'poll-composer' : undefined}
              onClick={() => { setPollOpen((v) => !v); setPollError(''); }}
            >Poll</button>
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
