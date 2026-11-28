// Token-based APNs sender: an ES256 JWT and one HTTP/2 POST per device. With no key in the
// environment this module no-ops, so the hub can run before a key is set. The topic is the
// device's stored bundle id. Nothing here logs a token, a key, or a team id.

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import http2 from 'node:http2';

export const APNS_HOST = {
  sandbox: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com',
} as const;

export type PushEnv = keyof typeof APNS_HOST;

export interface ApnsResponse {
  status: number;
  reason?: string;
}

export interface ApnsTransport {
  post(opts: { host: string; path: string; headers: Record<string, string>; body: string }): Promise<ApnsResponse>;
}

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  keyP8: string;
}

type Env = Record<string, string | undefined>;

/** All three of key id, team id and the .p8 must be set; otherwise the sender is off. */
export function apnsConfig(env: Env = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyP8 = env.APNS_KEY_P8?.trim();
  if (!keyId || !teamId || !keyP8) return null;
  return { keyId, teamId, keyP8 };
}

function pemFromEnv(keyP8: string): string {
  if (keyP8.includes('BEGIN')) return keyP8;
  const body = keyP8.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** APNs wants ES256 with a raw (IEEE-P1363) signature, not DER. */
export function signApnsJwt(config: ApnsConfig, now = Math.floor(Date.now() / 1000)): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString('base64url');
  const data = `${header}.${payload}`;
  let key: KeyObject;
  try {
    key = createPrivateKey(pemFromEnv(config.keyP8));
  } catch {
    throw new Error('APNs key could not be read');
  }
  const sig = createSign('SHA256').update(data).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}

const JWT_TTL_SEC = 50 * 60;
let cachedJwt: { token: string; exp: number; keyId: string; teamId: string } | null = null;

function jwtFor(config: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.keyId === config.keyId && cachedJwt.teamId === config.teamId && cachedJwt.exp > now) {
    return cachedJwt.token;
  }
  const token = signApnsJwt(config, now);
  cachedJwt = { token, exp: now + JWT_TTL_SEC, keyId: config.keyId, teamId: config.teamId };
  return token;
}

const REQUEST_MS = 10_000;

export function http2Transport(): ApnsTransport {
  return {
    post({ host, path, headers, body }) {
      return new Promise((resolve, reject) => {
        const client = http2.connect(`https://${host}`);
        const timer = setTimeout(() => {
          client.close();
          reject(new Error('APNs request timed out'));
        }, REQUEST_MS);
        const done = (err: Error | null, res?: ApnsResponse) => {
          clearTimeout(timer);
          try { client.close(); } catch { /* already closed */ }
          if (err) reject(err);
          else resolve(res!);
        };
        client.on('error', (err) => done(err));
        const req = client.request({
          ':method': 'POST',
          ':path': path,
          ':scheme': 'https',
          ':authority': host,
          'content-type': 'application/json',
          ...headers,
        });
        let status = 0;
        let data = '';
        req.setEncoding('utf8');
        req.on('response', (h) => { status = Number(h[':status'] ?? 0); });
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => {
          let reason: string | undefined;
          if (data) {
            try {
              const parsed = JSON.parse(data) as { reason?: unknown };
              if (typeof parsed.reason === 'string') reason = parsed.reason;
            } catch { /* body is not JSON; ignore it, and never log it */ }
          }
          done(null, { status, reason });
        });
        req.on('error', (err) => done(err));
        req.end(body);
      });
    },
  };
}

let transport: ApnsTransport = http2Transport();

export function setApnsTransportForTests(next: ApnsTransport | null): void {
  transport = next ?? http2Transport();
}

export function resetApnsForTests(): void {
  cachedJwt = null;
  transport = http2Transport();
}

export function shouldDisableDevice(res: ApnsResponse): boolean {
  return res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'Unregistered';
}

export interface SendAlertInput {
  token: string;
  env: PushEnv;
  bundleId: string;
  alert: string;
  payload?: Record<string, unknown>;
}

export type SendAlertResult =
  | { ok: true; status: number }
  | { ok: false; skipped: 'not configured' }
  | { ok: false; disable: true; status: number; reason?: string }
  | { ok: false; status: number; reason?: string };

/**
 * Sends one alert. Returns `{ skipped: 'not configured' }` when the key is not set.
 * On 410, BadDeviceToken or Unregistered, `disable` is set so the caller can drop the row.
 * The device token is never included in the result.
 */
export async function sendApnsAlert(input: SendAlertInput, env: Env = process.env): Promise<SendAlertResult> {
  const config = apnsConfig(env);
  if (!config) return { ok: false, skipped: 'not configured' };
  const host = APNS_HOST[input.env];
  const body = JSON.stringify({
    aps: { alert: input.alert, sound: 'default' },
    ...input.payload,
  });
  let res: ApnsResponse;
  try {
    res = await transport.post({
      host,
      path: `/3/device/${input.token}`,
      headers: {
        authorization: `bearer ${jwtFor(config)}`,
        'apns-topic': input.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      },
      body,
    });
  } catch {
    return { ok: false, status: 0, reason: 'transport_error' };
  }
  if (res.status === 200) return { ok: true, status: 200 };
  if (shouldDisableDevice(res)) return { ok: false, disable: true, status: res.status, reason: res.reason };
  return { ok: false, status: res.status, reason: res.reason };
}
