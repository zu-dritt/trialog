'use client';

// «⚙️ Build it!» on an orchestrator message that does not name a pull request: one click makes a
// roadmap card at the top of Next (title from the first line, the full text as the description,
// pictures copied when they can be). It wakes no one. A second click does not make a second card;
// the button becomes a chip that links to the card. Only the orchestrator can press it. The
// roadmap is loaded once and shared by every button on the page.
import { useEffect, useState } from 'react';
import type { Message, Sender } from '../lib/core';
import type { RoadmapItem } from '../lib/roadmap';
import { buildChipText, builtAtFromNote, cardHref, findBuiltCard } from '../lib/build-it';
import type { Participant } from '../lib/shared';
type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;

export const BUILD_HELP = 'Turn this message into a roadmap card at the top of Next. It wakes no one.';
export const BUILD_HELP_DISABLED = 'Only the orchestrator can turn a message into a card.';

/** Older than today (Europe/Zurich): the button stays quiet until hover or focus, so a long stream is not full of pills. */
export const BUILD_IT_QUIET_CLASS = 'max-sm:opacity-100 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100';

export function isOrchestrator(me: Sender | null, participants: readonly Participant[]): boolean {
  return me !== null && participants.some((p) => p.name === me && p.kind === 'human');
}

/** Whether this message should show the Build-it button: from the orchestrator, and it names no PR. */
export function isBuildableMessage(
  message: Pick<Message, 'sender' | 'text'>,
  participants: readonly Participant[],
  namesPr: boolean,
): boolean {
  // A go («🚀 Ship it! …», also the one a 🚀 on an agent's message sends, playground #1023) is an answer, not an idea to build.
  if (message.text.trimStart().startsWith('🚀 Ship it!')) return false;
  return !namesPr && participants.some((p) => p.name === message.sender && p.kind === 'human');
}

/** True when the message is from a calendar day before today in Europe/Zurich. */
export function isQuietBuildIt(created_at: string, now: number | Date = Date.now()): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date(created_at)) < fmt.format(new Date(now));
}

let cached: { api: ApiFn; promise: Promise<RoadmapItem[]> } | null = null;

/** One GET /api/roadmap for the whole page; every Build-it button shares the result. */
export function loadRoadmapOnce(api: ApiFn): Promise<RoadmapItem[]> {
  if (cached?.api === api) return cached.promise;
  const promise = api('/api/roadmap')
    .then((res) => (res.ok ? res.json() as Promise<{ items: RoadmapItem[] }> : Promise.reject(new Error('roadmap'))))
    .then((data) => data.items);
  cached = { api, promise };
  promise.catch(() => { if (cached?.promise === promise) cached = null; });
  return promise;
}

/** After a successful POST, so other buttons on the page see the new card without another GET. */
export function rememberBuiltCard(item: RoadmapItem): void {
  if (!cached) return;
  cached.promise = cached.promise.then((items) => {
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) return items.map((x, n) => (n === i ? item : x));
    return [item, ...items];
  }).catch(() => [item]);
}

/** For tests, so one case does not leak its cache into the next. */
export function resetRoadmapCache(): void {
  cached = null;
}

interface Props {
  message: Message;
  me: Sender | null;
  participants?: readonly Participant[];
  /** The existing card, when the parent already knows it (and in tests). */
  card?: RoadmapItem | null;
  api?: ApiFn;
  onBuilt?: (item: RoadmapItem) => void;
}

export function BuildIt({ message, me, participants = [], card = null, api, onBuilt }: Props) {
  const [existing, setExisting] = useState<RoadmapItem | null>(card);
  const [busy, setBusy] = useState(false);
  const can = isOrchestrator(me, participants);

  useEffect(() => { if (card) setExisting(card); }, [card]);
  useEffect(() => {
    if (card || !api) return undefined;
    let cancelled = false;
    void loadRoadmapOnce(api).then((items) => {
      if (cancelled) return;
      const item = findBuiltCard(items, message.id);
      if (item) setExisting(item);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [api, card, message.id]);

  if (existing) {
    const at = builtAtFromNote(existing.note) ?? existing.updated_at;
    return (
      <a
        href={cardHref(existing.id)}
        data-build-card={existing.id}
        className="px-0.5 text-[12px] text-muted hover:text-fg"
        title={BUILD_HELP}
      >{buildChipText(at)}</a>
    );
  }

  const quiet = isQuietBuildIt(message.created_at);
  const look = can
    ? `cursor-pointer border-line bg-transparent text-muted hover:bg-panel hover:text-fg${quiet ? ` ${BUILD_IT_QUIET_CLASS}` : ''}`
    : `cursor-default border-line bg-transparent text-muted ${quiet ? 'max-sm:opacity-50 opacity-0 group-hover:opacity-50 group-focus-within:opacity-50 focus-visible:opacity-50' : 'opacity-50'}`;
  return (
    <button
      type="button"
      data-build=""
      data-build-quiet={quiet ? '' : undefined}
      className={`rounded-full border px-2 py-0.5 text-[12px] ${look}`}
      aria-label={can ? `Build it. ${BUILD_HELP}` : BUILD_HELP_DISABLED}
      title={can ? BUILD_HELP : BUILD_HELP_DISABLED}
      disabled={!can || busy}
      onClick={() => {
        if (!can || !api || busy) return;
        setBusy(true);
        void api(`/api/messages/${message.id}/build-it`, { method: 'POST' })
          .then(async (res) => {
            if (!res.ok) return;
            const { item } = (await res.json()) as { item: RoadmapItem };
            rememberBuiltCard(item);
            setExisting(item);
            onBuilt?.(item);
          })
          .finally(() => setBusy(false));
      }}
    >{busy ? '⚙️ Adding…' : '⚙️ Build it!'}</button>
  );
}
