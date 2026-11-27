// One room in the hub UI: its live messages, its composer, and (in split view) its room bar.
// The page can show one pane or two side by side; each pane talks to the server for its own room.

'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message, Poll, Sender } from '../lib/core';
import type { Attachment, DecisionCard, DecisionStance, ReadPosition, Room } from '../lib/shared';
import { MAIN_ROOM, MAX_ATTACHMENTS_PER_MESSAGE, attachmentLabel, colorOf, labelOf, formatSeen, type Participant } from '../lib/shared';
import { createSseParser, type SseEvent } from '../lib/sse';
import { ACCEPT, DraftChips, MessageImages, localScale, uploadRequest, useImageLoader, withoutSent, type Draft } from './attachments';
import { ComposerTools, draftFor, draftScope, readDraft, useBoxHeight, useViewportHeight, writeDraft } from './composer';
import { DecisionBadge, isDecision } from './decision';
import { PinnedBar } from './pinned-bar';
import { Guard } from './guard';
import { insertAtCursor } from './emoji';
import { MentionColors, MessageBody } from './markdown';
import { leadingHandle } from './mentions';
import { ChipRow } from './chips';
import { PollCard, PollComposer, withPolls } from './polls';
import { DecisionCardView, DecisionComposer, withDecisions } from './decisions';
import {
  MAX_QUOTES, MESSAGE_TEXT_ATTRIBUTE, QuoteChips, QuoteCommentBox, QuoteMessageButton, QuoteSelectionButton, addQuote as withQuote, composeMessage,
  composedIntent, pickSelection, quoteNotice, sameQuote, tooLong, useQuotableSelection, withComment, type Quote, type QuoteChip,
} from './quote';
import { ReactButton, ReactionBar, applyReactionList, replaceMatching } from './reactions';
import { SHIP_EMOJI, ShipIt } from './ship';
import { linksPullRequest } from './links';
import { ReplyButton, ReplyContext, ReplyingTo } from './replies';
import { ReadReceipts, UnseenFlag, applyReads, useUnseenClock, useVisibleReadMarker } from './reads';
import { heldBack, markSeen, readSeen, seenElsewhere, seenKey, settled } from './rooms';
import type { ParticipantWithWake } from './wakes';
import { agreedBy, type TourEvent } from './tour';

const POLL_MS = 1500;
const FALLBACK_MS = 30_000;
const ROOMS_SETTLE_MS = 1200;
const MIN_STREAM_MS = 5_000;
const OLDER_PAGE_SIZE = 500;
const OLDER_PAGES = 20;

export const PANE_BUTTON = 'cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] hover:bg-[#343a47] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-[#2a2f3a]';
const FIELD = 'rounded-md border border-line bg-panel px-2 py-1.5';
const TOOL = `${PANE_BUTTON} max-sm:px-2`;

const timeFmt = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });

interface MessagesResponse {
  me: Sender;
  messages: Message[];
  pinned: Message[];
  polls?: Poll[];
  reactions?: { message_id: number; reactions: Message['reactions'] }[];
  decisions?: DecisionCard[];
  reads?: ReadPosition[];
}

interface ParticipantsResponse {
  me: Sender;
  participants: ParticipantWithWake[];
}

