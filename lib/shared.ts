// Limits and small pure helpers that the server and the page both use.
// Nothing from Node is imported here, so the page can load this file in the browser.

/**
 * A participant's name, as it is configured in PARTICIPANTS (lib/participants.ts) and stored with
 * every message. Which names exist is a setting, so this is a string and not a fixed list.
 */
export type Sender = string;
/** A participant, or `hub`, which is only used for the seeded welcome message. */
export type Author = string;

/** Lowercase, starts with a letter, then letters, digits or "-", at most 24 characters. The database checks the same shape. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
/** Names no participant can have: they mean "everyone" as a recipient, or belong to the hub itself. */
export const RESERVED_NAMES: readonly string[] = ['all', 'everyone', 'hub', 'system'];

export type ParticipantKind = 'human' | 'agent';
/** One participant as GET /api/participants returns it. `color` is an index into PARTICIPANT_COLORS. */
export interface Participant {
  name: Sender;
  kind: ParticipantKind;
  color: number;
  /**
   * How the participant is shown: the third part of their PARTICIPANTS entry, or else their name
   * with a capital ("grok" → "Grok"). Only for showing: the name stays the id everywhere (tokens,
   * the sender of a message, "@name", the API, the database).
   */
  label?: string;
}

/** A label has 1 to 24 characters: letters, digits, spaces and "-", and starts and ends with a letter or digit. */
export const LABEL_MAX_LENGTH = 24;
const LABEL_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N} -]*[\p{L}\p{N}])?$/u;
/** Whether a label can be used. */
export const validLabel = (label: string): boolean => LABEL_PATTERN.test(label) && [...label].length <= LABEL_MAX_LENGTH;

/**
 * How a name is shown on the page and in hub.js: the participant's label when the hub gives one,
 * otherwise the name with a capital. Also right for the hub and for former participants, who have no label.
 */
export function labelOf(name: string, participants: readonly Pick<Participant, 'name' | 'label'>[]): string {
  return participants.find((p) => p.name === name)?.label || displayName(name);
}

/**
 * Twelve colours that read well on the page's dark background, handed out in the order of the
 * PARTICIPANTS setting. The first three are the colours the three default participants always had;
 * the other nine were picked to be as far from those, and from each other, as the page allows
 * (tests/participants.test.ts checks contrast and distance).
 */
export const PARTICIPANT_COLORS: readonly string[] = [
  '#f0883e', '#c792ea', '#4fb3ff', '#44e444', '#44e4c4', '#ecec79',
  '#ec7990', '#d5b990', '#77c464', '#e85ee8', '#59bdcf', '#ace444',
];
/** For the hub's welcome message, and for anyone who wrote here once and is no longer a participant. */
export const NEUTRAL_COLOR = '#7d8590';

/** The colour of a name: the participant's own, or the neutral one for the hub and for former participants. */
export function colorOf(name: string, participants: readonly Participant[]): string {
  const found = participants.find((p) => p.name === name);
  return (found && PARTICIPANT_COLORS[found.color]) || NEUTRAL_COLOR;
}

/**
 * The two rules for how a message starts, for the configured names: "@name" addresses someone,
 * and "DECISION:" (after an optional "@name") makes it a decision. The server reads a message by
 * these patterns, and the page uses the same ones, so the two can't disagree.
 *
 * A name counts only when no letter, digit or "_" follows it, so "@grokbot" addresses nobody.
 * Longer names are tried first, so with "ana" and "ana-maria" both configured, "@ana-maria" means
 * the second. The name may be written in any case when addressing; in front of DECISION: it is
 * case-sensitive, as it was before the names were configurable.
 */
export function addressing(names: readonly string[]): { mention: RegExp; decision: RegExp } {
  // Only well-formed names take part. They hold letters, digits and "-", so they need no escaping.
  const known = names.filter((name) => NAME_PATTERN.test(name)).sort((a, b) => b.length - a.length);
  const any = known.length ? known.join('|') : '(?!)'; // with no names, nothing is a name
  const end = '(?![A-Za-z0-9_])';
  return {
    mention: new RegExp(`^\\s*@(${any})${end}`, 'i'),
    decision: new RegExp(`^\\s*(?:@(?:${any})${end}[\\s,:]*)?DECISION:`),
  };
}

