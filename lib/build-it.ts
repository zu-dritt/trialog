// «⚙️ Build it!»: turn an orchestrator message that does not name a pull request into a roadmap
// card at the top of Next. One click, no hub message (so nobody is woken). A second click returns
// the same card. The note «from #N» is how the card is found again (a source-message column would
// be sturdier if the note is later edited away).
import { ROADMAP_DESCRIPTION_MAX, ROADMAP_PICTURES_MAX, ROADMAP_TITLE_MAX, type RoadmapItem } from './roadmap';
import type { Message, Sender } from './core';
import type { Store } from './store';

/** The identifying prefix, with an optional click time so the chip stays put after later edits. */
export const BUILD_NOTE = (id: number, at?: string): string => (at ? `from #${id} at ${at}` : `from #${id}`);
const SOURCE_NOTE = /^from #(\d+)\b/;
const BUILT_AT = /^from #\d+ at (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*$/;

/** The message a Build-it card came from, or null when the note does not start with «from #N». */
export function sourceMessageOf(note: string): number | null {
  const m = SOURCE_NOTE.exec(note.trim());
  return m ? Number(m[1]) : null;
}

/** The click time written into the note, when present. */
export function builtAtFromNote(note: string): string | undefined {
  return BUILT_AT.exec(note.trim())?.[1];
}

/** The first non-empty line, trimmed, at most 80 characters; «Message #N» when the text is empty. */
export function titleFromMessage(text: string, messageId: number, max = ROADMAP_TITLE_MAX): string {
  const first = (text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '');
  const chars = [...first];
  const title = chars.length > max ? chars.slice(0, max).join('') : first;
  return title || `Message #${messageId}`;
}

/** The message in full, with the same rules as a card description (line breaks kept, at most 4000). */
export function descriptionFromMessage(text: string, max = ROADMAP_DESCRIPTION_MAX): string {
  const t = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/\n{4,}/g, '\n\n\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim();
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max).join('') : t;
}

export function findBuiltCard(items: readonly RoadmapItem[], messageId: number): RoadmapItem | undefined {
  return items.find((i) => sourceMessageOf(i.note) === messageId);
}

/** HH:MM in Europe/Zurich, the same clock the hub uses for a message's time. */
export function formatClock(iso: string): string {
  return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** The Ship-it chip: a go, or «shipped» only when that pull request is known to be merged. */
export function shipChipText(label: string, at?: string, merged?: boolean): string {
  const time = at ? ` · ${formatClock(at)}` : '';
  return merged ? `🚀 shipped${time}` : `🚀 go from ${label}${time}`;
}

/** The Build-it chip, after a card exists. */
export function buildChipText(at?: string): string {
  return at ? `⚙️ go to build · ${formatClock(at)} → card` : '⚙️ go to build → card';
}

export const cardHref = (id: string): string => `/roadmap#${id}`;

export type BuildItResult =
  | { status: 'created'; item: RoadmapItem }
  | { status: 'exists'; item: RoadmapItem }
  | { status: 'not_found' }
  | { status: 'names_pr' }
  | { status: 'not_from_orchestrator' }
  | { status: 'full' };

/**
 * Finds or creates the Next card for this message. Pictures are copied (a message's own uploads
 * cannot also sit on a card); if a copy cannot be made, the card is still created without them.
 * The check-and-create runs inside the store's roadmap lock, so two posts at the same moment
 * return the same card.
 */
export async function buildItFromMessage(
  store: Store,
  input: { messageId: number; by: Sender; humans: readonly string[]; namesPr: boolean },
): Promise<BuildItResult> {
  const [message] = await store.listMessagesByIds([input.messageId]);
  if (!message) return { status: 'not_found' };
  if (!input.humans.includes(message.sender)) return { status: 'not_from_orchestrator' };
  if (input.namesPr) return { status: 'names_pr' };
  const existing = findBuiltCard(await store.listRoadmap(), input.messageId);
  if (existing) return { status: 'exists', item: existing };
  const copies = await copyPictures(store, message, input.by);
  const note = BUILD_NOTE(message.id, new Date().toISOString());
  const add = (attachments: string[]) => store.addRoadmapItemOnce({
    column: 'next',
    title: titleFromMessage(message.text, message.id),
    note,
    owner: null,
    by: input.by,
    description: descriptionFromMessage(message.text),
    attachments,
    top: true,
    sameAs: (item) => sourceMessageOf(item.note) === message.id,
  });
  try {
    const result = await add(copies);
    if (!result) return { status: 'full' };
    return { status: result.created ? 'created' : 'exists', item: result.item };
  } catch {
    const result = await add([]);
    if (!result) return { status: 'full' };
    return { status: result.created ? 'created' : 'exists', item: result.item };
  }
}

async function copyPictures(store: Store, message: Message, by: Sender): Promise<string[]> {
  const copies: string[] = [];
  for (const a of (message.attachments ?? []).slice(0, ROADMAP_PICTURES_MAX)) {
    const got = await store.getAttachment(a.id);
    if (!got) continue;
    // Server-side copies of pictures already on the message: not a new user upload, so the
    // per-hour cap does not apply. 10 000 is high enough that a card's few pictures always go through.
    const copy = await store.addAttachment({
      sender: by,
      content_type: got.attachment.content_type,
      width: got.attachment.width,
      height: got.attachment.height,
      data: got.data,
      scale: got.attachment.scale,
    }, 10_000);
    if (copy) copies.push(copy.id);
  }
  return copies;
}
