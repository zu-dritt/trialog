// Wake-up webhooks for every agent. An agent that only runs when something calls it registers a
// https URL and a secret; the hub POSTs a short, HMAC-signed notice when a message should wake
// that agent. Agents that poll (no inbound port) keep using GET /api/messages?since=, or the
// cheaper GET /api/wake?since= that returns only the messages that should wake them.
//
// Wake rule: a message from a human wakes every agent, whoever it is addressed to. A message
// from an agent wakes only the agents it addresses (a message to everyone addresses every
// agent), never the sender. Messages from the hub wake no one.
//
// The signature contract (header names, HMAC, skew) is the one published in docs/api.md. The
// combined header is still called X-Hub-Grok-Signature so existing receivers keep working.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { Message, Sender } from './core';
import { loadRoster } from './participants';
import type { Participant } from './shared';
import type { PendingWake, Store, WakeDelivery } from './store';

export const SIGNATURE_HEADER = 'X-Hub-Signature';
export const TIMESTAMP_HEADER = 'X-Hub-Timestamp';
// The same timestamp and signature in one Stripe-style header, `t=<unix seconds>,v1=<lowercase hex>`,
// which is the form some receivers verify (hub #39). It carries no new information. The name is
// historical; it is used for every agent, not only for one.
export const COMBINED_HEADER = 'X-Hub-Grok-Signature';
export const MAX_SKEW_SECONDS = 300;
export const MIN_SECRET_LENGTH = 16;
export const MAX_SECRET_LENGTH = 256;
export const MAX_TARGET_URL_LENGTH = 2048;
export const PREVIEW_CHARS = 200;

export const DEBOUNCE_MS = 2_000;
export const TIMEOUT_MS = 5_000;
/** One retry after the first attempt. */
export const RETRY_DELAYS_MS = [1_000];

export interface WakeupPayload {
  id: number;
  sender: string;
  /** Who the message is for: every current participant when it is addressed to everyone, otherwise that one name. */
  recipients: string[];
  /** A short, single-line excerpt of the text, at most PREVIEW_CHARS characters. */
  preview: string;
  /** Inclusive range this notice covers (always this one message). Kept so older receivers can keep using first_id / last_id / count. */
  first_id: number;
  last_id: number;
  count: number;
  sent_at: number;
}

/**
 * `sha256=` + lowercase hex of HMAC-SHA256(secret, timestamp + "." + raw body bytes).
 * `timestamp` is Unix time in seconds, as the decimal ASCII string sent in X-Hub-Timestamp.
 */
