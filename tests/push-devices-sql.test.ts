// The push_devices table on a real Postgres (PGlite): its CHECK constraints must hold a real
// token. Postgres allows at most 255 repeats in a regex, and a 256 in the token check once made
// every registration answer 500 (playground #1147), which the in-memory tests could not see.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createSqlStore, type Db, type Row } from '../lib/store';
import { DEVICE_TOKEN_PATTERN, parsePushDevice } from '../lib/push';

function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows as Row[],
    transaction: (fn) => pg.transaction((tx) => fn({ query: async (text, params) => (await tx.query(text, params)).rows as Row[] })),
  };
}

test('the SQL store registers, lists, disables and removes a device with a real-shaped token', async () => {
  const store = createSqlStore(pgliteDb(new PGlite()));
  await store.ensure();
  const token = 'ab12'.repeat(16); // 64 hex characters, what Apple sends today
  const device = await store.upsertPushDevice({ participant: 'david', token, platform: 'ios', env: 'production', bundle_id: 'dev.trialog.app.test' });
  assert.equal(device.bundle_id, 'dev.trialog.app.test');
  assert.equal(device.env, 'production');
  assert.equal((await store.listPushDevices('david')).length, 1);
  const again = await store.upsertPushDevice({ participant: 'david', token, platform: 'ios', env: 'production', bundle_id: 'dev.trialog.app.test' });
  assert.equal((await store.listPushDevices('david')).length, 1, 'the same token is one row');
  assert.equal(again.disabled_at, null);
  await store.disablePushDevice(token);
  assert.equal((await store.listPushDevices('david')).length, 0, 'a disabled device is not listed');
  assert.equal(await store.deletePushDevice('david', token), true);
});

test('the longest token the app accepts also fits the table', async () => {
  const store = createSqlStore(pgliteDb(new PGlite()));
  await store.ensure();
  const longest = 'f'.repeat(200);
  assert.ok(DEVICE_TOKEN_PATTERN.test(longest));
  assert.ok(!DEVICE_TOKEN_PATTERN.test('f'.repeat(201)));
  assert.equal(parsePushDevice({ token: 'f'.repeat(201), platform: 'ios', env: 'sandbox' }).ok, false);
  await store.upsertPushDevice({ participant: 'david', token: longest, platform: 'ios', env: 'sandbox', bundle_id: 'dev.trialog.app' });
  assert.equal((await store.listPushDevices('david')).length, 1);
});

test('the migration file has the same token check as the store schema', () => {
  const sql = readFileSync(new URL('../migrations/020-push-devices.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes("CHECK (token ~ '^[0-9a-fA-F]{64,200}$')"));
});
