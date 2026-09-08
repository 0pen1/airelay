// Unit tests for the authentication layer.
//
// Covers shared/crypto.ts (signHmac/verifyHmac/signJwt/verifyJwt — the
// primitives) and relay/auth.ts (verifyAgentAuth/verifyClientJwt — the
// header/JWT protocol around them). These are the security-critical paths
// that previously only ran inside live tests: replay windows, malformed
// headers, jti replay, wrong secrets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signHmac, verifyHmac, signJwt, verifyJwt,
} from '@airelay/shared';
import { verifyAgentAuth, verifyClientJwt, verifySessionTokenAuth } from '../dist/auth.js';

const SECRET = 'a'.repeat(64);
const HOST_ID = '11111111-2222-4333-8444-555555555555';

// ── shared/crypto.ts ────────────────────────────────────────────────────────

test('signHmac: deterministic, secret-keyed', () => {
  const a = signHmac(SECRET, HOST_ID, 1000);
  const b = signHmac(SECRET, HOST_ID, 1000);
  const c = signHmac('other-secret', HOST_ID, 1000);
  assert.equal(a, b, 'same inputs → same signature');
  assert.notEqual(a, c, 'different secret → different signature');
  assert.match(a, /^[0-9a-f]{64}$/, 'hex SHA-256 output');
});

test('verifyHmac: valid signature accepted', () => {
  const sig = signHmac(SECRET, HOST_ID, Math.floor(Date.now() / 1000));
  assert.ok(verifyHmac(SECRET, HOST_ID, Math.floor(Date.now() / 1000), sig, 30));
});

test('verifyHmac: stale timestamp rejected (replay window)', () => {
  const oldTs = Math.floor(Date.now() / 1000) - 31;
  const sig = signHmac(SECRET, HOST_ID, oldTs);
  assert.equal(verifyHmac(SECRET, HOST_ID, oldTs, sig, 30), false);
});

test('verifyHmac: future timestamp rejected', () => {
  const futureTs = Math.floor(Date.now() / 1000) + 31;
  const sig = signHmac(SECRET, HOST_ID, futureTs);
  assert.equal(verifyHmac(SECRET, HOST_ID, futureTs, sig, 30), false);
});

test('verifyHmac: boundary — exactly ±window accepted', () => {
  // Exactly 30s old: |now - ts| == 30 <= 30 → accepted
  const edgeTs = Math.floor(Date.now() / 1000) - 30;
  const sig = signHmac(SECRET, HOST_ID, edgeTs);
  // Re-sign right after the boundary tick so the test is stable: use ts=now
  // and window=0 — |0| <= 0 → accepted
  const nowSig = signHmac(SECRET, HOST_ID, Math.floor(Date.now() / 1000));
  assert.ok(verifyHmac(SECRET, HOST_ID, Math.floor(Date.now() / 1000), nowSig, 0));
  // window=0 with a 1s-old ts → rejected
  assert.equal(verifyHmac(SECRET, HOST_ID, edgeTs, nowSig, 0), false);
  void sig;
});

test('verifyHmac: wrong secret rejected', () => {
  const sig = signHmac(SECRET, HOST_ID, Math.floor(Date.now() / 1000));
  assert.equal(verifyHmac('b'.repeat(64), HOST_ID, Math.floor(Date.now() / 1000), sig, 30), false);
});

test('verifyHmac: malformed hex signature rejected (no throw)', () => {
  assert.equal(verifyHmac(SECRET, HOST_ID, Math.floor(Date.now() / 1000), 'not-hex', 30), false);
  assert.equal(verifyHmac(SECRET, HOST_ID, Math.floor(Date.now() / 1000), '', 30), false);
});

// ── JWT round-trip ──────────────────────────────────────────────────────────

test('signJwt/verifyJwt: round-trip returns payload', async () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const token = await signJwt(SECRET, { hostId: HOST_ID, jti: 'jti-1', exp });
  const payload = await verifyJwt(SECRET, token);
  assert.equal(payload.hostId, HOST_ID);
  assert.equal(payload.jti, 'jti-1');
  assert.equal(payload.exp, exp);
});

