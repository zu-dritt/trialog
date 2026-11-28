'use client';

// A count chip in the message-box row for decisions still waiting on the person signed in
// (playground #1186, #1188). Tap opens the list (or the one card): Jump to it, or Agree here.
// It goes once they have answered. Agreeing is the same PUT as the card; the server refuses
// an agent Agree on a decision addressed to a human.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  openDecisionChipLabel, openDecisionsFor, promptPreview, type DecisionListing,
} from '../lib/open-decisions';
import type { Participant, Sender } from '../lib/shared';

export const OPEN_DECISIONS_POLL_MS = 15_000;

type ApiFn = (path: string, options?: RequestInit) => Promise<Response>;

export function OpenDecisionChip({
  listings,
  me,
  onJump,
  onAgree,
  agreeing = null,
}: {
  listings: readonly DecisionListing[];
  me: Sender;
  onJump: (messageId: number, room: string) => void;
  onAgree: (cardId: string) => void | Promise<void>;
  agreeing?: string | null;
}) {
  const open = openDecisionsFor(listings, me);
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!open.length) setMenu(false);
  }, [open.length]);

  if (!open.length) return null;
  const n = open.length;
  return (
    <div ref={root} className="relative flex-none" data-open-decisions={n}>
      <button
        type="button"
        className="cursor-pointer rounded-full border border-decision/60 bg-decision/10 px-2 py-0.5 text-[12px] font-semibold text-decision"
        aria-label={n === 1 ? '1 decision waiting on you' : `${n} decisions waiting on you`}
        aria-expanded={menu}
        aria-haspopup="dialog"
        title="Decisions waiting on you: jump to the card, or Agree here"
        onClick={() => setMenu((v) => !v)}
      >
        {openDecisionChipLabel(n)}
      </button>
      {menu && (
        <div
          role="dialog"
          aria-label="Decisions waiting on you"
          className="absolute bottom-[calc(100%+6px)] right-0 z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-md border border-line bg-panel p-2 shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:bottom-36 max-sm:w-auto"
        >
          {open.map((item) => (
            <div
              key={item.decision.id}
              data-open-decision={item.decision.id}
              className="flex items-start gap-2 border-b border-line py-2 first:pt-0 last:border-0 last:pb-0"
            >
              <p className="mb-0 min-w-0 flex-1 text-[13px] leading-snug">{promptPreview(item.decision.prompt)}</p>
              <button
                type="button"
                className="cursor-pointer rounded-md border border-line px-2 py-0.5 text-[12px] font-semibold"
                onClick={() => { onJump(item.decision.message_id, item.room); setMenu(false); }}
              >
                Jump
              </button>
              <button
                type="button"
                data-agree={item.decision.id}
                className="cursor-pointer rounded-md border border-decision/60 bg-decision/10 px-2 py-0.5 text-[12px] font-semibold text-decision disabled:opacity-50"
                disabled={agreeing === item.decision.id}
                onClick={() => { void onAgree(item.decision.id); }}
              >
                Agree
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Fetches GET /api/decisions and shows the chip when any card is still waiting on the caller. */
export function OpenDecisionChips({
  api,
  me,
  participants: _participants,
  onJump,
  onAgree,
}: {
  api: ApiFn | null;
  me: Sender | null;
  participants?: readonly Participant[];
  onJump: (messageId: number, room: string) => void;
  onAgree: (cardId: string) => Promise<void>;
}) {
  const [listings, setListings] = useState<DecisionListing[]>([]);
  const [agreeing, setAgreeing] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api || !me) return;
    try {
      const data = (await (await api('/api/decisions')).json()) as { decisions?: DecisionListing[] };
      setListings(data.decisions ?? []);
    } catch {
      /* keep the last list; the next poll retries */
    }
  }, [api, me]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => { if (!document.hidden) void load(); }, OPEN_DECISIONS_POLL_MS);
    return () => clearInterval(poll);
  }, [load]);

  if (!api || !me) return null;
  return (
    <OpenDecisionChip
      listings={listings}
      me={me}
      onJump={onJump}
      agreeing={agreeing}
      onAgree={async (id) => {
        setAgreeing(id);
        try {
          await onAgree(id);
          await load();
        } finally {
          setAgreeing(null);
        }
      }}
    />
  );
}