/** How a name is shown: "grok" → "Grok", "ana-maria" → "Ana-Maria". Works for any stored name. */
export function displayName(name: string): string {
  return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
}

// --- rooms --------------------------------------------------------------------------------------
// A hub has one stream per room. Every participant sees every room. The room `main` always exists,
// and a call that names no room means `main`, so a client from before rooms keeps working.

/** The room that always exists. */
export const MAIN_ROOM = 'main';
/** The id of a room has the shape of a participant's name: lowercase, starts with a letter, at most 24 characters. */
export const ROOM_ID_PATTERN = NAME_PATTERN;
/** What a reader passes as the room to get every room at once. No room can have this id. */
export const ALL_ROOMS = 'all';
export const RESERVED_ROOM_IDS: readonly string[] = [ALL_ROOMS];
export const ROOM_NAME_MAX_LENGTH = 40;
/** A hub has at most this many rooms, `main` included. */
export const MAX_ROOMS = 12;

export interface Room {
  id: string;
  /** What the page shows on the tab. */
  name: string;
  created_at: string;
  /** The participant who created it; `hub` for `main`. */
  created_by: Author;
  /** The id of the newest message in the room, or 0 when it has none. */
  last_id: number;
  /** Only when the caller said what they have seen: messages by others that are newer than that. */
  unread?: number;
}

/**
 * An id for a room, made from its name: "Calm talk" → "calm-talk", "Büro 2" → "buro-2".
 * Returns '' when nothing of the name can be used, and then the writer has to give an id.
 */
export function roomIdFromName(name: string): string {
  const plain = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const slug = plain.replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 24).replace(/-+$/, '');
  return ROOM_ID_PATTERN.test(slug) ? slug : '';
}

/** A room's name as it is stored: one line, trimmed. Returns null when it is empty, too long or not plain text. */
export function cleanRoomName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!name || /[\x00-\x1f\x7f]/.test(name) || [...name].length > ROOM_NAME_MAX_LENGTH) return null;
  return name;
}

/**
 * What a caller has seen, per room, as it travels in a query: "main:120,dev:45" (the id of the
 * newest message seen in each room). `parseSeen` returns null for anything else.
 */
export function formatSeen(seen: Readonly<Record<string, number>>): string {
  return Object.entries(seen).filter(([room, id]) => ROOM_ID_PATTERN.test(room) && Number.isSafeInteger(id) && id >= 0)
    .map(([room, id]) => `${room}:${id}`).join(',');
}
export function parseSeen(value: string): Record<string, number> | null {
  const seen: Record<string, number> = {};
  if (value.trim() === '') return seen;
  const parts = value.split(',');
  if (parts.length > MAX_ROOMS * 2) return null;
  for (const part of parts) {
    const m = /^([a-z][a-z0-9-]{0,23}):(\d{1,15})$/.exec(part.trim());
    if (!m) return null;
    seen[m[1]] = Number(m[2]);
  }
  return seen;
}

export const STATUS_MAX_LENGTH = 80;
export const STATUS_DEFAULT_TTL_SECONDS = 300;
export const STATUS_MIN_TTL_SECONDS = 30;
export const STATUS_MAX_TTL_SECONDS = 1800;

export interface ParticipantStatus {
  participant: Sender;
  text: string;
  expires_at: string;
  updated_at: string;
}

export const POLL_QUESTION_MAX_LENGTH = 200;
export const POLL_OPTION_MAX_LENGTH = 80;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
/** Ids look like poll_3f9c… (24 hex digits). The pattern is a little wider so the format can grow. */
export const POLL_ID = /^poll_[a-z0-9]{8,48}$/;

export interface PollOption {
  /** 1-based, in the order the creator gave. */
  index: number;
  text: string;
  votes: number;
  voters: Sender[];
}

/** A poll attached to a message, including the current tally. */
export interface Poll {
  id: string;
  message_id: number;
  creator: Sender;
  question: string;
  options: PollOption[];
  closed_at: string | null;
  created_at: string;
}

/** Shown on every poll card, and in the API docs. A vote is not a decision. */
export const VOTE_HINT = 'A vote is an opinion, not a decision. To decide, write DECISION:';

