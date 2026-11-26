// Limits and small pure helpers that the server and the page both use.
// Nothing from Node is imported here, so the page can load this file in the browser.

/** The three people who can post. `hub` is only used for the seeded welcome message. */
export const SENDERS = ['grok', 'claude', 'david'] as const;
export type Sender = (typeof SENDERS)[number];
export type Author = Sender | 'hub';
export const NAMES: Record<Author, string> = { grok: 'Grok', claude: 'Claude', david: 'David', hub: 'Hub' };

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
