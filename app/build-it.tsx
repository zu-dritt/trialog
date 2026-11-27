'use client';

// «⚙️ Build it!» on an orchestrator message that does not name a pull request: one click makes a
// roadmap card at the top of Next (title from the first line, the full text as the description,
// pictures copied when they can be). It wakes no one. A second click does not make a second card;
// the button becomes a chip that links to the card. Only the orchestrator can press it.
import { useEffect, useState } from 'react';
import type { Message, Sender } from '../lib/core';
import type { RoadmapItem } from '../lib/roadmap';
import { buildChipText, cardHref, findBuiltCard, sourceMessageOf } from '../lib/build-it';
import type { Participant } from '../lib/shared';
type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;

export const BUILD_HELP = 'Turn this message into a roadmap card at the top of Next. It wakes no one.';
export const BUILD_HELP_DISABLED = 'Only the orchestrator can turn a message into a card.';

export function isOrchestrator(me: Sender | null, participants: readonly Participant[]): boolean {
  return me !== null && participants.some((p) => p.name === me && p.kind === 'human');
}

/** Whether this message should show the Build-it button: from the orchestrator, and it names no PR. */
export function isBuildableMessage(
  message: Pick<Message, 'sender' | 'text'>,
  participants: readonly Participant[],
  namesPr: boolean,
): boolean {
  return !namesPr && participants.some((p) => p.name === message.sender && p.kind === 'human');
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
    const abort = new AbortController();
    void api('/api/roadmap', { signal: abort.signal })
      .then((res) => (res.ok ? res.json() as Promise<{ items: RoadmapItem[] }> : null))
      .then((data) => {
        if (!data) return;
        const item = findBuiltCard(data.items, message.id) ?? data.items.find((i) => sourceMessageOf(i.note) === message.id);
        if (item) setExisting(item);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [api, card, message.id]);

  if (existing) {
    return (
      <a
        href={cardHref(existing.id)}
        data-build-card={existing.id}
        className="px-0.5 text-[12px] text-muted hover:text-fg"
        title={BUILD_HELP}
      >{buildChipText(existing.updated_at)}</a>
    );
  }

  return (
    <button
      type="button"
      data-build=""
      className={`rounded-full border px-2 py-0.5 text-[12px] ${can ? 'cursor-pointer border-line bg-transparent text-muted hover:bg-panel hover:text-fg' : 'cursor-default border-line bg-transparent text-muted opacity-50'}`}
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
            setExisting(item);
            onBuilt?.(item);
          })
          .finally(() => setBusy(false));
      }}
    >{busy ? '⚙️ Adding…' : '⚙️ Build it!'}</button>
  );
}