/** Closed polls older than this are omitted from the opt-in GET /api/messages?polls=1 list. */
export const RECENTLY_CLOSED_MS = 24 * 60 * 60 * 1000;

/** The message posted when a poll is closed: the question, then each option with its count and voters. */
export function pollResultText(poll: Poll): string {
  const lines = [`Poll closed: ${poll.question}`];
  for (const option of poll.options) {
    const votes = `${option.votes} ${option.votes === 1 ? 'vote' : 'votes'}`;
    const who = option.voters.map(displayName).join(', ');
    lines.push(who ? `${option.index}. ${option.text} — ${votes} (${who})` : `${option.index}. ${option.text} — ${votes}`);
  }
  return lines.join('\n');
}


/** Shown on every decision card. An Agree is not a written go for production. */
export const DECISION_HINT = 'An Agree never replaces a written go on an exact version for a production deploy or a database change on main.';

/** Shown on a decision card to a human, next to the production line. Agents do not see this. */
export const HUMAN_DECISION_HINT = 'Your Agree here counts as your decision.';

export const DECISION_PROMPT_MAX_LENGTH = 200;
export const DECISION_NOTE_MAX_LENGTH = 200;
export const DECISION_ID = /^decision_[a-z0-9]{8,48}$/;

export type DecisionStance = 'agree' | 'object';

export interface DecisionPosition {
  participant: Sender;
  stance: DecisionStance;
  /** Present when the participant wrote one. Empty or omitted when they did not. */
  note: string | null;
  updated_at: string;
}

export interface DecisionCard {
  id: string;
  message_id: number;
  creator: Sender;
  prompt: string;
  created_at: string;
  /** Set when every current participant has agreed; cleared if that stops being true. */
  agreed_at: string | null;
  positions: DecisionPosition[];
}

/** True when every name in `roster` has agreed. A missing or objecting participant means it is not agreed. */
export function decisionIsAgreed(card: Pick<DecisionCard, 'positions'>, roster: readonly string[]): boolean {
  if (!roster.length) return false;
  const byName = new Map(card.positions.map((p) => [p.participant, p]));
  return roster.every((name) => byName.get(name)?.stance === 'agree');
}

/** The message posted when someone agrees or objects. A repeated identical position posts nothing. */
export function decisionPositionText(
  stance: DecisionStance,
  note: string | null,
  consensus: 'agreed' | 'broken' | null = null,
): string {
  const line = stance === 'agree' ? (note ? `Agree: ${note}` : 'Agree.') : `Object: ${note}`;
  if (consensus === 'agreed') return `${line}\n\nEveryone has agreed.`;
  if (consensus === 'broken') return `${line}\n\nThis is no longer agreed.`;
  return line;
}

/** How long a message addressed to agents may go unread by them before the page flags it. */
export const UNSEEN_AFTER_MS = 2 * 60 * 1000;

/** The short label on a message that no addressed agent has read after UNSEEN_AFTER_MS. */
export const UNSEEN_LABEL = '⏰ not seen yet';

/** One participant's read position: the highest message id they have read. No room field. */
export interface ReadPosition {
  participant: Sender;
  /** The room this position is in. A participant has one position per room; `main` for every position from before rooms. */
  room: string;
  up_to: number;
  updated_at: string;
}

/**
 * The agents a message was addressed to, for the "not seen yet" flag. A message to everyone
 * addresses every agent except its writer. A message to one agent addresses only that agent.
 * A message only to a human, or from the hub, addresses no agent.
 */
export function addressedAgents(
  message: { sender: string; recipient: string | null },
  participants: readonly Participant[],
): string[] {
  if (message.sender === 'hub') return [];
  const agents = participants.filter((p) => p.kind === 'agent').map((p) => p.name);
  if (message.recipient === null) return agents.filter((name) => name !== message.sender);
  return agents.includes(message.recipient) ? [message.recipient] : [];
}

/**
 * The addressed agents who have not yet read past this message, once it is older than two
 * minutes. Empty when the message is too new, is not addressed to any agent, or every
 * addressed agent has already read it.
 */
