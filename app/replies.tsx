'use client';

// Replies on the page. A message can answer an earlier one (`reply_to`). The stream stays one flat
// list: a reply simply shows, above its text, one line of the message it answers, and a click on
// that line goes to the message. Nothing is collapsed and there is no separate thread view.
//
// The excerpt is shown as plain text. It is never rendered as Markdown, so nothing in the
// answered message can turn into markup here.
import { attachmentLabel, type Attachment } from '../lib/shared';

/** What this file needs to know about a message. */
export interface ReplyParent {
  id: number;
  text: string;
  attachments?: Pick<Attachment, 'id' | 'width' | 'height'>[];
}

const MARKERS = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/;

/**
 * One line that stands for a message: its first line that says something. Lines of a quote
 * (starting with ">") and empty lines are skipped, since a message often opens with what it
 * answers; a list or heading mark at the start is dropped. An image-only message is named by its
 * images. Longer text is cut with an ellipsis.
 */
export function replyExcerpt(m: ReplyParent, max = 120): string {
  const lines = m.text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && line !== '```' && !/^```\w*$/.test(line));
  const own = lines.find((line) => !line.startsWith('>')) ?? lines[0]?.replace(/^(>\s*)+/, '') ?? '';
  const line = own.replace(MARKERS, '').trim() || (m.attachments ?? []).map(attachmentLabel).join(' ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The Reply action in a message's header line. */
export function ReplyButton({ messageId, onReply, className }: { messageId: number; onReply: () => void; className: string }) {
  const label = `Reply to message #${messageId}`;
  return <button type="button" aria-label={label} title={label} onClick={onReply} className={className}>Reply</button>;
}

/**
 * Above a reply in the stream: one line of the message it answers. A click goes there. When that
 * message is not among the ones loaded on the page, only its number is shown.
 */
export function ReplyContext({ replyTo, parent, author, authorClass, onJump }: {
  replyTo: number;
  parent: ReplyParent | undefined;
  /** The display name of the parent's writer. */
  author?: string;
  authorClass?: string;
  onJump: (id: number) => void;
}) {
  if (!parent) {
    return <div className="text-xs text-muted" title={`Message #${replyTo} is not loaded on this page`}>↳ in reply to #{replyTo}</div>;
  }
  const excerpt = replyExcerpt(parent);
  return (
    <button
      type="button" onClick={() => onJump(parent.id)}
      aria-label={`In reply to message #${parent.id}${author ? ` by ${author}` : ''}. Go to it. It says: ${excerpt}`}
      title={`Go to message #${parent.id}`}
      className="mb-0.5 block max-w-full cursor-pointer truncate rounded border-none bg-transparent p-0 text-left text-xs text-muted hover:text-fg"
    >
      <span aria-hidden="true">↳ </span>
      <span className={`font-bold ${authorClass ?? ''}`}>{author}</span> <span>#{parent.id}</span> <span>{excerpt}</span>
    </button>
  );
}

/** In the composer while a reply is being written: whom it answers, and a way out. */
export function ReplyingTo({ parent, author, onCancel }: { parent: ReplyParent; author: string; onCancel: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border border-line bg-panel py-1 pl-2.5 pr-1.5 text-[13px]" role="group" aria-label="Reply">
      <span className="min-w-0 flex-1 truncate">
        Replying to <span className="font-bold">{author}</span>, #{parent.id}<span className="text-muted">: {replyExcerpt(parent)}</span>
      </span>
      <button
        type="button" onClick={onCancel} aria-label="Cancel the reply" title="Cancel the reply"
        className="cursor-pointer rounded border-none bg-transparent px-1 text-base leading-none text-muted hover:text-fg"
      >×</button>
    </div>
  );
}
