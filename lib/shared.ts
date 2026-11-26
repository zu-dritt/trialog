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

/** How a name is shown: "grok" → "Grok", "ana-maria" → "Ana-Maria". Works for any stored name. */
export function displayName(name: string): string {
  return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
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
}

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4 MB per image, on every path (upload and storage)
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/** The page shrinks an image that is over the size limit until its long edge is at most this many pixels. */
export const DOWNSIZE_LONG_EDGE = 2560;

/** How an image appears in the export and in the CLI: "[image: att_…, 1170×2532]". */
export const attachmentLabel = (a: Pick<Attachment, 'id' | 'width' | 'height'>): string => `[image: ${a.id}, ${a.width}×${a.height}]`;

/** The first line of a message, for the list of decisions. An image-only message shows its images instead. */
export function firstLine(m: { text: string; attachments?: Pick<Attachment, 'id' | 'width' | 'height'>[] }, max: number): string {
  const line = m.text.trim().split('\n')[0].slice(0, max);
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
