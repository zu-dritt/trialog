'use client';

import { useState } from 'react';
import type { Message } from '../lib/core';
import type { Participant, Poll, Sender } from '../lib/shared';
import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX_LENGTH, POLL_QUESTION_MAX_LENGTH, colorOf, displayName } from '../lib/shared';

const FIELD = 'rounded-md border border-line bg-panel px-2 py-1.5';

/** Applies current poll tallies to messages already on the page, by message id. */
export function withPolls(messages: Message[], polls: Poll[]): Message[] {
  if (!polls.length) return messages;
  const byMessage = new Map(polls.map((p) => [p.message_id, p]));
  return messages.map((m) => {
    const poll = byMessage.get(m.id);
    return poll ? { ...m, poll } : m;
  });
}

export function myVote(poll: Poll, me: Sender | null): number | null {
  if (!me) return null;
  const found = poll.options.find((option) => option.voters.includes(me));
  return found ? found.index : null;
}

export function PollCard({
  poll,
  me,
  participants = [],
  onVote,
  onClose,
}: {
  poll: Poll;
  me: Sender | null;
  /** From GET /api/participants: gives each voter their colour. A voter who isn't on it is grey. */
  participants?: readonly Participant[];
  onVote?: (pollId: string, option: number | null) => void;
  onClose?: (pollId: string) => void;
}) {
  const mine = myVote(poll, me);
  const closed = poll.closed_at !== null;
  const canClose = Boolean(onClose && me === poll.creator && !closed);
  const total = poll.options.reduce((sum, option) => sum + option.votes, 0);

  return (
    <section className="mt-2 rounded-md border border-line bg-[#14171d] p-3" aria-label={`Poll: ${poll.question}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="m-0 text-sm font-semibold">{poll.question}</h3>
        {closed && <span className="text-xs font-semibold uppercase tracking-[.06em] text-muted">Closed</span>}
        <span className="text-xs text-muted">{total} {total === 1 ? 'vote' : 'votes'}</span>
      </div>
      <ul className="mt-2 m-0 flex list-none flex-col gap-1.5 p-0">
        {poll.options.map((option) => {
          const selected = mine === option.index;
          const label = `${option.index}. ${option.text}`;
          const voters = option.voters.map((name) => (
            <span key={name} className="font-semibold" style={{ color: colorOf(name, participants) }}>{displayName(name)}</span>
          ));
          const who = voters.length > 0 && (
            <span className="text-xs text-muted">
              {voters.map((node, i) => <span key={option.voters[i]}>{i > 0 ? ', ' : ''}{node}</span>)}
            </span>
          );
          const inner = (
            <>
              <span className="min-w-0 flex-1 text-left">
                <span className="mr-2 text-xs text-muted">{option.index}.</span>
                {option.text}
              </span>
              <span className="flex flex-none items-center gap-2 text-xs text-muted">
                {who}
                <span className="tabular-nums font-semibold text-fg">{option.votes}</span>
              </span>
            </>
          );
          return (
            <li key={option.index}>
              {closed || !onVote ? (
                <div className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${selected ? 'border-accent bg-panel' : 'border-line'}`}>
                  {inner}
                </div>
              ) : (
                <button
                  type="button"
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-fg hover:bg-panel ${selected ? 'border-accent bg-panel' : 'border-line bg-transparent'}`}
                  aria-pressed={selected}
                  aria-label={selected ? `Withdraw vote for ${label}` : `Vote for ${label}`}
                  onClick={() => onVote(poll.id, selected ? null : option.index)}
                >
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {canClose && (
        <button
          type="button"
          className="mt-2 cursor-pointer rounded-md border border-line bg-transparent px-2 py-1 text-xs text-muted hover:bg-panel hover:text-fg"
          onClick={() => onClose?.(poll.id)}
        >
          Close poll
        </button>
      )}
    </section>
  );
}

export function PollComposer({
  onCreate,
  onCancel,
  busy,
  error,
}: {
  onCreate: (question: string, options: string[]) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const trimmed = options.map((option) => option.replace(/[\r\n\t]+/g, ' ').trim());
  const filled = trimmed.filter(Boolean);
  const canSubmit = !busy
    && question.trim() !== ''
    && [...question.trim()].length <= POLL_QUESTION_MAX_LENGTH
    && filled.length >= POLL_MIN_OPTIONS
    && filled.length === new Set(filled).size
    && trimmed.every((option) => !option || [...option].length <= POLL_OPTION_MAX_LENGTH);

  return (
    <form
      id="poll-composer"
      className="mb-2 rounded-md border border-line bg-[#14171d] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onCreate(question.replace(/[\r\n\t]+/g, ' ').trim(), filled);
      }}
    >
      <div className="mb-2 text-sm font-semibold">New poll</div>
      <label className="block text-xs text-muted">
        Question
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={POLL_QUESTION_MAX_LENGTH}
          required
          autoFocus
          className={`${FIELD} mt-1 block w-full`}
        />
      </label>
      <fieldset className="mt-2 border-0 p-0">
        <legend className="mb-1 text-xs text-muted">Options ({POLL_MIN_OPTIONS}–{POLL_MAX_OPTIONS})</legend>
        {options.map((option, i) => (
          <div key={i} className="mb-1.5 flex gap-1.5">
            <label className="block min-w-0 flex-1 text-xs text-muted">
              <span className="sr-only">Option {i + 1}</span>
              <input
                value={option}
                onChange={(e) => setOptions((list) => list.map((item, j) => (j === i ? e.target.value : item)))}
                maxLength={POLL_OPTION_MAX_LENGTH}
                placeholder={`Option ${i + 1}`}
                className={`${FIELD} block w-full`}
              />
            </label>
            {options.length > POLL_MIN_OPTIONS && (
              <button
                type="button"
                className="cursor-pointer rounded-md border border-line px-2 text-xs text-muted hover:bg-panel"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </fieldset>
      {options.length < POLL_MAX_OPTIONS && (
        <button
          type="button"
          className="cursor-pointer rounded-md border border-line bg-transparent px-2 py-1 text-xs hover:bg-panel"
          onClick={() => setOptions((list) => [...list, ''])}
        >
          Add option
        </button>
      )}
      {error && <div className="mt-2 text-[13px] text-bad">{error}</div>}
      <div className="mt-3 flex gap-2">
        <button type="submit" className="cursor-pointer rounded-md border border-line bg-[#2a2f3a] px-3 py-[5px] hover:bg-[#343a47] disabled:opacity-50" disabled={!canSubmit}>
          {busy ? 'Creating…' : 'Create poll'}
        </button>
        <button type="button" className="cursor-pointer rounded-md border border-line bg-transparent px-3 py-[5px] hover:bg-panel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
