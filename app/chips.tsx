'use client';

// The row above the message box. Everything that travels with the next message sits there as a
// chip: the message it answers, the quotes, the images. They are different things, but to the
// writer they are one kind of thing, a small item that can be taken off again, so they share one
// look and one remove button.
import type { ReactNode } from 'react';

export interface ChipProps {
  /** A small picture or sign in front of the text. It is decoration: the label says what the chip is. */
  visual?: ReactNode;
  /** One line of text. It is cut with an ellipsis when it is too long for the chip. */
  children: ReactNode;
  /** Shown as a tooltip, for what the one line can't hold. */
  title?: string;
  /** 'bad' marks a chip whose item will not be sent, such as a failed upload. */
  tone?: 'plain' | 'bad';
  onRemove: () => void;
  /** What the ✕ does, in words: read by screen readers and shown as its tooltip. */
  removeLabel: string;
  /**
   * When the chip can be opened (to look at what it holds, or to change it): what a click on the
   * chip does. The chip's sign and text then are one button, reachable with Tab and pressed with
   * Enter. The ✕ stays a button of its own next to it.
   */
  onOpen?: () => void;
  /** What opening does, in words. Needed with `onOpen`. */
  openLabel?: string;
}

export function Chip({ visual, children, title, tone = 'plain', onRemove, removeLabel, onOpen, openLabel }: ChipProps) {
  const sign = visual !== undefined && <span aria-hidden="true" className="flex flex-none items-center text-muted">{visual}</span>;
  const text = <span className="min-w-0 max-w-[min(20rem,48vw)] truncate" title={onOpen ? undefined : title}>{children}</span>;
  return (
    <li className={`flex h-[38px] max-w-full flex-none items-center gap-2 rounded-md border bg-panel py-1 pl-2 pr-1 text-[13px] ${tone === 'bad' ? 'border-bad' : 'border-line'}`}>
      {onOpen ? (
        <button
          type="button" onClick={onOpen} aria-label={openLabel} title={title ?? openLabel}
          className="flex min-w-0 cursor-pointer items-center gap-2 self-stretch rounded border-none bg-transparent p-0 text-left text-[13px] text-fg hover:text-white"
        >{sign}{text}</button>
      ) : <>{sign}{text}</>}
      <button
        type="button" onClick={onRemove} aria-label={removeLabel} title={removeLabel}
        className="flex-none cursor-pointer rounded border-none bg-transparent px-1 text-base leading-none text-muted hover:text-fg"
      >×</button>
    </li>
  );
}

/**
 * The row itself. The page renders it only when there is at least one chip. On a wide screen the
 * chips wrap onto further lines. On a phone they stay on one line that can be swiped sideways, so
 * a handful of chips doesn't push the stream off the screen.
 */
export function ChipRow({ children }: { children: ReactNode }) {
  return <ul className="mb-2 flex gap-2 overflow-x-auto sm:flex-wrap sm:overflow-x-visible" aria-label="Attached to this message">{children}</ul>;
}