export function sign(secret: string, timestamp: string, rawBody: string | Uint8Array): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/** `t=<unix seconds>,v1=<lowercase hex>` for the same HMAC as `sign()`. */
export function combinedSignature(secret: string, timestamp: string, rawBody: string | Uint8Array): string {
  return `t=${timestamp},v1=${sign(secret, timestamp, rawBody).slice('sha256='.length)}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * The receiver's checks, kept here as the reference implementation and used by the tests.
 * `rawBody` must be the bytes as received, never a re-serialised object.
 */
export function verify(input: {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string | Uint8Array;
  now?: number; // Unix seconds
}): VerifyResult {
  const { secret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return { ok: false, reason: 'missing header' };
  if (!/^\d{1,11}$/.test(timestamp)) return { ok: false, reason: 'timestamp is not Unix seconds' };
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'signature is not sha256=<lowercase hex>' };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: 'timestamp outside the 5-minute window' };
  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

export interface WebhookConfig {
  url: string;
  secret: string;
}

/** Fallback env target: still read as GROK_WEBHOOK_URL / GROK_WEBHOOK_SECRET, for the participant named `grok`. */
export const ENV_WAKE_PARTICIPANT = 'grok';

/**
 * Reads GROK_WEBHOOK_URL and GROK_WEBHOOK_SECRET as a fallback target for the participant named
 * `grok`, used only when that participant has not registered a target of their own. If either is
 * unset or unusable, there is no fallback. A registered target always wins.
 */
export function webhookConfig(env: Record<string, string | undefined> = process.env): WebhookConfig | null {
  const url = env.GROK_WEBHOOK_URL?.trim();
  const secret = env.GROK_WEBHOOK_SECRET?.trim();
  if (!url || !secret) return null;
  const parsed = parseWakeTarget({ url, secret });
  if (!parsed.ok) {
    console.warn(`[trialog] GROK_WEBHOOK_URL / GROK_WEBHOOK_SECRET ${parsed.error} wake-up fallback is off.`);
    return null;
  }
  let names: string[];
  try {
    names = loadRoster(env).names;
  } catch {
    return null; // a broken PARTICIPANTS setting is reported by every request (lib/http.ts)
  }
  if (!names.includes(ENV_WAKE_PARTICIPANT)) {
    console.warn(`[trialog] GROK_WEBHOOK_URL is set, but PARTICIPANTS has no participant named "${ENV_WAKE_PARTICIPANT}": that fallback is off.`);
    return null;
  }
  return parsed.target;
}

export type WakeTargetParse = { ok: true; target: WebhookConfig } | { ok: false; error: string };

/**
 * Validates a wake-up target. The URL must be https, with a host, and without a username or
 * password. The secret is 16–256 characters. The error never repeats the secret.
 */
export function parseWakeTarget(input: { url?: unknown; secret?: unknown }): WakeTargetParse {
  if (typeof input.url !== 'string' || input.url.trim() === '') return { ok: false, error: 'A https URL is required.' };
  if (typeof input.secret !== 'string') return { ok: false, error: 'A secret of at least 16 characters is required.' };
  const url = input.url.trim();
  const secret = input.secret;
  if (url.length > MAX_TARGET_URL_LENGTH) return { ok: false, error: 'The URL is too long.' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'The URL is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'The URL must be https.' };
  if (!parsed.hostname) return { ok: false, error: 'The URL must include a host.' };
  if (parsed.username || parsed.password) return { ok: false, error: 'The URL must not include a username or a password.' };
  if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
    return { ok: false, error: `The secret must be between ${MIN_SECRET_LENGTH} and ${MAX_SECRET_LENGTH} characters.` };
  }
  if (isInternalHostname(parsed.hostname)) {
    return { ok: false, error: 'The URL must not point at an internal host.' };
  }
  return { ok: true, target: { url: parsed.toString(), secret } };
}

/** The host of a stored target URL, for public answers. Never a path, query, secret or full URL. */
export function wakeTargetHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export type DnsLookup = (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;

const defaultDnsLookup: DnsLookup = async (hostname) => {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: (r.family === 6 ? 6 : 4) as 4 | 6 }));
};

let dnsLookup: DnsLookup = defaultDnsLookup;

/** For tests: control what a hostname resolves to. Pass null to restore the real resolver. */
export function setWakeDnsForTests(fn: DnsLookup | null) {
  dnsLookup = fn ?? defaultDnsLookup;
}

const INTERNAL_V4 = new BlockList();
INTERNAL_V4.addSubnet('127.0.0.0', 8, 'ipv4');
INTERNAL_V4.addSubnet('10.0.0.0', 8, 'ipv4');
INTERNAL_V4.addSubnet('172.16.0.0', 12, 'ipv4');
INTERNAL_V4.addSubnet('192.168.0.0', 16, 'ipv4');
INTERNAL_V4.addSubnet('169.254.0.0', 16, 'ipv4');

const INTERNAL_V6 = new BlockList();
INTERNAL_V6.addSubnet('::1', 128, 'ipv6');
INTERNAL_V6.addSubnet('fc00::', 7, 'ipv6');
INTERNAL_V6.addSubnet('fe80::', 10, 'ipv6');

/** Unwrap IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) so it is checked as IPv4. */
export function canonicalIp(address: string): { ip: string; family: 4 | 6 } | null {
  const raw = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mappedDotted = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDotted) return { ip: mappedDotted[1], family: 4 };
  const mappedHex = raw.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return { ip: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, family: 4 };
  }
  const kind = isIP(raw);
  if (kind === 4) return { ip: raw, family: 4 };
  if (kind === 6) return { ip: raw, family: 6 };
  return null;
}

export function isInternalIp(address: string): boolean {
  const parsed = canonicalIp(address);
  if (!parsed) return false;
  return parsed.family === 4 ? INTERNAL_V4.check(parsed.ip, 'ipv4') : INTERNAL_V6.check(parsed.ip, 'ipv6');
}

/**
 * True for localhost, names ending in .localhost / .local / .internal (a trailing dot is
 * ignored), and IP literals in loopback, private, link-local or unique-local ranges.
 */
export function isInternalHostname(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.+$/, '');
  if (!name) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name === 'local' || name.endsWith('.local')) return true;
  if (name === 'internal' || name.endsWith('.internal')) return true;
  return isInternalIp(name);
}

/**
 * Resolves the URL's host and rejects if any address is internal. IP literals and reserved
 * names are rejected without a lookup. Called at registration and again at delivery, so a
 * name that later starts pointing at an internal address is not contacted (DNS rebinding).
 */
export async function assertPublicWakeUrl(url: string, lookup: DnsLookup = dnsLookup): Promise<{ ok: true } | { ok: false; error: string }> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { ok: false, error: 'The URL is not a valid URL.' };
  }
  if (isInternalHostname(hostname)) return { ok: false, error: 'The URL must not point at an internal host.' };
  if (isIP(hostname) || canonicalIp(hostname)) return { ok: true };
  let addresses: readonly { address: string; family: 4 | 6 }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    return { ok: false, error: 'The host could not be resolved.' };
  }
  if (!addresses.length) return { ok: false, error: 'The host could not be resolved.' };
  if (addresses.some((row) => isInternalIp(row.address))) {
    return { ok: false, error: 'The URL must not resolve to an internal address.' };
  }
  return { ok: true };
}

/** A short single-line excerpt of a message, for the wake-up payload. */
export function messagePreview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Who a message should wake, by the rule above. `roster` is GET /api/participants. The hub itself
 * never wakes anyone. A sender who is not on the roster wakes no one.
 */
export function whoToWake(message: Pick<Message, 'sender' | 'recipient'>, roster: readonly Participant[]): Sender[] {
  if (message.sender === 'hub') return [];
  const agents = roster.filter((p) => p.kind === 'agent').map((p) => p.name);
  const sender = roster.find((p) => p.name === message.sender);
  if (!sender) return [];
  if (sender.kind === 'human') return agents;
  if (sender.kind !== 'agent') return [];
  if (message.recipient === null) return agents.filter((name) => name !== message.sender);
  if (message.recipient === message.sender) return [];
  return agents.includes(message.recipient) ? [message.recipient] : [];
}

/** Recipients field of the payload: every name on the roster when the message is for everyone. */
export function payloadRecipients(message: Pick<Message, 'recipient'>, names: readonly string[]): string[] {
  return message.recipient === null ? [...names] : [message.recipient];
}

export function wakeupPayload(message: Pick<Message, 'id' | 'sender' | 'recipient' | 'text'>, names: readonly string[], sentAt: number): WakeupPayload {
  return {
    id: message.id,
    sender: message.sender,
    recipients: payloadRecipients(message, names),
    preview: messagePreview(message.text),
    first_id: message.id,
    last_id: message.id,
    count: 1,
    sent_at: sentAt,
  };
}

export type DeliveryResult =
  | { status: 'idle' } // nobody to wake, or no target registered
  | { status: 'delivered'; deliveries: WakeDelivery[] }
  | { status: 'failed'; deliveries: WakeDelivery[] }
  | { status: 'error'; error: string };

export interface WakeupOptions {
  store: Store;
  /** Used in tests, and as the env fallback for `grok` in production. Keys are participant names. */
  fallbackTargets?: Readonly<Record<string, WebhookConfig>>;
  roster?: readonly Participant[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number; // milliseconds
  debounceMs?: number;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  /** DNS lookup for the public-host check at delivery. Tests inject one. */
  lookup?: DnsLookup;
  /** When false, skip the public-host check. Only the real-HTTP loopback test uses this. */
  enforcePublicTarget?: boolean;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Strips anything that might be a secret or a target URL from an error, so it is safe to log. */
export function publicDeliveryError(error: string, targets: readonly WebhookConfig[] = []): string {
  let text = error;
  for (const t of targets) {
    if (t.secret) text = text.split(t.secret).join('[secret]');
    if (t.url) text = text.split(t.url).join('[url]');
  }
  return text.replace(/https:\/\/[^\s]+/g, '[url]');
}

/**
 * Returns `onMessage`, to be called after a message has been committed. For a message that wakes
 * at least one agent who has a target, it returns a promise for the delivery job (hand it to
 * `waitUntil`; it never rejects), and null otherwise. Polling agents are not registered here;
 * they use GET /api/wake?since= (or GET /api/messages?since=), which still work unchanged.
 *
 * Each job waits for the debounce, then delivers every pending wake-up. A burst of messages
 * shares one debounce, then goes out as one signed POST per (message, participant). A message
 * that arrives after a job has already claimed its rows gets its own job, so nothing is dropped.
 * A delivery row is claimed atomically before it is sent, so two processes never send the
 * same wake twice. A claim left in "sending" is taken again after a minute. Status is stored
 * per message and participant.
 */
export function createWakeup(options: WakeupOptions) {
  const { store } = options;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const lookup = options.lookup ?? dnsLookup;
  const enforcePublicTarget = options.enforcePublicTarget !== false;

  const rosterOf = () => options.roster ?? loadRoster().participants;

  async function credentials(participant: string): Promise<WebhookConfig | null> {
    const stored = await store.getWakeCredentials(participant);
    if (stored) return stored;
    return options.fallbackTargets?.[participant] ?? null;
  }

  async function deliverOne(row: PendingWake, target: WebhookConfig, names: readonly string[]): Promise<WakeDelivery> {
    const sentAt = Math.floor(now() / 1000);
    const payload = wakeupPayload({ id: row.message_id, sender: row.sender, recipient: row.recipient, text: row.text }, names, sentAt);
    const body = JSON.stringify(payload);
    const timestamp = String(sentAt);
    const headers = {
      'Content-Type': 'application/json',
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: sign(target.secret, timestamp, body),
      [COMBINED_HEADER]: combinedSignature(target.secret, timestamp, body),
    };

    if (enforcePublicTarget) {
      const allowed = await assertPublicWakeUrl(target.url, lookup);
      if (!allowed.ok) {
        const safe = publicDeliveryError(allowed.error, [target]);
        console.error(`[trialog] wake-up webhook refused for message #${row.message_id} to ${row.participant}: ${safe}`);
        return store.saveWakeDelivery(row.message_id, row.participant, 'failed', 0, safe);
      }
    }

    let error = '';
    const attempts = retryDelaysMs.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(retryDelaysMs[attempt - 2]);
      try {
        // No redirects: the signed request goes to the configured URL or nowhere.
        const res = await doFetch(target.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        await res.body?.cancel().catch(() => {});
        if (res.status >= 200 && res.status < 300) {
          return store.saveWakeDelivery(row.message_id, row.participant, 'delivered', attempt, null);
        }
        error = `HTTP ${res.status}`;
      } catch (e) {
        error = describe(e);
      }
    }
    const safe = publicDeliveryError(error, [target]);
    console.error(`[trialog] wake-up webhook failed for message #${row.message_id} to ${row.participant} after ${attempts} attempts: ${safe}`);
    return store.saveWakeDelivery(row.message_id, row.participant, 'failed', attempts, safe);
  }

  // Jobs started close together share work: each waits for the debounce, then they run one
  // after another so a burst is listed once and a later job only sees what is still pending.
  let queue: Promise<void> = Promise.resolve();

  async function deliver(): Promise<DeliveryResult> {
    const turn = queue.then(async () => {
      await sleep(debounceMs);
      return runDeliveries();
    });
    queue = turn.then(() => undefined, () => undefined);
    return turn;
  }

  async function runDeliveries(): Promise<DeliveryResult> {
    const roster = rosterOf();
    const names = roster.map((p) => p.name);
    const pending = await store.claimPendingWakes();
    if (!pending.length) return { status: 'idle' };

    const deliveries: WakeDelivery[] = [];
    for (const row of pending) {
      const target = await credentials(row.participant);
      if (!target) {
        // The target was cleared after the row was queued; leave it pending so a later set can send it,
        // or drop it as failed with a public reason. Failed is clearer for ?wakes=1.
        deliveries.push(await store.saveWakeDelivery(row.message_id, row.participant, 'failed', 0, 'No wake-up target is set.'));
        continue;
      }
      deliveries.push(await deliverOne(row, target, names));
    }
    if (deliveries.some((d) => d.status === 'failed') && !deliveries.some((d) => d.status === 'delivered')) {
      return { status: 'failed', deliveries };
    }
    return { status: 'delivered', deliveries };
  }

  return {
    async credentialsFor(participant: string) {
      return credentials(participant);
    },
    onMessage(message: Pick<Message, 'id' | 'sender' | 'recipient' | 'text'>): Promise<DeliveryResult> | null {
      const roster = rosterOf();
      const targets = whoToWake(message, roster);
      if (!targets.length) return null;
      return (async () => {
        const withTarget: string[] = [];
        for (const name of targets) {
          if (await credentials(name)) withTarget.push(name);
        }
        if (!withTarget.length) return { status: 'idle' as const };
        await store.enqueueWakes(message.id, withTarget);
        return deliver();
      })().catch((e: unknown): DeliveryResult => {
        const safe = publicDeliveryError(describe(e), Object.values(options.fallbackTargets ?? {}));
        console.error('[trialog] wake-up webhook job failed:', safe);
        return { status: 'error', error: safe };
      });
    },
    /** Sends one signed test notice to the caller's registered target. Does not store a delivery row. */
    async sendTest(participant: string): Promise<{ ok: true; status: number } | { ok: false; error: string }> {
      const target = await credentials(participant);
      if (!target) return { ok: false, error: 'No wake-up target is set.' };
      const roster = rosterOf();
      const names = roster.map((p) => p.name);
      const sentAt = Math.floor(now() / 1000);
      const payload = wakeupPayload(
        { id: 0, sender: 'hub', recipient: participant, text: 'Wake-up test. This is not a hub message.' },
        names,
        sentAt,
      );
      const body = JSON.stringify(payload);
      const timestamp = String(sentAt);
      const headers = {
        'Content-Type': 'application/json',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(target.secret, timestamp, body),
        [COMBINED_HEADER]: combinedSignature(target.secret, timestamp, body),
      };
      if (enforcePublicTarget) {
        const allowed = await assertPublicWakeUrl(target.url, lookup);
        if (!allowed.ok) return { ok: false, error: publicDeliveryError(allowed.error, [target]) };
      }
      try {
        const res = await doFetch(target.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        await res.body?.cancel().catch(() => {});
        if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
        return { ok: false, error: publicDeliveryError(`HTTP ${res.status}`, [target]) };
      } catch (e) {
        return { ok: false, error: publicDeliveryError(describe(e), [target]) };
      }
    },
  };
}

type Wakeup = ReturnType<typeof createWakeup>;
const globalWakeup = globalThis as typeof globalThis & { __collabHubWakeup?: Wakeup | null };

/** One wake-up runner per server instance. Always created; it no-ops when nobody has a target. */
export function getWakeup(store: Store): Wakeup {
  if (!globalWakeup.__collabHubWakeup) {
    const fallback = webhookConfig();
    globalWakeup.__collabHubWakeup = createWakeup({
      store,
      fallbackTargets: fallback ? { [ENV_WAKE_PARTICIPANT]: fallback } : {},
    });
  }
  return globalWakeup.__collabHubWakeup;
}

/** For tests that import the route more than once: drop the cached runner. */
export function resetWakeupForTests() {
  globalWakeup.__collabHubWakeup = null;
}
