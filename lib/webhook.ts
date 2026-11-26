// Grok wake-up webhook (PLAN-v2.md, PR 2). Grok only runs when something wakes it, so the hub
// tells Grok's endpoint that new messages exist. The payload is thin (ids only, never message
// text); Grok then reads the messages with its own token.
//
// The contract (header names, signature format, skew) is fixed in PLAN-v2.md. Don't change it
// here without changing Grok's receiver too.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Message } from './core';
import { loadRoster } from './participants';
import { wakesGrok, type Store, type WakeupClaim } from './store';

export const SIGNATURE_HEADER = 'X-Hub-Signature';
export const TIMESTAMP_HEADER = 'X-Hub-Timestamp';
// The same timestamp and signature in one Stripe-style header, `t=<unix seconds>,v1=<lowercase hex>`,
// which is the form Grok's receiver verifies (hub #39). It carries no new information.
export const COMBINED_HEADER = 'X-Hub-Grok-Signature';
export const MAX_SKEW_SECONDS = 300;
export const MIN_SECRET_LENGTH = 16;

export const DEBOUNCE_MS = 2_000;
export const TIMEOUT_MS = 5_000;
export const RETRY_DELAYS_MS = [1_000, 4_000];

export interface WakeupPayload {
  first_id: number;
  last_id: number;
  count: number;
  sent_at: number;
  /** The ids of the rooms the messages are in, in alphabetical order. Read each with ?room=<id>. */
  rooms: string[];
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

/** The participant the webhook wakes. Wake-ups for every agent are a later step (ROADMAP.md). */
export const WAKEUP_PARTICIPANT = 'grok';

/**
 * Reads GROK_WEBHOOK_URL and GROK_WEBHOOK_SECRET. If either is unset or unusable, the feature is off.
 * It is also off, with a line in the log, when no participant is named `grok`: there is nobody to wake.
 */
export function webhookConfig(env: Record<string, string | undefined> = process.env): WebhookConfig | null {
  const url = env.GROK_WEBHOOK_URL?.trim();
  const secret = env.GROK_WEBHOOK_SECRET?.trim();
  if (!url || !secret) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn('[trialog] GROK_WEBHOOK_URL is not a valid URL: wake-up webhook is off.');
    return null;
  }
  if (parsed.protocol !== 'https:') {
    console.warn('[trialog] GROK_WEBHOOK_URL must be https: wake-up webhook is off.');
    return null;
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    console.warn(`[trialog] GROK_WEBHOOK_SECRET is shorter than ${MIN_SECRET_LENGTH} characters: wake-up webhook is off.`);
    return null;
  }
  let names: string[];
  try {
    names = loadRoster(env).names;
  } catch {
    return null; // a broken PARTICIPANTS setting is reported by every request (lib/http.ts)
  }
  if (!names.includes(WAKEUP_PARTICIPANT)) {
    console.warn(`[trialog] GROK_WEBHOOK_URL is set, but PARTICIPANTS has no participant named "${WAKEUP_PARTICIPANT}": wake-up webhook is off.`);
    return null;
  }
  return { url: parsed.toString(), secret };
}

export type DeliveryResult =
  | { status: 'covered' } // another job already claimed these messages
  | { status: 'delivered'; claim: WakeupClaim; attempts: number }
  | { status: 'failed'; claim: WakeupClaim; attempts: number; error: string }
  | { status: 'error'; error: string };

export interface WakeupOptions {
  store: Store;
  config: WebhookConfig;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number; // milliseconds
  debounceMs?: number;
  timeoutMs?: number;
  retryDelaysMs?: number[];
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/**
 * Returns `onMessage`, to be called after a message has been committed. For a message that wakes
 * Grok it returns a promise for the delivery job (hand it to `waitUntil`; it never rejects), and
 * null otherwise.
 *
 * Each job waits for the debounce, then claims everything not yet notified and sends one webhook
 * for that range. A burst therefore becomes one delivery, and a message that arrives after a
 * claim has its own job, so nothing is dropped. Delivery is at least once.
 */
export function createWakeup(options: WakeupOptions) {
  const { store, config } = options;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;

  async function deliver(): Promise<DeliveryResult> {
    await sleep(debounceMs);
    const claim = await store.claimWakeup();
    if (!claim) return { status: 'covered' };

    // One body and one timestamp for all attempts: the receiver sees identical bytes on a retry.
    const sentAt = Math.floor(now() / 1000);
    const payload: WakeupPayload = { first_id: claim.first_id, last_id: claim.last_id, count: claim.count, sent_at: sentAt, rooms: claim.rooms };
    const body = JSON.stringify(payload);
    const timestamp = String(sentAt);
    const headers = {
      'Content-Type': 'application/json',
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: sign(config.secret, timestamp, body),
      [COMBINED_HEADER]: combinedSignature(config.secret, timestamp, body),
    };

    let error = '';
    const attempts = retryDelaysMs.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(retryDelaysMs[attempt - 2]);
      try {
        // No redirects: the signed request goes to the configured URL or nowhere.
        const res = await doFetch(config.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        await res.body?.cancel().catch(() => {});
        if (res.status >= 200 && res.status < 300) return { status: 'delivered', claim, attempts: attempt };
        error = `HTTP ${res.status}`;
      } catch (e) {
        error = describe(e);
      }
    }

    // Put the watermark back so the next qualifying message re-sends this range.
    await store.releaseWakeup(claim);
    console.error(`[trialog] wake-up webhook failed for messages #${claim.first_id}–#${claim.last_id} after ${attempts} attempts: ${error}`);
    return { status: 'failed', claim, attempts, error };
  }

  return {
    onMessage(message: Pick<Message, 'sender' | 'recipient'>): Promise<DeliveryResult> | null {
      if (!wakesGrok(message)) return null;
      return deliver().catch((e: unknown): DeliveryResult => {
        console.error('[trialog] wake-up webhook job failed:', describe(e));
        return { status: 'error', error: describe(e) };
      });
    },
  };
}

type Wakeup = ReturnType<typeof createWakeup>;
const globalWakeup = globalThis as typeof globalThis & { __collabHubWakeup?: Wakeup | null };

/** One wake-up per server instance, or null when the webhook isn't configured. */
export function getWakeup(store: Store): Wakeup | null {
  if (globalWakeup.__collabHubWakeup === undefined) {
    const config = webhookConfig();
    globalWakeup.__collabHubWakeup = config ? createWakeup({ store, config }) : null;
  }
  return globalWakeup.__collabHubWakeup;
}