function merge(list: Message[], incoming: Message[]): Message[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;

export function RoomPane({
  room,
  token,
  api,
  me,
  setMe,
  participants,
  setParticipants,
  setRooms,
  setSeenChanged,
  setServerBuild,
  setStatus,
  setSetupError,
  setupError = '',
  openRooms,
  onMissingRoom,
  seek,
  onJumped,
  picker,
  lead = false,
  roomInfo,
  statusBar,
  onUnauthorized,
  onHeard,
  soundSent,
  onTour,
}: {
  room: string;
  token: string;
  api: ApiFn;
  me: Sender | null;
  setMe: (me: Sender | null) => void;
  participants: ParticipantWithWake[];
  setParticipants: (p: ParticipantWithWake[]) => void;
  setRooms: React.Dispatch<React.SetStateAction<Room[]>>;
  setSeenChanged: React.Dispatch<React.SetStateAction<number>>;
  setServerBuild?: (id: string) => void;
  setStatus?: (s: string) => void;
  setSetupError?: (s: string) => void;
  setupError?: string;
  openRooms: readonly string[];
  onMissingRoom: (missing: string) => void;
  seek?: { room: string; id: number } | null;
  onJumped?: () => void;
  picker?: React.ReactNode;
  /** The leading pane also loads who takes part, follows storage from other windows, and reports live status. */
  lead?: boolean;
  roomInfo?: Room;
  statusBar?: React.ReactNode;
  onUnauthorized?: () => void;
  onHeard?: (messages: Message[], primed: boolean) => void;
  /** Your own message went out: the page plays the confirmation when sound mode is on. */
  soundSent?: () => void;
  /** Learn by doing: an action of the person, reported once the server has taken it (app/tour.tsx). From either pane. */
  onTour?: (event: TourEvent) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [pinned, setPinned] = useState<Message[]>([]);
  const [reads, setReads] = useState<ReadPosition[]>([]);
  const [primed, setPrimed] = useState(false);
  const roomRef = useRef(room);
  roomRef.current = room;
  const openRoomsRef = useRef(openRooms);
  openRoomsRef.current = openRooms;
  const streamToken = useRef<string | null>(null);
  const [draft, setDraft] = useState('');
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const participantsRef = useRef<Participant[]>([]);
  participantsRef.current = participants;
  const names = useMemo(() => participants.map((p) => p.name), [participants]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
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
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState('');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const cursorAfterInsert = useRef<number | null>(null);
  const markTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const replyToRef = useRef<Message | null>(null);
  const [marked, setMarked] = useState<number | null>(null);
  const pendingJump = useRef<number | null>(null);
  const draftOwner = useRef<string | null>(null);
  const [quotes, setQuotes] = useState<QuoteChip[]>([]);
  const quotesRef = useRef<QuoteChip[]>([]);
  const draftRef = useRef('');
  const nextQuoteKey = useRef(1);
  quotesRef.current = quotes;
  draftRef.current = draft;
  replyToRef.current = replyTo;
  const viewportHeight = useViewportHeight();
  draftsRef.current = drafts;
  const unseenNow = useUnseenClock(messages);
  const loadImage = useImageLoader(token, onUnauthorized ?? (() => {}));

  useEffect(() => () => { for (const d of draftsRef.current) URL.revokeObjectURL(d.preview); }, []);

  const addImages = useCallback((files: File[], pasted = false) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    const accepted = images.filter((f) => ACCEPT.split(',').includes(f.type));
    const roomLeft = MAX_ATTACHMENTS_PER_MESSAGE - draftsRef.current.length;
    const taken = accepted.slice(0, Math.max(0, roomLeft));
    if (accepted.length < images.length) setNotice('Only PNG, JPEG and WebP images can be attached.');
    else if (taken.length < accepted.length) setNotice(`A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} images.`);
    else setNotice('');

    const added: Draft[] = taken.map((file) => ({ key: nextDraftKey.current++, name: file.name || 'image', preview: URL.createObjectURL(file), state: 'uploading' }));
    if (!added.length) return;
    draftsRef.current = [...draftsRef.current, ...added];
    setDrafts((list) => [...list, ...added]);
    const update = (key: number, change: Partial<Draft>) => setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...change } : d)));
    added.forEach((d, i) => {
      void localScale(taken[i], pasted).then((scale) => { if (scale) update(d.key, { scale }); }, () => {});
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
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDragging(false);
      addImages(Array.from(e.dataTransfer.files));
    },
  };

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    const abort = new AbortController();
    lastId.current = 0;
    setMessages([]);
    setPinned([]);
    setReads([]);
    setPrimed(false);
    stick.current = true;
    if (lead && streamToken.current !== token) {
      streamToken.current = token;
      setParticipants([]);
      setSetupError?.('');
      setRooms([{ id: MAIN_ROOM, name: 'Main', created_at: '', created_by: 'hub', last_id: 0 }]);
    }
    let who: Sender | null = null;

    const loadParticipants = async () => {
      if (!lead) return;
      try {
        const data = (await (await api('/api/participants', { signal: abort.signal })).json()) as ParticipantsResponse;
        if (stopped) return;
        who = data.me;
        setParticipants(data.participants);
        setMe(data.me);
        setSetupError?.('');
      } catch (e) {
        if (errorMessage(e) === 'unauthorized') throw e;
        if (!stopped && errorMessage(e).startsWith('Configuration error')) setSetupError?.(errorMessage(e));
      }
    };

    const addMessages = (incoming: Message[]) => {
      if (!incoming.length) return;
      lastId.current = Math.max(lastId.current, incoming[incoming.length - 1].id);
      // What arrives while this room is open counts as seen there. The list is per room, so the
      // other pane's room is not moved.
      if (who) markSeen(localStorage, who, room, lastId.current);
      setMessages((list) => merge(list, incoming));
      setPinned((list) => replaceMatching(list, incoming));
    };
    const leaveMissingRoom = (e: unknown): boolean => {
      if (room === MAIN_ROOM || !/^Room ".*" does not exist/.test(errorMessage(e))) return false;
      setNotice(lead
        ? `There is no room "${room}" here. This is Main.`
        : `There is no room "${room}" here.`);
      onMissingRoom(room);
      return true;
    };
    const seenParam = (): string | null => (who ? formatSeen(readSeen(localStorage, who)) : null);
    // Rooms this window has open are not "elsewhere": both panes have already been looked at.
    const seenOfOthers = (): string => (who ? formatSeen(seenElsewhere(readSeen(localStorage, who), ...openRoomsRef.current)) : '');
    let toldStream = '';
    let latestRooms: Room[] | null = null;
    const showRooms = (list: Room[]) => {
      if (stopped || !lead) return;
      latestRooms = list;
      setRooms((shown) => heldBack(shown, list));
      setTimeout(() => { if (!stopped && latestRooms) { const latest = latestRooms; setRooms((shown) => settled(shown, list, latest)); } }, ROOMS_SETTLE_MS);
    };
    const refreshRooms = async () => {
      if (!lead) return;
      try {
        const mine = seenParam();
        const res = await api(`/api/rooms${mine === null ? '' : `?${new URLSearchParams({ seen: mine })}`}`, { signal: abort.signal });
        showRooms(((await res.json()) as { rooms: Room[] }).rooms);
      } catch { /* the tabs keep what they have */ }
    };
    const takeRooms = (list: Room[]) => {
      if (seenOfOthers() === toldStream) showRooms(list);
      else void refreshRooms();
    };
    const onStorage = (e: StorageEvent) => {
      if (!lead || !who || e.key !== seenKey(who)) return;
      setSeenChanged((n) => n + 1);
      void refreshRooms();
    };
    if (lead) window.addEventListener('storage', onStorage);
    const pause = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });

    const pollOnce = async () => {
      const params = new URLSearchParams({ polls: '1', reactions: '1', decisions: '1', reads: '1' });
      if (lastId.current) params.set('since', String(lastId.current));
      if (room !== MAIN_ROOM) params.set('room', room);
      const mine = seenParam();
      const messagesReq = api(`/api/messages?${params}`, { signal: abort.signal }).then((res) => res.json() as Promise<MessagesResponse>);
      const roomsReq = lead
        ? api(`/api/rooms${mine === null ? '' : `?${new URLSearchParams({ seen: mine })}`}`, { signal: abort.signal })
          .then((res) => res.json() as Promise<{ rooms: Room[] }>, () => null)
        : Promise.resolve(null);
      const [data, list] = await Promise.all([messagesReq, roomsReq]);
      if (stopped) return;
      if (list) showRooms(list.rooms);
      who = data.me;
      setMe(data.me);
      addMessages(data.messages);
      setPinned(data.pinned);
      if (data.polls?.length) setMessages((cur) => withPolls(cur, data.polls ?? []));
      if (data.reactions) {
        setMessages((cur) => applyReactionList(cur, data.reactions ?? []));
        setPinned((cur) => applyReactionList(cur, data.reactions ?? []));
      }
      if (data.decisions) {
        setMessages((cur) => withDecisions(cur, data.decisions ?? []));
        setPinned((cur) => withDecisions(cur, data.decisions ?? []));
      }
      if (data.reads) setReads((cur) => applyReads(cur, data.reads ?? []));
      setPrimed(true);
    };

    const readStream = async (): Promise<boolean> => {
      const params = new URLSearchParams();
      if (lastId.current) params.set('since', String(lastId.current));
      if (room !== MAIN_ROOM) params.set('room', room);
      const mine = seenParam();
      if (mine !== null) params.set('seen', mine);
      toldStream = seenOfOthers();
      let firstRooms = true;
      const query = params.toString() ? `?${params}` : '';
      const res = await api(`/api/stream${query}`, { headers: { Accept: 'text/event-stream' }, signal: abort.signal });
      if (!res.body) throw new Error('no stream');
      const opened = Date.now();
      let goodbye = false;
      const parser = createSseParser((event: SseEvent) => {
        if (stopped) return;
        if (event.event === 'hello') {
          const hello = JSON.parse(event.data) as { me: Sender; build?: unknown };
          who = hello.me;
          setMe(hello.me);
          if (lead) {
            if (typeof hello.build === 'string') setServerBuild?.(hello.build);
            setStatus?.('live');
          }
        }
        else if (event.event === 'messages') addMessages(JSON.parse(event.data) as Message[]);
        else if (event.event === 'pins') { setPinned(JSON.parse(event.data) as Message[]); setPrimed(true); }
        else if (event.event === 'reads') setReads((list) => applyReads(list, JSON.parse(event.data) as ReadPosition[]));
        else if (event.event === 'rooms') {
          if (!lead) return;
          const list = JSON.parse(event.data) as Room[];
          if (firstRooms) { firstRooms = false; latestRooms = list; setRooms(list); }
          else takeRooms(list);
        }
        else if (event.event === 'bye') goodbye = true;
      });
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      while (true) {
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
          if (stopped || errorMessage(e) === 'unauthorized' || leaveMissingRoom(e)) return;
        }
        if (stopped) return;
        if (clean) continue;
        const until = Date.now() + FALLBACK_MS;
        while (!stopped && Date.now() < until) {
          try {
            await pollOnce();
            if (!stopped && lead) setStatus?.('live · polling');
          } catch (e) {
            if (stopped || errorMessage(e) === 'unauthorized' || leaveMissingRoom(e)) return;
            if (lead) setStatus?.('offline, retrying…');
          }
          await pause(POLL_MS);
        }
      }
    };
    void run();
    return () => { stopped = true; abort.abort(); if (lead) window.removeEventListener('storage', onStorage); };
  }, [token, api, room, lead, onMissingRoom, setMe, setParticipants, setRooms, setSeenChanged, setServerBuild, setSetupError, setStatus]);

  useEffect(() => { onHeard?.(messages, primed); }, [messages, primed, onHeard]);

  const replies = useRef(new Map<string, Message>());
  const replyRoom = useRef(room);
  useEffect(() => {
    if (replyRoom.current === room) return;
    const left = replyRoom.current;
    replyRoom.current = room;
    if (replyToRef.current) replies.current.set(left, replyToRef.current); else replies.current.delete(left);
    setReplyTo(replies.current.get(room) ?? null);
    setRooms((list) => list.map((r) => (r.id === left || r.id === room ? { ...r, unread: 0 } : r)));
    setCommenting(null);
    setPollOpen(false);
    setDecisionOpen(false);
    setNotice('');
  }, [room, setRooms]);

  useEffect(() => {
    if (to && participants.length && !participants.some((p) => p.name === to)) setTo('');
  }, [to, participants]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
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

  useBoxHeight(boxRef, draft, expanded, viewportHeight);

  useEffect(() => {
    if (me && draftOwner.current === draftScope(me, room)) writeDraft(localStorage, draftScope(me, room), { text: draft, quotes });
  }, [draft, quotes, me, room]);
  useEffect(() => {
    if (!me) return;
    const scope = draftScope(me, room);
    if (draftOwner.current === scope) return;
    const owner = draftOwner.current;
    draftOwner.current = scope;
    const current = { text: draftRef.current, quotes: quotesRef.current };
    const next = draftFor(current, owner, scope, readDraft(localStorage, scope));
    if (next === current) return;
    setDraft(next.text);
    setQuotes(next.quotes.map((q) => ({ ...q, key: nextQuoteKey.current++ })));
  }, [me, room]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const insertEmoji = useCallback((char: string, focusBox: boolean) => {
    const box = boxRef.current;
    if (!box) return;
    const next = insertAtCursor(box.value, box.selectionStart, box.selectionEnd, char);
    cursorAfterInsert.current = next.cursor;
    setDraft(next.text);
    if (focusBox) box.focus();
  }, []);
  useLayoutEffect(() => {
    const at = cursorAfterInsert.current;
    if (at === null) return;
    cursorAfterInsert.current = null;
    const box = boxRef.current;
    if (!box) return;
    box.setSelectionRange(at, at);
    if (at >= box.value.length) box.scrollTop = box.scrollHeight;
  }, [draft]);

  const [quotable, clearQuotable] = useQuotableSelection();
  const [commenting, setCommenting] = useState<{ quote: Quote; key: number | null; at: { top: number; left: number } | null } | null>(null);
  const startQuote = useCallback((m: Message, selected: string | null, at: { top: number; left: number }) => {
    const source = m.text.trim() !== '' ? m.text : (m.attachments ?? []).map(attachmentLabel).join('\n');
    const text = selected ?? source;
    if (text.trim() === '') return;
    const quote: Quote = { author: labelOf(m.sender, participantsRef.current), messageId: m.id, kind: selected === null ? 'message' : 'selection', text };
    clearQuotable();
    const chip = quotesRef.current.find((q) => sameQuote(q, quote));
    if (!chip && quotesRef.current.length >= MAX_QUOTES) { setNotice(quoteNotice('full')); return; }
    setNotice('');
    setCommenting(chip ? { quote: chip, key: chip.key, at } : { quote, key: null, at });
  }, [clearQuotable]);
  const finishQuote = (comment: string) => {
    const open = commenting;
    if (!open) return;
    setCommenting(null);
    if (open.key === null) {
      const result = withQuote(quotesRef.current, withComment<QuoteChip>({ ...open.quote, key: nextQuoteKey.current++ }, comment));
      setNotice(quoteNotice(result.refused));
      quotesRef.current = result.quotes;
      setQuotes(result.quotes);
      if (!result.refused) onTour?.({ kind: 'quoted' });
    } else {
      const next = quotesRef.current.map((q) => (q.key === open.key ? withComment(q, comment) : q));
      quotesRef.current = next;
      setQuotes(next);
    }
    boxRef.current?.focus();
  };
  const cancelQuote = (how: 'escape' | 'outside', comment = '') => {
    // Nothing typed is thrown away: a new quote with words in its comment is kept as a chip (its ×
    // removes it). Editing an existing chip's comment and cancelling keeps the comment it had.
    if (commenting?.key === null && comment.trim()) { finishQuote(comment); return; }
    setCommenting(null);
    if (how === 'escape') boxRef.current?.focus();
  };
  const editQuote = (key: number) => {
    const chip = quotesRef.current.find((q) => q.key === key);
    if (chip) setCommenting({ quote: chip, key, at: null });
  };
  const removeQuote = (key: number) => {
    setQuotes((list) => list.filter((q) => q.key !== key));
    setCommenting((open) => (open?.key === key ? null : open));
    boxRef.current?.focus();
  };
  const quotedMessage = quotable ? messages.find((m) => m.id === quotable.messageId) : undefined;

  const uploading = drafts.some((d) => d.state === 'uploading');
  const ready = drafts.filter((d) => d.state === 'ready' && d.attachment);
  const composed = composeMessage(quotes, draft);
  const overLimit = tooLong(composed, quotes.length);
  const canSend = !sending && !uploading && !overLimit && !commenting && (draft.trim() !== '' || ready.length > 0 || quotes.length > 0);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setNotice('');
    setEmojiOpen(false);
    try {
      const sentQuotes = quotes;
      const body: { text: string; to?: string; attachments?: string[]; reply_to?: number; room?: string } = { text: composed };
      if (room !== MAIN_ROOM) body.room = room;
      const typed = sentQuotes.length ? composedIntent(sentQuotes, draft, names) : { to: null, decision: false };
      if (to) body.to = to;
      else if (typed.to) body.to = typed.to;
      if (replyTo) body.reply_to = replyTo.id;
      const sent = ready;
      if (sent.length) body.attachments = sent.map((d) => d.attachment!.id);
      const res = await api('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let { message } = (await res.json()) as { message: Message };
      soundSent?.();
      onTour?.({ kind: 'sent', message });
      if (typed.decision && !message.pinned_at) {
        try {
          const pinnedNow = await api(`/api/messages/${message.id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) });
          message = ((await pinnedNow.json()) as { message: Message }).message;
        } catch (e) {
          if (errorMessage(e) !== 'unauthorized') setNotice(`The message was sent, but it could not be pinned: ${errorMessage(e)}`);
        }
      }
      if (message.room === roomRef.current) {
        setMessages((list) => merge(list, [message]));
        if (message.pinned_at) setPinned((cur) => merge(cur, [message]));
      }
      setDraft('');
      setQuotes((list) => list.filter((q) => !sentQuotes.some((sentQuote) => sentQuote.key === q.key)));
      setExpanded(false);
      setReplyTo(null);
      for (const d of sent) URL.revokeObjectURL(d.preview);
      setDrafts((list) => withoutSent(list, sent));
      stick.current = true;
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setNotice(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const startReply = (m: Message) => {
    setReplyTo(m);
    boxRef.current?.focus();
  };

  const jumpTo = (id: number) => {
    const target = listRef.current?.querySelector(`#m-${id}`) ?? document.getElementById(`m-${id}`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    setMarked(id);
    clearTimeout(markTimer.current);
    markTimer.current = setTimeout(() => setMarked(null), 2000);
  };

  const goToMessage = async (id: number) => {
    if (listRef.current?.querySelector(`#m-${id}`) || document.getElementById(`m-${id}`)) { jumpTo(id); onJumped?.(); return; }
    const oldest = messages[0]?.id ?? Number.MAX_SAFE_INTEGER;
    try {
      const older: Message[] = [];
      let since = id - 1;
      for (let page = 0; page < OLDER_PAGES && since < oldest - 1; page++) {
        const data = (await (await api(`/api/messages?since=${since}&limit=${OLDER_PAGE_SIZE}${room === MAIN_ROOM ? '' : `&room=${room}`}`)).json()) as MessagesResponse;
        older.push(...data.messages.filter((m) => m.id < oldest));
        if (data.messages.length < OLDER_PAGE_SIZE) break;
        since = data.messages[data.messages.length - 1].id;
      }
      if (!older.some((m) => m.id === id)) { setNotice(`Message #${id} is no longer there.`); onJumped?.(); return; }
      stick.current = false;
      pendingJump.current = id;
      setMessages((list) => merge(list, older));
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setNotice(`Could not load message #${id}: ${errorMessage(e)}`);
      onJumped?.();
    }
  };

  useEffect(() => {
    if (!seek || seek.room !== room) return;
    void goToMessage(seek.id);
    // goToMessage is recreated each render; seek is the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek, room, messages.length]);

  useEffect(() => {
    const id = pendingJump.current;
    if (id === null || !listRef.current?.querySelector(`#m-${id}`)) return;
    pendingJump.current = null;
    jumpTo(id);
    onJumped?.();
  });

  const togglePin = async (m: Message, isPinned: boolean) => {
    try {
      const res = await api(`/api/messages/${m.id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !isPinned }),
      });
      const data = (await res.json()) as { message: Message; pinned: Message[] };
      if (data.message.room === roomRef.current) {
        setPinned(data.pinned);
        setMessages((list) => merge(list, [data.message]));
      }
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setNotice(errorMessage(e));
    }
  };

  const toggleReaction = async (m: Message, emoji: string, on: boolean) => {
    try {
      const path = `/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`;
      const res = await api(path, { method: on ? 'PUT' : 'DELETE' });
      const data = (await res.json()) as { message: Message };
      if (on) onTour?.({ kind: 'reacted' });
      if (data.message.room !== roomRef.current) return;
      setMessages((list) => merge(list, [data.message]));
      setPinned((list) => replaceMatching(list, [data.message]));
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
      const body: { question: string; options: string[]; to?: string; room?: string } = { question, options };
      if (to) body.to = to;
      if (room !== MAIN_ROOM) body.room = room;
      const res = await api('/api/polls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await res.json()) as { message: Message; poll: Poll };
      soundSent?.();
      if (data.message.room === roomRef.current) setMessages((list) => merge(list, [data.message]));
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

  const applyDecision = (card: DecisionCard, message?: Message) => {
    setMessages((list) => {
      const next = message ? merge(list, [message]) : list;
      return withDecisions(next, [card]);
    });
    setPinned((list) => {
      const next = message ? (message.pinned_at ? merge(list, [message]) : list.filter((m) => m.id !== message.id)) : list;
      return withDecisions(next, [card]);
    });
  };

  const createDecision = async (prompt: string) => {
    setDecisionBusy(true);
    setDecisionError('');
    try {
      const body: { prompt: string; to?: string; room?: string } = { prompt };
      if (to) body.to = to;
      if (room !== MAIN_ROOM) body.room = room;
      const res = await api('/api/decisions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await res.json()) as { message: Message; decision: DecisionCard };
      soundSent?.();
      // A card the human creates holds their Agree already: that is the tour's step too.
      if (agreedBy(data.decision, data.message.sender)) onTour?.({ kind: 'agreed' });
      if (data.message.room === roomRef.current) setMessages((list) => merge(list, [data.message]));
      setDecisionOpen(false);
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setDecisionError(errorMessage(e));
    } finally {
      setDecisionBusy(false);
    }
  };

  const recordDecisionPosition = async (cardId: string, stance: DecisionStance, note: string | null) => {
    try {
      const data = (await (await api(`/api/decisions/${cardId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stance, note }),
      })).json()) as { decision: DecisionCard; message: Message; reply: Message | null };
      applyDecision(data.decision, data.message);
      if (me && agreedBy(data.decision, me)) onTour?.({ kind: 'agreed' });
      if (data.reply) setMessages((list) => merge(list, [data.reply!]));
    } catch (e) {
      if (errorMessage(e) !== 'unauthorized') setNotice(errorMessage(e));
    }
  };

  const messageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  useVisibleReadMarker(listRef, messageIds, Boolean(token && me), (upTo) => {
    void (async () => {
      try {
        // The room is sent with the id, so a message from another pane cannot move this room's position.
        const data = (await (await api('/api/read', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upTo, room }),
        })).json()) as { read: ReadPosition };
        if (data.read && data.read.room === roomRef.current) setReads((list) => applyReads(list, [data.read]));
      } catch { /* retried on the next visible batch */ }
    })();
  });

  const pinnedIds = new Set(pinned.map((m) => m.id));
  const byId = new Map(messages.map((m) => [m.id, m]));
  let lastDay = '';
  const color = (name: string) => colorOf(name, participants);
  // The «to» picker wins over an @name, as in the API; without it the @name at the start addresses.
  const handle = to ? { kind: 'none' as const } : leadingHandle(draft, names);
  const shown = (name: string) => labelOf(name, participants);
  const others = participants.filter((p) => p.name !== me).slice(0, 2).map((p) => `@${p.name}`);
  const addressHint = `${others.length ? others.join(' / ') : '@name'} to address`;

  const actionClass = 'cursor-pointer rounded border-none bg-transparent px-1.5 text-xs text-muted opacity-40 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100';

  return (
    // The tour points at the controls of the leading pane only (data-tour-pane).
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-tour-pane={lead ? 'lead' : 'side'} {...dropHandlers}>
      {picker}
      <PinnedBar list={pinned} names={names} color={color} shown={shown} onJump={(id) => { void goToMessage(id); }} />

      {quotable && quotedMessage && !commenting && (
        <QuoteSelectionButton at={quotable} onQuote={() => startQuote(quotedMessage, quotable.text, { top: quotable.top, left: quotable.left })} />
      )}
      {commenting?.at && (
        <QuoteCommentBox
          key={`${commenting.quote.messageId}:${commenting.quote.kind}:${commenting.quote.text}`}
          quote={commenting.quote} at={commenting.at} editing={commenting.key !== null} onSubmit={finishQuote} onCancel={cancelQuote}
        />
      )}

      <MentionColors.Provider value={color}>
      <main className="flex-1 overflow-y-auto px-4 py-3" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && roomInfo && roomInfo.id !== MAIN_ROOM && roomInfo.last_id === 0 && (
          <p className="mt-[18vh] text-center text-sm text-muted">Nothing in {roomInfo.name} yet. The first message is yours.</p>
        )}
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
                  {shown(m.sender)[0] ?? '?'}
                </div>
                <div className="min-w-0 flex-1">
                  {/* It wraps only when the line is too long, as on a phone; then the actions go to a second line. */}
                  <div className="flex flex-wrap items-baseline gap-2 text-[13px] text-muted">
                    <span className="font-bold" style={{ color: own }}>{shown(m.sender)}</span>
                    {m.recipient && (
                      <span className={m.recipient === me ? 'font-semibold text-fg' : ''}>→ {shown(m.recipient)}</span>
                    )}
                    <time dateTime={m.created_at} title={date.toLocaleString('de-CH')}>{timeFmt.format(date)}</time>
                    <span className="text-xs">#{m.id}</span>
                    {isDecision(m.text, names, m.decision) && <DecisionBadge className="max-sm:hidden" />}
                    <div className="ml-auto flex items-baseline gap-0">
                      <ReplyButton
                        messageId={m.id}
                        onReply={() => startReply(m)}
                        className={actionClass}
                      />
                      <QuoteMessageButton
                        messageId={m.id}
                        onQuote={(at) => { const pick = pickSelection(window.getSelection()); startQuote(m, pick?.messageId === m.id ? pick.text : null, at); }}
                        className={actionClass}
                      />
                      <button
                        className={`cursor-pointer rounded border-none bg-transparent px-1.5 text-[13px] ${isPinned ? 'opacity-100' : 'opacity-40 grayscale hover:text-fg focus-visible:opacity-100 group-hover:opacity-100'}`}
                        title={isPinned ? 'Unpin this message' : 'Pin this message'}
                        aria-label={isPinned ? 'Unpin this message' : 'Pin this message'}
                        aria-pressed={isPinned}
                        onClick={() => togglePin(m, isPinned)}
                      >📌</button>
                      <ReactButton
                        message={m}
                        me={me}
                        onToggle={(emoji, on) => { void toggleReaction(m, emoji, on); }}
                        className={actionClass}
                      />
                    </div>
                  </div>
                  {isDecision(m.text, names, m.decision) && <div className="mt-0.5 sm:hidden"><DecisionBadge /></div>}
                  {m.reply_to != null && (() => {
                    const parent = byId.get(m.reply_to);
                    return (
                      <ReplyContext
                        replyTo={m.reply_to} parent={parent} onJump={jumpTo}
                        author={parent ? shown(parent.sender) : undefined}
                        authorColor={parent ? color(parent.sender) : undefined}
                      />
                    );
                  })()}
                  {m.text.trim() !== '' && !(m.poll && m.text === m.poll.question) && (
                    <div className="md wrap-anywhere" {...{ [MESSAGE_TEXT_ATTRIBUTE]: m.id }}>
                      <MessageBody text={m.text} names={names} />
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
                  {m.decision && (
                    <DecisionCardView
                      card={m.decision}
                      me={me}
                      participants={participants}
                      onPosition={(cardId, stance, note) => { void recordDecisionPosition(cardId, stance, note); }}
                    />
                  )}
                  <MessageImages attachments={m.attachments ?? []} load={loadImage} />
                  {(() => {
                    const onToggle = (emoji: string, on: boolean) => { void toggleReaction(m, emoji, on); };
                    const ship = linksPullRequest(m.text);
                    return (
                      <ReactionBar message={m} me={me} participants={participants} onToggle={onToggle} hide={ship ? [SHIP_EMOJI] : []}>
                        {ship && <ShipIt message={m} me={me} participants={participants} onToggle={onToggle} />}
                      </ReactionBar>
                    );
                  })()}
                  <ReadReceipts messageId={m.id} reads={reads} participants={participants} me={me} />
                  <UnseenFlag message={m} reads={reads} participants={participants} now={unseenNow} />
                </div>
              </article>
            </div>
          );
        })}
      </main>
      </MentionColors.Provider>

      {statusBar}

      <footer className={`relative border-t px-4 py-2.5 ${dragging ? 'border-accent bg-panel' : 'border-line'}`}>
        {dragging && <div className="mb-1.5 text-[13px] text-accent">Drop the image to attach it.</div>}
        {setupError && <div role="alert" className="mb-1.5 text-[13px] text-bad">{setupError}</div>}
        {notice && <div className="mb-1.5 text-[13px] text-bad">{notice}</div>}
        {overLimit && <div className="mb-1.5 text-[13px] text-bad" role="alert">{overLimit}</div>}
        {(replyTo || quotes.length > 0 || drafts.length > 0) && (
          <ChipRow>
            {replyTo && <ReplyingTo parent={replyTo} author={shown(replyTo.sender)} onCancel={() => { setReplyTo(null); boxRef.current?.focus(); }} />}
            <QuoteChips quotes={quotes} onRemove={removeQuote} onEdit={editQuote} />
            <DraftChips drafts={drafts} onRemove={removeDraft} />
          </ChipRow>
        )}
        {commenting && !commenting.at && (
          <QuoteCommentBox key={commenting.key} quote={commenting.quote} editing onSubmit={finishQuote} onCancel={cancelQuote} />
        )}
        {pollOpen && (
          <PollComposer
            busy={pollBusy}
            error={pollError}
            onCancel={() => { setPollOpen(false); setPollError(''); }}
            onCreate={(question, options) => { void createPoll(question, options); }}
          />
        )}
        {decisionOpen && (
          <DecisionComposer
            busy={decisionBusy}
            error={decisionError}
            onCancel={() => { setDecisionOpen(false); setDecisionError(''); }}
            onCreate={(prompt) => { void createDecision(prompt); }}
          />
        )}
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea
            ref={boxRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={addressHint}
            aria-label={`Message in this room${me ? ` as ${shown(me)}` : ''}`}
            data-tour="box"
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (!files.length) return;
              e.preventDefault();
              addImages(files, true);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            className={`${FIELD} block min-h-[60px] w-full resize-none ${handle.kind === 'unknown' ? 'border-bad' : ''}`}
            aria-describedby={handle.kind === 'none' ? undefined : `handle-${room}`}
          />
          {/* What the @name at the start does, before Send: who it goes to, or that no one has that name. */}
          {handle.kind === 'known' && (
            <p id={`handle-${room}`} className="-mt-1 text-xs text-muted">
              <span className="font-semibold" style={{ color: color(handle.name) }}>→ {shown(handle.name)}</span>{' '}
              {participants.find((p) => p.name === handle.name)?.kind === 'agent' ? 'will be woken' : 'is addressed'}
            </p>
          )}
          {handle.kind === 'unknown' && (
            <p id={`handle-${room}`} role="status" className="-mt-1 text-xs text-bad">
              @{handle.typed}: no such participant.
              {handle.suggestion && (
                <>
                  {' '}Did you mean{' '}
                  <button
                    type="button" className="cursor-pointer border-none bg-transparent p-0 font-semibold underline"
                    style={{ color: color(handle.suggestion) }}
                    onClick={() => { setDraft((d) => d.replace(/^(\s*)@[A-Za-z0-9][A-Za-z0-9_-]*/, `$1@${handle.suggestion}`)); boxRef.current?.focus(); }}
                  >@{handle.suggestion}</button>?
                </>
              )}
            </p>
          )}
          <input
            ref={fileInput} type="file" accept={ACCEPT} multiple hidden
            onChange={(e) => { addImages(Array.from(e.target.files ?? [])); e.target.value = ''; }}
          />
          <ComposerTools
            to={to} onTo={setTo} recipients={participants.map((p) => ({ name: p.name, label: shown(p.name) }))}
            emoji={{ open: emojiOpen, onOpenChange: setEmojiOpen, onInsert: insertEmoji, boxRef }}
            image={{ disabled: drafts.length >= MAX_ATTACHMENTS_PER_MESSAGE, onPick: () => fileInput.current?.click() }}
            decision={{ open: decisionOpen, onToggle: () => { setDecisionOpen((v) => !v); setDecisionError(''); setPollOpen(false); } }}
            poll={{ open: pollOpen, onToggle: () => { setPollOpen((v) => !v); setPollError(''); setDecisionOpen(false); } }}
            expand={{ expanded, onToggle: () => { setExpanded((v) => !v); boxRef.current?.focus(); } }}
            send={{ disabled: !canSend, label: uploading ? 'Uploading…' : 'Send' }}
            // In split view the ring is shown once, in the leading pane: the guard is the hub's, not the room's.
            guard={lead && token ? <Guard api={api} participants={participants} /> : undefined}
            fieldClassName={FIELD} toolClassName={TOOL}
          />
        </form>
      </footer>
    </div>
  );
}
