'use client';

// A decision card: every participant is agreed or waiting. Agree is optional-note;
// Object requires a note that says why. When everyone has agreed the card turns green
// and the message appears in the Decisions list. The human's Agree counts as their decision.
import { useState } from 'react';
import type { Message } from '../lib/core';
import type { DecisionCard, DecisionStance, Participant, Sender } from '../lib/shared';
import { DECISION_HINT, HUMAN_DECISION_HINT, DECISION_NOTE_MAX_LENGTH, DECISION_PROMPT_MAX_LENGTH, colorOf, decisionIsAgreed, labelOf } from '../lib/shared';

const FIELD = 'rounded-md border border-line bg-panel px-2 py-1.5';
const ANSWER = 'cursor-pointer rounded-md border px-2.5 py-1 text-[13px] font-semibold disabled:opacity-50';

/** Applies current decision cards to messages already on the page, by message id. */
export function withDecisions(messages: Message[], cards: DecisionCard[]): Message[] {
  if (!cards.length) return messages;
  const byMessage = new Map(cards.map((c) => [c.message_id, c]));
  return messages.map((m) => {
    const decision = byMessage.get(m.id);
    return decision ? { ...m, decision } : m;
  });
}

export function DecisionComposer({
  busy,
  error,
  onCancel,
  onCreate,
}: {
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onCreate: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0 && [...trimmed].length <= DECISION_PROMPT_MAX_LENGTH && !busy;
  return (
    <form
      id="decision-composer"
      className="mb-2 rounded-md border border-line bg-[#14171d] p-3"
      onSubmit={(e) => { e.preventDefault(); if (canSubmit) onCreate(trimmed); }}
    >
      <label className="block text-xs font-semibold uppercase tracking-[.06em] text-muted" htmlFor="decision-prompt">Decision</label>
      <textarea
        id="decision-prompt"
        className={`${FIELD} mt-1 w-full text-[15px] leading-[1.5]`}
        rows={2}
        maxLength={DECISION_PROMPT_MAX_LENGTH}
        placeholder="What should we agree on?"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
        autoFocus
      />
      <p className="mb-0 mt-2 text-xs text-muted">{DECISION_HINT}</p>
      {error && <p className="mb-0 mt-1 text-[13px] text-bad" role="alert">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button type="submit" className="cursor-pointer rounded-md border border-line bg-panel px-2.5 py-1 text-[13px] font-semibold disabled:opacity-50" disabled={!canSubmit}>Ask</button>
        <button type="button" className="cursor-pointer rounded-md border border-transparent px-2.5 py-1 text-[13px] text-muted" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

export function DecisionCardView({
  card,
  me,
  participants = [],
  onPosition,
}: {
  card: DecisionCard;
  me: Sender | null;
  participants?: readonly Participant[];
  onPosition?: (cardId: string, stance: DecisionStance, note: string | null) => void;
}) {
  const roster = participants.map((p) => p.name);
  const agreed = Boolean(card.agreed_at) || decisionIsAgreed(card, roster);
  const byName = new Map(card.positions.map((p) => [p.participant, p]));
  const mine = me ? byName.get(me) : undefined;
  const [note, setNote] = useState(mine?.note ?? '');
  // The answer the reader gave last, as it is stored: its button is shown as the chosen one.
  const chosen = mine?.stance ?? null;
  const trimmed = note.trim() || null;
  const names = roster.length ? roster : [...new Set(card.positions.map((p) => p.participant))];

  const submit = (stance: DecisionStance) => {
    if (!onPosition || !me) return;
    if (stance === 'object' && !trimmed) return;
    onPosition(card.id, stance, trimmed);
  };

  return (
    <section
      className={`mt-2 rounded-md border p-3 ${agreed ? 'border-decision/60 bg-decision/10' : 'border-line bg-[#14171d]'}`}
      aria-label={`Decision: ${card.prompt}`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="m-0 text-[15px] font-semibold leading-[1.5]">{card.prompt}</h3>
        {agreed && <span className="text-xs font-semibold uppercase tracking-[.06em] text-decision">Agreed</span>}
      </div>
      <ul className="mt-2 m-0 flex list-none flex-col gap-1 p-0">
        {names.map((name) => {
          const pos = byName.get(name);
          const mark = !pos ? '…' : pos.stance === 'agree' ? '✓' : '✗';
          const noteText = pos?.note ? ` ${pos.note}` : '';
          return (
            <li key={name} className="text-[15px] leading-[1.5]">
              <span className="font-semibold" style={{ color: colorOf(name, participants) }}>{labelOf(name, participants)}</span>
              {' '}{mark}{noteText}
            </li>
          );
        })}
      </ul>
      {participants.some((p) => p.name === me && p.kind === 'human') && (
        <p className="mb-0 mt-2 text-xs text-muted">{HUMAN_DECISION_HINT}</p>
      )}
      <p className="mb-0 mt-2 text-xs text-muted">{DECISION_HINT}</p>
      {onPosition && me && !agreed && (
        <div className="mt-2 flex flex-col gap-2">
          <label className="block text-xs text-muted" htmlFor={`decision-note-${card.id}`}>Note (optional for Agree, required for Object)</label>
          <input
            id={`decision-note-${card.id}`}
            className={`${FIELD} w-full text-[15px]`}
            maxLength={DECISION_NOTE_MAX_LENGTH}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="And say why"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${ANSWER} ${chosen === 'agree' ? 'border-ok bg-ok/20 text-ok' : 'border-line bg-panel'}`}
              aria-pressed={chosen === 'agree'}
              data-tour="agree"
              onClick={() => submit('agree')}
            >Agree</button>
            <button
              type="button"
              className={`${ANSWER} ${chosen === 'object' ? 'border-bad bg-bad/20 text-bad' : 'border-line'}`}
              aria-pressed={chosen === 'object'}
              disabled={!trimmed}
              onClick={() => submit('object')}
            >Object, and say why</button>
          </div>
        </div>
      )}
    </section>
  );
}