export function unseenAgents(
  message: { id: number; sender: string; recipient: string | null; created_at: string },
  reads: readonly ReadPosition[],
  participants: readonly Participant[],
  now: number,
): string[] {
  const agents = addressedAgents(message, participants);
  if (!agents.length) return [];
  if (now - Date.parse(message.created_at) < UNSEEN_AFTER_MS) return [];
  const byName = new Map(reads.map((r) => [r.participant, r.up_to]));
  return agents.filter((name) => (byName.get(name) ?? 0) < message.id);
}

/** "Grok", "Grok and Claude", "Grok, Claude and Quill-2". */
export function joinNames(names: readonly string[], participants: readonly Pick<Participant, 'name' | 'label'>[] = []): string {
  const shown = names.map((name) => labelOf(name, participants));
  if (shown.length <= 1) return shown[0] ?? '';
  if (shown.length === 2) return `${shown[0]} and ${shown[1]}`;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * True when a message was addressed to at least one agent, is older than two minutes, and
 * none of those agents has a read position at or past it. Derived only from the positions
 * and the recipients; it does not change who is woken.
 */
export function unseenByAgents(
  message: { id: number; sender: string; recipient: string | null; created_at: string },
  reads: readonly ReadPosition[],
  participants: readonly Participant[],
  now: number,
): boolean {
  const agents = addressedAgents(message, participants);
  return agents.length > 0 && unseenAgents(message, reads, participants, now).length === agents.length;
}

/**
 * The flag text, naming who has not seen the message, or null when the flag should not show.
 * The flag still disappears once any addressed agent has read past the message.
 */
export function unseenFlagText(
  message: { id: number; sender: string; recipient: string | null; created_at: string },
  reads: readonly ReadPosition[],
  participants: readonly Participant[],
  now: number,
): string | null {
  if (!unseenByAgents(message, reads, participants, now)) return null;
  const names = unseenAgents(message, reads, participants, now);
  return names.length ? `⏰ not seen by ${joinNames(names, participants)} yet` : UNSEEN_LABEL;
}

/** Merge incoming read positions into a list, never moving a participant backwards. */
export function applyReads(list: ReadPosition[], incoming: ReadPosition[]): ReadPosition[] {
  if (!incoming.length) return list;
  const byName = new Map(list.map((r) => [r.participant, r]));
  for (const r of incoming) {
    const prev = byName.get(r.participant);
    if (!prev || r.up_to >= prev.up_to) byName.set(r.participant, r);
  }
  return [...byName.values()].sort((a, b) => a.participant.localeCompare(b.participant));
}

/** The image types Trialog accepts. An upload is recognised by its first bytes, never by a name or header. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** An image attached to a message. The bytes are fetched from GET /api/attachments/<id>. */
export interface Attachment {
  id: string;
  content_type: ImageType;
  width: number;
  height: number;
  bytes: number;
  /**
   * How many image pixels make one point on the screen the image was taken on: 1 for an ordinary
   * image, 2 or more for a screenshot from a high-density screen. Only used to decide how large the
   * image is shown (see ownSize). Images stored before this field existed have 1.
   */
  scale: number;
}

/** The largest scale an image can be stored with. */
export const MAX_SCALE = 4;
/** The largest scale a client may suggest with an upload (SCALE_HINT_HEADER). */
export const MAX_SCALE_HINT = 3;
/**
 * A client that knows the screen an image was taken on may say so with an upload: "1", "2" or "3".
 * The page sends it for an image pasted from the clipboard, where the file no longer says. It is
 * only ever used for how large the image is shown.
 */
export const SCALE_HINT_HEADER = 'X-Image-Scale';

/** A stored or received scale as a whole number from 1 to MAX_SCALE; anything else counts as 1. */
export const validScale = (scale: unknown): number =>
  (typeof scale === 'number' && Number.isInteger(scale) && scale >= 1 && scale <= MAX_SCALE ? scale : 1);

/**
 * The size an image has on a page, in CSS pixels: its pixels divided by its scale, rounded down so
 * it is never a fraction of a pixel larger than that. An image is never shown larger than this,
 * except when the reader asks to see every pixel.
 */
export function ownSize(a: { width: number; height: number; scale?: unknown }): { width: number; height: number } {
  const scale = validScale(a.scale);
  return { width: Math.max(1, Math.floor(a.width / scale)), height: Math.max(1, Math.floor(a.height / scale)) };
}

/**
 * The scale a file's recorded density stands for, or null when it says nothing useful. Screens are
 * counted in multiples of 72 dots per inch: a screenshot from a high-density screen is saved with
 * 144 (scale 2), 216 (3) or 288 (4). 72, 96 and no value at all are what any ordinary file has, and
 * print densities such as 300 say nothing about a screen.
 */
export function scaleFromDensity(dpi: number | null | undefined): number | null {
  if (typeof dpi !== 'number' || !Number.isFinite(dpi)) return null;
  const scale = Math.round(dpi / 72);
  return scale >= 2 && scale <= MAX_SCALE && Math.abs(dpi - scale * 72) <= 2 ? scale : null;
}

/** Reads a scale hint: exactly "1", "2" or "3". Anything else is no hint (null), never an error. */
export function parseScaleHint(value: string | null | undefined): number | null {
  return typeof value === 'string' && /^[1-3]$/.test(value.trim()) ? Number(value.trim()) : null;
}

/**
 * The density a PNG file records (its pHYs chunk), in dots per inch, or null. The page uses this
 * for a file it has to shrink before upload: drawing an image smaller loses what the file said.
 * `bytes` only needs to hold the start of the file.
 */
export function pngDensity(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || signature.some((b, i) => bytes[i] !== b)) return null;
  // Chunks: 4 bytes length, 4 bytes type, the data, 4 bytes checksum. pHYs comes before the pixels (IDAT).
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (type === 'IDAT' || type === 'IEND') return null;
    if (type === 'pHYs') {
      if (length !== 9 || at + 8 + 9 > bytes.length) return null;
      const perUnit = view.getUint32(at + 8);
      const unit = bytes[at + 16]; // 1: the unit is the metre; 0: only the shape of a pixel is known
      return unit === 1 && perUnit > 0 ? perUnit * 0.0254 : null;
    }
    at += 12 + length;
  }
  return null;
}