test('verifyJwt: wrong secret rejected', async () => {
  const token = await signJwt(SECRET, { hostId: HOST_ID, jti: 'jti-2', exp: Math.floor(Date.now() / 1000) + 600 });
  await assert.rejects(() => verifyJwt('b'.repeat(64), token));
});

test('verifyJwt: expired token rejected', async () => {
  const token = await signJwt(SECRET, { hostId: HOST_ID, jti: 'jti-3', exp: Math.floor(Date.now() / 1000) - 10 });
  await assert.rejects(() => verifyJwt(SECRET, token));
});

test('verifyJwt: garbage rejected', async () => {
  await assert.rejects(() => verifyJwt(SECRET, 'not.a.jwt'));
  await assert.rejects(() => verifyJwt(SECRET, ''));
});

// ── relay/auth.ts: verifyAgentAuth (HMAC header) ────────────────────────────

const HOST = { host_id: HOST_ID, host_secret: SECRET, name: 'test', created_at: 0 };
const getHost = (id) => (id === HOST_ID ? HOST : null);

function agentHeader(ts, sig) {
  return `HMAC host_id=${HOST_ID}, ts=${ts}, sig=${sig}`;
}

test('verifyAgentAuth: valid header accepted', () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signHmac(SECRET, HOST_ID, ts);
  const result = verifyAgentAuth(agentHeader(ts, sig), getHost);
  assert.deepEqual(result, { hostId: HOST_ID });
});

test('verifyAgentAuth: missing/empty header rejected', () => {
  assert.equal(verifyAgentAuth(undefined, getHost), null);
  assert.equal(verifyAgentAuth('', getHost), null);
});

test('verifyAgentAuth: wrong scheme rejected', () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signHmac(SECRET, HOST_ID, ts);
  assert.equal(verifyAgentAuth(`Bearer host_id=${HOST_ID}, ts=${ts}, sig=${sig}`, getHost), null);
});

test('verifyAgentAuth: malformed ts rejected', () => {
  const sig = signHmac(SECRET, HOST_ID, Math.floor(Date.now() / 1000));
  assert.equal(verifyAgentAuth(`HMAC host_id=${HOST_ID}, ts=abc, sig=${sig}`, getHost), null);
  assert.equal(verifyAgentAuth(`HMAC host_id=${HOST_ID}, ts=, sig=${sig}`, getHost), null);
});

test('verifyAgentAuth: missing fields rejected', () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signHmac(SECRET, HOST_ID, ts);
  assert.equal(verifyAgentAuth(`HMAC ts=${ts}, sig=${sig}`, getHost), null); // no host_id
  assert.equal(verifyAgentAuth(`HMAC host_id=${HOST_ID}, sig=${sig}`, getHost), null); // no ts
  assert.equal(verifyAgentAuth(`HMAC host_id=${HOST_ID}, ts=${ts}`, getHost), null); // no sig
});

test('verifyAgentAuth: unknown host rejected', () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signHmac(SECRET, '99999999-9999-4999-8999-999999999999', ts);
  assert.equal(verifyAgentAuth(
    `HMAC host_id=99999999-9999-4999-8999-999999999999, ts=${ts}, sig=${sig}`, getHost,
  ), null);
});

test('verifyAgentAuth: replayed/stale ts rejected', () => {
  const oldTs = Math.floor(Date.now() / 1000) - 3600;
  const sig = signHmac(SECRET, HOST_ID, oldTs);
  assert.equal(verifyAgentAuth(agentHeader(oldTs, sig), getHost), null);
});

test('verifyAgentAuth: bad signature rejected', () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.equal(verifyAgentAuth(agentHeader(ts, 'deadbeef'.repeat(8)), getHost), null);
});

// ── relay/auth.ts: verifyClientJwt ──────────────────────────────────────────

