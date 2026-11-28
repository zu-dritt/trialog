// iPhone push: who to notify, the short alert text, and sending to each of that
// participant's registered devices. Hooks sit next to agent wake-ups. The topic
// on each send is the bundle id stored on the device.

import { waitUntil } from '@vercel/functions';
import type { Flight, Message, Participant, Sender } from './core';
import { labelOf } from './shared';
import type { RoadmapItem } from './roadmap';
import { loadRoster } from './participants';
import { messagePreview } from './webhook';
import { sendApnsAlert } from './apns';
import type { PushDevice, PushEnv, PushPlatform, Store } from './store';

export const DEFAULT_BUNDLE_ID = 'dev.trialog.app';
export const BUNDLE_ID_MAX = 255;
export const BUNDLE_ID_PATTERN = /^[A-Za-z]([A-Za-z0-9-]{0,62}\.)+[A-Za-z0-9-]{1,63}$/;
export const DEVICE_TOKEN_PATTERN = /^[0-9a-fA-F]{64,256}$/;
export const ALERT_SNIPPET = 80;

export function defaultBundleId(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.APNS_BUNDLE_ID?.trim();
  return fromEnv && BUNDLE_ID_PATTERN.test(fromEnv) && fromEnv.length <= BUNDLE_ID_MAX ? fromEnv : DEFAULT_BUNDLE_ID;
}

export type ParsedPushDevice =
  | { ok: true; token: string; platform: PushPlatform; env: PushEnv; bundle_id: string }
  | { ok: false; error: string };

export function parsePushDevice(body: unknown, fallbackBundleId: string = defaultBundleId()): ParsedPushDevice {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send a JSON object.' };
  const rec = body as Record<string, unknown>;
  if (typeof rec.token !== 'string' || !DEVICE_TOKEN_PATTERN.test(rec.token.trim())) {
    return { ok: false, error: 'token must be a 64-to-256 character hex device token.' };
  }
  if (rec.platform !== 'ios') return { ok: false, error: "platform must be \"ios\"." };
  if (rec.env !== 'sandbox' && rec.env !== 'production') {
    return { ok: false, error: 'env must be "sandbox" or "production".' };
  }
  let bundle_id = fallbackBundleId;
  if (rec.bundle_id !== undefined) {
    if (typeof rec.bundle_id !== 'string' || !BUNDLE_ID_PATTERN.test(rec.bundle_id.trim()) || rec.bundle_id.trim().length > BUNDLE_ID_MAX) {
      return { ok: false, error: 'bundle_id must be a reverse-DNS app id, for example dev.trialog.app.' };
    }
    bundle_id = rec.bundle_id.trim();
  }
  return { ok: true, token: rec.token.trim(), platform: 'ios', env: rec.env, bundle_id };
}

export function parsePushToken(body: unknown): { ok: true; token: string } | { ok: false; error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send a JSON object.' };
  const rec = body as Record<string, unknown>;
  if (typeof rec.token !== 'string' || !DEVICE_TOKEN_PATTERN.test(rec.token.trim())) {
    return { ok: false, error: 'token must be a 64-to-256 character hex device token.' };
  }
  return { ok: true, token: rec.token.trim() };
}

/** A message notifies only the human it is addressed to, never a broadcast and never an agent. */
export function humansForMessage(
  message: Pick<Message, 'sender' | 'recipient'>,
  roster: readonly Participant[],
): Sender[] {
  if (!message.recipient || message.recipient === message.sender) return [];
  const who = roster.find((p) => p.name === message.recipient);
  return who?.kind === 'human' ? [who.name] : [];
}