/**
 * How to shrink an image that is over the size limit: the new size in pixels and the scale that
 * goes with it. When the image has a scale above 1, it is shrunk to a whole fraction of it if that
 * is enough, so it keeps exactly the size it has on the page (5120×2880 at scale 2 becomes
 * 2560×1440 at scale 1: both are 2560×1440 on the page). Otherwise the long edge is brought to
 * `maxEdge` at scale 1, as before.
 */
export function downsizePlan(width: number, height: number, scale: number, maxEdge: number): { width: number; height: number; scale: number } {
  const from = validScale(scale);
  for (let to = Math.min(from, MAX_SCALE_HINT); to >= 1; to--) {
    const w = Math.max(1, Math.round((width * to) / from));
    const h = Math.max(1, Math.round((height * to) / from));
    if (Math.max(w, h) <= maxEdge) return { width: w, height: h, scale: to };
  }
  return { ...fitWithin(width, height, maxEdge, maxEdge), scale: 1 };
}

export const MAX_TEXT_BYTES = 20 * 1024; // 20 KB per message
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4 MB per image, on every path (upload and storage)
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/** The page shrinks an image that is over the size limit until its long edge is at most this many pixels. */
export const DOWNSIZE_LONG_EDGE = 2560;

/** How an image appears in the export and in the CLI: "[image: att_…, 1170×2532]". */
export const attachmentLabel = (a: Pick<Attachment, 'id' | 'width' | 'height'>): string => `[image: ${a.id}, ${a.width}×${a.height}]`;

/**
 * The first line of a message, for the list of decisions. A message that opens with quotes is
 * shown by the first line its writer wrote, not by the quote; only when there is nothing but
 * quotes is it the quote's first line. An image-only message shows its images instead.
 */
export function firstLine(m: { text: string; attachments?: Pick<Attachment, 'id' | 'width' | 'height'>[] }, max: number): string {
  const lines = m.text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const line = (lines.find((l) => !l.startsWith('>')) ?? lines[0] ?? '').slice(0, max);
  return line || (m.attachments ?? []).map(attachmentLabel).join(' ');
}

/**
 * The largest size with the same shape that fits inside maxWidth × maxHeight.
 * Never enlarges, and never returns less than one pixel a side.
 */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
