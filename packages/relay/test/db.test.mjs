// Unit tests for the session-token lifecycle in relay/db.ts.
//
// The rotation semantics are the most intricate part of the auth design:
// in-place token swap on the device row + a parallel grace table for the
// old value. These tests pin that behavior so future refactors can't
// silently break device management.
//
// Uses an isolated config dir via AIRELAY_CONFIG_DIR (set before the first
// import of db.js — module-level singleton opens the DB on first use).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AIRELAY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'airelay-db-test-'));

const {
  registerHost, getHost,
  createSessionToken, getSessionToken,
  revokeSessionToken, listSessionTokens,
  rotateSessionToken, TOKEN_ROTATION_GRACE,
  addJti, hasJti, cleanExpiredJtis,
  upsertPushSubscription, getPushSubscriptions, deletePushSubscription,
} = await import('../dist/db.js');

const HOST_ID = '22222222-3333-4444-8555-666666666666';

test.before(() => {
  registerHost(HOST_ID, 'secret', 'test-host');
});

test.after(() => {
  rmSync(process.env.AIRELAY_CONFIG_DIR, { recursive: true, force: true });
});

// ── Hosts ────────────────────────────────────────────────────────────────────

test('registerHost/getHost round-trip', () => {
  const host = getHost(HOST_ID);
  assert.ok(host);
  assert.equal(host.host_secret, 'secret');
  assert.equal(getHost('no-such-host'), null);
});

// ── Session tokens: create / lookup / expiry / revoke ────────────────────────

test('createSessionToken: issued token resolves, with device name + timestamps', () => {
  const token = createSessionToken(HOST_ID, 3600, 'Pixel Chrome');
  const row = getSessionToken(token);
  assert.ok(row);
  assert.equal(row.host_id, HOST_ID);
  assert.equal(row.device_name, 'Pixel Chrome');
  assert.ok(row.created_at > 0);
  assert.ok(row.last_used_at > 0);
});

test('getSessionToken: unknown token → null', () => {
  assert.equal(getSessionToken('never-issued'), null);
});

test('getSessionToken: expired token → null', () => {
  // ttl of -10 → already expired at insert time
  const token = createSessionToken(HOST_ID, -10);
  assert.equal(getSessionToken(token), null);
});

test('revokeSessionToken: revoked token → null, still listed as revoked', () => {
  const token = createSessionToken(HOST_ID, 3600, 'revoke-me');
  assert.ok(getSessionToken(token));
  revokeSessionToken(token);
  assert.equal(getSessionToken(token), null, 'revoked token no longer authenticates');
  const listed = listSessionTokens(HOST_ID).find((t) => t.token === token);
  assert.ok(listed, 'still in the list (shown as revoked in the device UI)');
  assert.equal(listed.revoked, 1);
});

// ── Rotation semantics ───────────────────────────────────────────────────────

test('rotation: swaps token in place on the same device row', () => {
  const oldToken = createSessionToken(HOST_ID, 7 * 24 * 3600, 'rotation-device');
  const rowsBefore = listSessionTokens(HOST_ID).filter((t) => t.device_name === 'rotation-device');
  assert.equal(rowsBefore.length, 1);

  const newToken = rotateSessionToken(oldToken);
  assert.ok(newToken);
  assert.notEqual(newToken, oldToken);

  // Still exactly one device row, same name, same id-ish identity.
  const rowsAfter = listSessionTokens(HOST_ID).filter((t) => t.device_name === 'rotation-device');
  assert.equal(rowsAfter.length, 1, 'rotation must not grow the device list');
  assert.equal(rowsAfter[0].token, newToken, 'row now carries the new token');

  // The new token authenticates; the device row is the same one.
  const row = getSessionToken(newToken);
  assert.ok(row);
  assert.equal(row.device_name, 'rotation-device');
});

test('rotation: old token works during the grace window', () => {
  const oldToken = createSessionToken(HOST_ID, 7 * 24 * 3600, 'grace-device');
  const newToken = rotateSessionToken(oldToken);
  const resolved = getSessionToken(oldToken);
  assert.ok(resolved, 'old token still resolves within grace');
  assert.equal(resolved.token, newToken, 'and resolves to the current device row');
  assert.equal(TOKEN_ROTATION_GRACE, 60, 'grace window is 60s');
});