/** Named "Name: step" waits on a waiting flight, same rule as the strip. */
export function humansForFlight(
  flight: Pick<Flight, 'state' | 'text' | 'participant'>,
  roster: readonly Participant[],
): Sender[] {
  if (flight.state !== 'waiting') return [];
  const named = /^\s*(?:waiting\s+(?:for|on)\s+)?@?([A-Za-z][\w .'-]{0,39}):\s+(.+)$/is;
  const steps = flight.text.split(/;\s+(?=(?:waiting\s+(?:for|on)\s+)?@?[A-Za-z][\w .'-]{0,39}:\s)/i);
  const found = new Set<Sender>();
  for (const part of steps) {
    const m = named.exec(part);
    if (!m) continue;
    const stepName = m[1].trim().toLowerCase();
    const human = roster.find((p) => p.kind === 'human' && (
      p.name.toLowerCase() === stepName || (p.label ?? '').toLowerCase() === stepName
    ));
    if (human && human.name !== flight.participant) found.add(human.name);
  }
  return [...found];
}

/** Humans a card is waiting on, from its owner (outside Now) or its note, same cues as the LED. */
export function humansForCard(
  item: Pick<RoadmapItem, 'column' | 'note' | 'owner'>,
  roster: readonly Participant[],
): Sender[] {
  if (item.column === 'done') return [];
  const humans = roster.filter((p) => p.kind === 'human');
  const names = new Set<Sender>();
  if (item.column !== 'now' && item.owner && humans.some((h) => h.name === item.owner)) {
    names.add(item.owner);
  }
  const note = item.note.trim();
  for (const h of humans) {
    const tokens = [h.name, h.label].filter((x): x is string => Boolean(x)).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const any = tokens.join('|');
    if (!any) continue;
    if (new RegExp(`waiting on (the )?(${any}|you)\\b`, 'i').test(note) || new RegExp(`^@?(${any})\\s*:`, 'i').test(note)) {
      names.add(h.name);
    }
  }
  if (/⛔/.test(note) && names.size === 0) {
    for (const h of humans) names.add(h.name);
  }
  return [...names];
}

export function pushAlertForMessage(message: Pick<Message, 'id' | 'sender' | 'text'>, roster: readonly Participant[]): string {
  const who = labelOf(message.sender, roster);
  const snippet = messagePreview(message.text, ALERT_SNIPPET);
  return `${who}: ${snippet} (#${message.id})`;
}

export function pushAlertForFlight(flight: Pick<Flight, 'participant' | 'text'>, roster: readonly Participant[]): string {
  const who = labelOf(flight.participant, roster);
  const snippet = messagePreview(flight.text, ALERT_SNIPPET);
  return `${who} is waiting on you: ${snippet}`;
}

export function pushAlertForCard(item: Pick<RoadmapItem, 'title' | 'note'>): string {
  const text = item.note.trim() || item.title;
  return `A card waits on you: ${messagePreview(text, ALERT_SNIPPET)}`;
}

export function publicPushDevice(device: PushDevice): Omit<PushDevice, 'disabled_at'> {
  return {
    participant: device.participant,
    token: device.token,
    platform: device.platform,
    env: device.env,
    bundle_id: device.bundle_id,
    created_at: device.created_at,
    last_seen_at: device.last_seen_at,
  };
}

/** Fire-and-forget: keep the serverless invocation alive, never fail the caller's request. */
export function schedulePush(job: Promise<unknown>): void {
  waitUntil(Promise.resolve(job).catch(() => {
    console.error('[trialog] push failed');
  }));
}

async function deliverTo(store: Store, humans: readonly Sender[], alert: string, payload?: Record<string, unknown>): Promise<void> {
  if (!humans.length) return;
  for (const name of humans) {
    const devices = await store.listPushDevices(name);
    for (const device of devices) {
      const result = await sendApnsAlert({
        token: device.token,
        env: device.env,
        bundleId: device.bundle_id,
        alert,
        payload,
      });
      if ('disable' in result && result.disable) {
        await store.disablePushDevice(device.token);
      }
    }
  }
}

export async function notifyPushForMessage(store: Store, message: Message): Promise<void> {
  const roster = loadRoster().participants;
  const humans = humansForMessage(message, roster);
  if (!humans.length) return;
  await deliverTo(store, humans, pushAlertForMessage(message, roster), {
    message_id: message.id,
    room: message.room,
  });
}

/** Only when the wait is new or the text changed (`since` moves). An identical PUT does not notify again. */
export async function notifyPushForFlight(store: Store, flight: Flight, before: Flight | null): Promise<void> {
  const roster = loadRoster().participants;
  const after = new Set(humansForFlight(flight, roster));
  if (!after.size) return;
  if (before && flight.since === before.since) return;
  const previous = new Set(before ? humansForFlight(before, roster) : []);
  const added = [...after].filter((n) => !previous.has(n) || flight.since !== before?.since);
  // A new `since` means the wait itself changed: notify everyone it now waits on.
  const targets = flight.since !== before?.since ? [...after] : added;
  if (!targets.length) return;
  await deliverTo(store, targets, pushAlertForFlight(flight, roster));
}

/** Only humans newly waiting on the card, so an unrelated edit does not notify again. */
export async function notifyPushForRoadmap(store: Store, item: RoadmapItem, before: RoadmapItem | null): Promise<void> {
  const roster = loadRoster().participants;
  const after = new Set(humansForCard(item, roster));
  const previous = new Set(before ? humansForCard(before, roster) : []);
  const added = [...after].filter((n) => !previous.has(n));
  if (!added.length) return;
  await deliverTo(store, added, pushAlertForCard(item), { roadmap_item_id: item.id });
}
