// Replay protection + plaintext-input rejection (security fixes).
//
// Covers:
//   1. E2eSession.decryptInput rejects seq reuse (replay) and older seq.
//   2. E2eSession.decryptInputBytes rejects seq reuse on the binary path.
//   3. seq is bound into the GCM AAD: a payload replayed under a forged
//      (increased) seq fails GCM authentication.
//   4. Handshake sig failure → handleHello returns null (downgrade guard).
//
// Run: node --test packages/agent/test/replay-protection.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createECDH, createHmac, hkdfSync, createCipheriv, createDecipheriv, randomBytes,
} from 'node:crypto';

const SALT = Buffer.from('airelay-e2e-v1', 'utf8');

// Real agent implementation (built by `tsc`; run `npm run build` first).
let AgentE2e;
try {
  ({ E2eSession: AgentE2e } = await import('../dist/e2e.js'));
} catch {
  AgentE2e = null;
}

function deriveClientKey(clientEcdh, agentPubB64, clientPubB64) {
  const shared = clientEcdh.computeSecret(Buffer.from(agentPubB64, 'base64'));
  const pubs = [clientPubB64, agentPubB64].sort();
  const info = Buffer.from(pubs[0] + pubs[1], 'utf8');
  return Buffer.from(hkdfSync('sha256', shared, SALT, info, 32));
}

function aadFor(seq) {
  return Buffer.from(JSON.stringify({ v: 1, seq }), 'utf8');
}

/** Client-side encrypt mirroring web encryptInput (JSON path). */
function clientEncryptJson(sessionKey, plaintext, seq) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sessionKey, iv);
  c.setAAD(aadFor(seq));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, seq, iv: iv.toString('base64'), ct: ct.toString('base64') };
}

/** Client-side encrypt mirroring web encryptInputBytes (binary path):
 *  seq(4, big-endian) || iv(12) || ct||tag. */
function clientEncryptBytes(sessionKey, plaintext, seq) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sessionKey, iv);
  c.setAAD(aadFor(seq));
  const body = Buffer.concat([iv, c.update(plaintext), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(seq >>> 0);
  return Buffer.concat([head, body]);
}

/** Stand up a handshaken agent session; returns { agent, sessionKey }. */
function handshake(e2eSecretHex) {
  const agent = new AgentE2e(e2eSecretHex);
  const clientEcdh = createECDH('prime256v1');
  clientEcdh.generateKeys();
  const clientPub = clientEcdh.getPublicKey('base64');
  const sig = createHmac('sha256', Buffer.from(e2eSecretHex, 'hex'))
    .update(Buffer.from(clientPub, 'base64')).digest('base64');
  const ack = agent.handleHello({ pub: clientPub, sig });
  assert.ok(ack, 'handshake should succeed');
  return { agent, sessionKey: deriveClientKey(clientEcdh, ack.pub, clientPub) };
}

test('decryptInput (JSON path) accepts in-order, rejects replay and older seq', { skip: !AgentE2e }, () => {
  const { agent, sessionKey } = handshake('a'.repeat(64));

  assert.equal(agent.decryptInput(clientEncryptJson(sessionKey, 'hello', 1)), 'hello');
  // Same payload again → replay rejected
  assert.throws(() => agent.decryptInput(clientEncryptJson(sessionKey, 'hello', 1)), /replay/);
  // Fresh payload with OLDER seq → rejected (even though cryptographically valid)
  assert.throws(() => agent.decryptInput(clientEncryptJson(sessionKey, 'x', 1)), /replay/);
  // In-order continues to work
  assert.equal(agent.decryptInput(clientEncryptJson(sessionKey, 'world', 2)), 'world');
  assert.equal(agent.decryptInput(clientEncryptJson(sessionKey, '!', 10)), '!');
  // Gap backward after forward jump → rejected
  assert.throws(() => agent.decryptInput(clientEncryptJson(sessionKey, 'y', 5)), /replay/);
});

test('decryptInputBytes (binary path) accepts in-order, rejects replay', { skip: !AgentE2e }, () => {
  const { agent, sessionKey } = handshake('b'.repeat(64));
  const enc = new TextEncoder();

  const f1 = clientEncryptBytes(sessionKey, enc.encode('ls\n'), 1);
  assert.equal(Buffer.from(agent.decryptInputBytes(f1)).toString('utf8'), 'ls\n');

  // Replay exact frame → rejected
  assert.throws(() => agent.decryptInputBytes(f1), /replay/);

  // Newer seq → ok
  const f2 = clientEncryptBytes(sessionKey, enc.encode('y\n'), 2);
  assert.equal(Buffer.from(agent.decryptInputBytes(f2)).toString('utf8'), 'y\n');
});

test('seq is AAD-bound: re-encrypting a captured payload with a forged higher seq fails GCM', { skip: !AgentE2e }, () => {
  const { agent, sessionKey } = handshake('c'.repeat(64));

  // Attacker captures seq=1 payload, mutates seq field to 99 to pass the
  // counter check. The GCM tag was computed over AAD {v:1,seq:1}; decrypting
  // with AAD {v:1,seq:99} must fail (tag mismatch), NOT return plaintext.
  const captured = clientEncryptJson(sessionKey, 'y\n', 1);
  agent.decryptInput(captured); // consume seq 1
  const forged = { ...captured, seq: 99 };
  assert.throws(() => agent.decryptInput(forged));

  // Same on the binary path: mutate the 4-byte header. Use high seqs — the
  // JSON part of this test already consumed 1 on the shared counter.
  const capturedBin = clientEncryptBytes(sessionKey, new TextEncoder().encode('pwn'), 100);
  agent.decryptInputBytes(capturedBin);
  const forgedBin = Buffer.from(capturedBin);
  forgedBin.writeUInt32BE(200, 0);
  assert.throws(() => agent.decryptInputBytes(forgedBin));
});

test('handleHello rejects a bad HMAC sig (relay key-substitution attempt)', { skip: !AgentE2e }, () => {
  const agent = new AgentE2e('d'.repeat(64));
  const clientEcdh = createECDH('prime256v1');
  clientEcdh.generateKeys();
  const clientPub = clientEcdh.getPublicKey('base64');
  const badSig = createHmac('sha256', Buffer.from('f'.repeat(64), 'hex'))
    .update(Buffer.from(clientPub, 'base64')).digest('base64');
  assert.equal(agent.handleHello({ pub: clientPub, sig: badSig }), null);
  assert.equal(agent.isReady, false);
});