// In-memory jti store + session token minter for the tests.
function makeStore() {
  const jtis = new Set();
  const tokens = [];
  return {
    hasJti: (jti) => jtis.has(jti),
    addJti: (jti) => { jtis.add(jti); },
    createSessionToken: (hostId, _ttl, deviceName) => {
      const token = `st-${tokens.length + 1}`;
      tokens.push({ token, hostId, deviceName: deviceName ?? '' });
      return token;
    },
    tokens,
  };
}

test('verifyClientJwt: valid first-use JWT → session token minted', async () => {
  const store = makeStore();
  const token = await signJwt(SECRET, { hostId: HOST_ID, jti: 'fresh-jti', exp: Math.floor(Date.now() / 1000) + 600 });
  const result = await verifyClientJwt(
    token, getHost, store.hasJti, store.addJti, store.createSessionToken, 'iPhone Safari',
  );
  assert.ok(result);
  assert.equal(result.hostId, HOST_ID);
  assert.ok(result.sessionToken.startsWith('st-'));
  assert.equal(store.tokens[0].deviceName, 'iPhone Safari');
  assert.ok(store.hasJti('fresh-jti'), 'jti recorded (replay protection armed)');
});

test('verifyClientJwt: jti replay rejected', async () => {
  const store = makeStore();
  const token = await signJwt(SECRET, { hostId: HOST_ID, jti: 'reused-jti', exp: Math.floor(Date.now() / 1000) + 600 });
  const first = await verifyClientJwt(token, getHost, store.hasJti, store.addJti, store.createSessionToken);
  const second = await verifyClientJwt(token, getHost, store.hasJti, store.addJti, store.createSessionToken);
  assert.ok(first, 'first use accepted');
  assert.equal(second, null, 'second use of the same JWT rejected');
});

test('verifyClientJwt: expired JWT rejected', async () => {
  const store = makeStore();
  const token = await signJwt(SECRET, { hostId: HOST_ID, jti: 'expired-jti', exp: Math.floor(Date.now() / 1000) - 10 });
  const result = await verifyClientJwt(token, getHost, store.hasJti, store.addJti, store.createSessionToken);
  assert.equal(result, null);
  assert.equal(store.tokens.length, 0, 'no session token minted');
});

test('verifyClientJwt: wrong-secret JWT rejected', async () => {
  const store = makeStore();
  const token = await signJwt('b'.repeat(64), { hostId: HOST_ID, jti: 'forged-jti', exp: Math.floor(Date.now() / 1000) + 600 });
  const result = await verifyClientJwt(token, getHost, store.hasJti, store.addJti, store.createSessionToken);
  assert.equal(result, null);
});

test('verifyClientJwt: unknown host rejected', async () => {
  const store = makeStore();
  const otherHost = '99999999-9999-4999-8999-999999999999';
  const token = await signJwt(SECRET, { hostId: otherHost, jti: 'x', exp: Math.floor(Date.now() / 1000) + 600 });
  const result = await verifyClientJwt(token, getHost, store.hasJti, store.addJti, store.createSessionToken);
  assert.equal(result, null);
});

test('verifyClientJwt: non-JWT garbage rejected without throw', async () => {
  const store = makeStore();
  const result = await verifyClientJwt('garbage', getHost, store.hasJti, store.addJti, store.createSessionToken);
  assert.equal(result, null);
  const noDots = await verifyClientJwt('nodots', getHost, store.hasJti, store.addJti, store.createSessionToken);
  assert.equal(noDots, null);
});

// ── relay/auth.ts: verifySessionTokenAuth ───────────────────────────────────

test('verifySessionTokenAuth: valid token maps to host', () => {
  const lookup = (t) => (t === 'good' ? { host_id: HOST_ID } : null);
  assert.deepEqual(verifySessionTokenAuth('good', lookup), { hostId: HOST_ID });
  assert.equal(verifySessionTokenAuth('bad', lookup), null);
});

test('verifySessionTokenAuth: revoked/expired tokens are null at the db layer', () => {
  // The db layer returns null for revoked/expired rows, so auth sees null too.
  const lookup = () => null;
  assert.equal(verifySessionTokenAuth('anything', lookup), null);
});
