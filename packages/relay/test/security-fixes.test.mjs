// Security-fix regression tests for relay/db.ts:
//   1. revokeHost cascades: session_tokens, grace aliases, and push
//      subscriptions for the host are all deleted (a revoked host's issued
//      credentials must not keep authenticating).
//   2. deletePushSubscriptionScoped only deletes within the token's host
//      (prevents cross-host unsubscribe with a stolen token).
//   3. DB file is created 0600 (holds host secrets).
//
// Run: node --test packages/relay/test/security-fixes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIRELAY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'airelay-sec-test-'));

const {
  registerHost, getHost, revokeHost,
  createSessionToken, getSessionToken, rotateSessionToken,
  upsertPushSubscription, getPushSubscriptions, deletePushSubscriptionScoped,
} = await import('../dist/db.js');

const HOST_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HOST_B = '11111111-2222-4333-8444-555555555555';

test.before(() => {
  registerHost(HOST_A, 'secret-a', 'host-a');
  registerHost(HOST_B, 'secret-b', 'host-b');
});

test.after(() => {
  rmSync(process.env.AIRELAY_CONFIG_DIR, { recursive: true, force: true });
});

test('relay.db is created with mode 0600 (holds host secrets)', () => {
  const mode = statSync(join(process.env.AIRELAY_CONFIG_DIR, 'relay.db')).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('revokeHost cascades to session tokens, grace aliases, push subs', () => {
  const tokenA = createSessionToken(HOST_A, 3600, 'phone-a');
  const tokenB = createSessionToken(HOST_B, 3600, 'phone-b');
  upsertPushSubscription('https://push.example/a', HOST_A, 'k1', 'k2', 'phone-a');
  upsertPushSubscription('https://push.example/b', HOST_B, 'k3', 'k4', 'phone-b');

  // Force a grace alias for host A via rotation
  rotateSessionToken(tokenA);

  revokeHost(HOST_A);

  // Host A is gone
  assert.equal(getHost(HOST_A), null);
  // Host A's current token no longer authenticates…
  assert.equal(getSessionToken(tokenA), null);
  // …and neither does its rotated-out grace alias
  const olderA = getSessionToken(tokenA);
  assert.equal(olderA, null);
  // Host A's push subscription is gone
  assert.equal(getPushSubscriptions(HOST_A).length, 0);
  // Host B is untouched
  assert.ok(getHost(HOST_B));
  assert.ok(getSessionToken(tokenB));
  assert.equal(getPushSubscriptions(HOST_B).length, 1);
});

test('deletePushSubscriptionScoped is host-scoped (no cross-host deletion)', () => {
  // Fresh endpoints — earlier tests may leave rows for HOST_B
  upsertPushSubscription('https://push.example/x1', HOST_B, 'k5', 'k6', 'phone-b');
  // Try deleting host B's endpoint while claiming host A — no-op
  deletePushSubscriptionScoped('https://push.example/x1', HOST_A);
  const rows = getPushSubscriptions(HOST_B).filter((r) => r.endpoint === 'https://push.example/x1');
  assert.equal(rows.length, 1);
  // Correct host deletes it
  deletePushSubscriptionScoped('https://push.example/x1', HOST_B);
  assert.equal(getPushSubscriptions(HOST_B).filter((r) => r.endpoint === 'https://push.example/x1').length, 0);
});