test('rotation: revoking the device kills the CURRENT token (and only that device)', () => {
  const otherToken = createSessionToken(HOST_ID, 7 * 24 * 3600, 'bystander');
  const deviceToken = createSessionToken(HOST_ID, 7 * 24 * 3600, 'doomed-device');
  const currentToken = rotateSessionToken(deviceToken);

  // Revoke by the current token's row (what /api/devices/revoke does via prefix).
  revokeSessionToken(currentToken);

  assert.equal(getSessionToken(currentToken), null, 'current credential dead');
  assert.ok(getSessionToken(otherToken), 'unrelated device unaffected');
});

test('rotation: rotating twice chains grace aliases', () => {
  const t1 = createSessionToken(HOST_ID, 7 * 24 * 3600, 'chain-device');
  const t2 = rotateSessionToken(t1);
  const t3 = rotateSessionToken(t2);
  assert.notEqual(t2, t3);
  // Both predecessors resolve to the current row within grace.
  assert.ok(getSessionToken(t1), 't1 within grace');
  assert.ok(getSessionToken(t2), 't2 within grace');
  assert.equal(getSessionToken(t3).token, t3, 'current is itself');
  // Each chain member resolves to the SAME device row (single row still).
  const chainRows = listSessionTokens(HOST_ID).filter((r) => r.device_name === 'chain-device');
  assert.equal(chainRows.length, 1);
});

test('rotation: grace aliases resolve to THEIR OWN device, not the most recent one', () => {
  // Regression: the grace lookup used to pick the host's most-recently-used
  // row, so device A's rotated-out token could authenticate as device B when
  // B had been used more recently. Pin the fix: each alias resolves to its
  // own device row, regardless of interleaving.
  const tokenA = createSessionToken(HOST_ID, 7 * 24 * 3600, 'device-A');
  const tokenB = createSessionToken(HOST_ID, 7 * 24 * 3600, 'device-B');
  const rotatedA = rotateSessionToken(tokenA); // A rotates...
  createSessionToken(HOST_ID, 7 * 24 * 3600, 'device-C'); // ...then C is created (newest row)
  const resolved = getSessionToken(tokenA); // A's old value within grace
  assert.ok(resolved, 'grace alias resolves');
  assert.equal(resolved.device_name, 'device-A', 'must resolve to device A, not device B or C');
  assert.equal(resolved.token, rotatedA, 'and to A\'s current token');
});

// ── JTI blacklist ────────────────────────────────────────────────────────────

test('jti: added once → seen; cleanup removes expired', () => {
  addJti('jti-alive', Math.floor(Date.now() / 1000) + 3600);
  assert.ok(hasJti('jti-alive'));
  addJti('jti-dead', Math.floor(Date.now() / 1000) - 3600);
  cleanExpiredJtis();
  assert.ok(hasJti('jti-alive'), 'live jti survives cleanup');
  assert.equal(hasJti('jti-dead'), false, 'expired jti swept');
});

// ── Push subscriptions ───────────────────────────────────────────────────────

test('push subscriptions: upsert, list by host, delete', () => {
  upsertPushSubscription('https://push.example/ep1', HOST_ID, 'p256dh-1', 'auth-1', 'Pixel');
  upsertPushSubscription('https://push.example/ep2', HOST_ID, 'p256dh-2', 'auth-2', 'Pixel');
  let subs = getPushSubscriptions(HOST_ID);
  assert.equal(subs.length, 2);

  // Re-upsert same endpoint → replaced, not duplicated.
  upsertPushSubscription('https://push.example/ep1', HOST_ID, 'p256dh-1b', 'auth-1b', 'Pixel');
  subs = getPushSubscriptions(HOST_ID);
  assert.equal(subs.length, 2, 'upsert does not duplicate');
  assert.equal(subs.find((s) => s.endpoint.endsWith('ep1')).auth, 'auth-1b');

  deletePushSubscription('https://push.example/ep1');
  assert.equal(getPushSubscriptions(HOST_ID).length, 1);
});
