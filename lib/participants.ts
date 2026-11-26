// Who takes part in this hub. One setting decides it:
//
//   PARTICIPANTS=ana:human,ben:human,scout:agent,quill:agent
//
// a comma-separated list of name:kind, where kind is "human" or "agent". Each participant's token
// is read from <NAME>_TOKEN (the name in upper case, "-" written as "_").
//
// Without the setting, the three participants this project started with apply, and their tokens
// are treated as leniently as they always were (a missing token just never matches), so a
// deployment from before the setting existed runs unchanged.
//
// With the setting, nothing is guessed: a malformed list, or a participant without a usable token,
// throws a ConfigError, and every API request answers 500 with its message (lib/http.ts). The
// messages name the problem and the setting to fix. They never repeat a token, and they never
// repeat a piece of the setting that isn't a well-formed name.
//
// No Next.js imports here, so Vitest can load it directly.
import { NAME_PATTERN, RESERVED_NAMES, type Participant, type ParticipantKind } from './shared';

export const DEFAULT_PARTICIPANTS = 'grok:agent,claude:agent,david:human';
export const MIN_PARTICIPANTS = 2;
export const MAX_PARTICIPANTS = 12; // one colour each (PARTICIPANT_COLORS)
export const MIN_TOKEN_LENGTH = 16;

type Env = Record<string, string | undefined>;

/** A setting that can't be used as it is. The message is safe to show to any caller. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** The environment variable that holds a participant's token: "ana-maria" → "ANA_MARIA_TOKEN". */
export const tokenEnvName = (name: string): string => `${name.toUpperCase().replace(/-/g, '_')}_TOKEN`;

const NAME_RULE = 'A name is lowercase, starts with a letter, continues with letters, digits or "-", and has at most 24 characters.';
const list = (items: string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items.join(''));

/**
 * Parses a PARTICIPANTS value. Throws a ConfigError that names the first problem.
 * Colours are handed out in the order of the list.
 */
export function parseParticipants(value: string): Participant[] {
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length < MIN_PARTICIPANTS) {
    throw new ConfigError(`PARTICIPANTS must list at least ${MIN_PARTICIPANTS} participants, separated by commas (found ${entries.length}).`);
  }
  if (entries.length > MAX_PARTICIPANTS) {
    throw new ConfigError(`PARTICIPANTS can list at most ${MAX_PARTICIPANTS} participants (found ${entries.length}).`);
  }
  const participants: Participant[] = [];
  for (const [i, entry] of entries.entries()) {
    const where = `PARTICIPANTS entry ${i + 1}`;
    const parts = entry.split(':');
    if (entry === '' || parts.length !== 2) {
      throw new ConfigError(`${where} must be name:kind, for example ana:human. Entries are separated by commas.`);
    }
    const name = parts[0].trim();
    const kind = parts[1].trim();
    if (!NAME_PATTERN.test(name)) throw new ConfigError(`${where} has a name that can't be used. ${NAME_RULE}`);
    if (kind !== 'human' && kind !== 'agent') throw new ConfigError(`${where} ("${name}") needs the kind human or agent after the colon.`);
    if (RESERVED_NAMES.includes(name)) {
      throw new ConfigError(`${where} uses the name "${name}", which is reserved (${RESERVED_NAMES.join(', ')}).`);
    }
    if (participants.some((p) => p.name === name)) throw new ConfigError(`PARTICIPANTS lists "${name}" more than once.`);
    participants.push({ name, kind: kind as ParticipantKind, color: i });
  }
  return participants;
}

export interface Roster {
  /** In the order of the setting. */
  participants: Participant[];
  names: string[];
  /** true when PARTICIPANTS is set; false when the three default participants apply. */
  explicit: boolean;
}

const usable = (token: string | undefined): token is string => typeof token === 'string' && token.length >= MIN_TOKEN_LENGTH;

/**
 * The participants of this deployment, from PARTICIPANTS, or the default three when it is unset
 * or empty. Throws a ConfigError when the setting is malformed, or when it is set and a
 * participant has no token of their own.
 */
export function loadRoster(env: Env = process.env): Roster {
  const setting = env.PARTICIPANTS?.trim();
  const participants = parseParticipants(setting || DEFAULT_PARTICIPANTS);
  const roster: Roster = { participants, names: participants.map((p) => p.name), explicit: Boolean(setting) };
  if (!roster.explicit) return roster;

  // Whoever writes the list means everyone on it to be able to post, so a missing token is an
  // error here and not a participant who silently can't get in.
  const missing = participants.filter((p) => !usable(env[tokenEnvName(p.name)]));
  if (missing.length) {
    throw new ConfigError(
      `PARTICIPANTS lists ${list(missing.map((p) => p.name))}, but ${list(missing.map((p) => tokenEnvName(p.name)))} `
      + `${missing.length > 1 ? 'are' : 'is'} not set or shorter than ${MIN_TOKEN_LENGTH} characters. Every participant needs a token of their own.`,
    );
  }
  const owners = new Map<string, string[]>();
  for (const p of participants) {
    const token = env[tokenEnvName(p.name)] as string;
    owners.set(token, [...(owners.get(token) ?? []), tokenEnvName(p.name)]);
  }
  const shared = [...owners.values()].find((vars) => vars.length > 1);
  if (shared) throw new ConfigError(`${list(shared)} hold the same token. Every participant needs a token of their own.`);
  return roster;
}
