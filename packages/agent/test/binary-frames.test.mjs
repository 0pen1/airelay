// Binary frame codec + bytes-level E2E tests.
//
// Verifies:
//   1. encodeBinaryFrame / decodeBinaryFrame roundtrip (shared package)
//   2. Malformed frames rejected (too short)
//   3. encryptBytes/decryptBytes roundtrip (agent node:crypto side)
//   4. Tampered / wrong-key / truncated binary E2E payload rejected
//   5. Web(node:crypto globalThis) ↔ Node byte-cipher interop both directions
//   6. Full E2eSession handshake, then byte encrypt/decrypt both ways
//
// The two crypto sides are inlined here (node:crypto for the agent,
// globalThis.crypto for the browser) exactly as in e2e-interop.test.mjs —
// packages/web has no standalone e2e build, so we mirror its implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHmac, createCipheriv, createDecipheriv, randomBytes,
} from 'node:crypto';
import {
  BinaryOpcode, encodeBinaryFrame, decodeBinaryFrame,
} from '@airelay/shared';

const e2eSecret = 'a'.repeat(64); // fake 32-byte hex secret

// ── Agent-side bytes cipher (node:crypto), mirrors agent/src/e2e.ts ───────────

function agentEncryptBytes(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

function agentDecryptBytes(key, payload) {
  if (payload.length < 12 + 16) throw new Error('too short');
  const iv = payload.subarray(0, 12);
  const combined = payload.subarray(12);
  const ct = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ── WebCrypto bytes cipher, mirrors web/src/e2e.ts (runs on node 22) ─────────

async function webEncryptBytes(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

async function webDecryptBytes(key, payload) {
  if (payload.length < 12 + 16) throw new Error('too short');
  const iv = payload.slice(0, 12);
  const ct = payload.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(pt);
}

// ECDH key derivation shared by both sides (matches e2e-interop.test.mjs)
const SALT = Buffer.from('airelay-e2e-v1', 'utf8');

function b64(buf) { return Buffer.from(buf).toString('base64'); }
function fromB64(s) { return Buffer.from(s, 'base64'); }

async function webKeypairAndKey(agentPubB64) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const webPubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const webPubB64 = b64(webPubRaw);
  const peerPub = await crypto.subtle.importKey('raw', fromB64(agentPubB64),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, kp.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const pubs = [webPubB64, agentPubB64].sort();
  const info = Buffer.from(pubs[0] + pubs[1], 'utf8');
  const webKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info }, hkdfKey,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  return { webKey, webPubB64 };
}

// ── Frame codec ───────────────────────────────────────────────────────────────

test('frame roundtrip: opcode + slot + payload', () => {
  const payload = new TextEncoder().encode('hello world\n');
  const frame = encodeBinaryFrame(BinaryOpcode.OUTPUT, 7, payload);
  assert.equal(frame[0], 0x01);
  assert.equal(frame[1], 7);
  const decoded = decodeBinaryFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.opcode, BinaryOpcode.OUTPUT);
  assert.equal(decoded.slot, 7);
  assert.deepEqual(decoded.payload, payload);
});

test('frame roundtrip: binary payload with high bytes', () => {
  const payload = Uint8Array.from([0x1b, 0x5b, 0x31, 0x6d, 0xff, 0x00, 0xfe]);
  const frame = encodeBinaryFrame(BinaryOpcode.INPUT, 255, payload);
  const decoded = decodeBinaryFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.opcode, BinaryOpcode.INPUT);
  assert.equal(decoded.slot, 255);
  assert.deepEqual(decoded.payload, payload);
});

test('frame roundtrip: empty payload', () => {
  const frame = encodeBinaryFrame(BinaryOpcode.OUTPUT, 0, new Uint8Array(0));
  assert.equal(frame.length, 2);
  const decoded = decodeBinaryFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.payload.length, 0);
});

test('frame decode: too short → null', () => {
  assert.equal(decodeBinaryFrame(new Uint8Array([0x01])), null);
  assert.equal(decodeBinaryFrame(new Uint8Array([])), null);
});

// ── Bytes-level E2E (node side) ───────────────────────────────────────────────

test('agent encryptBytes/decryptBytes roundtrip', () => {
  const key = Buffer.from('k'.repeat(32));
  const pt = Buffer.from('terminal output \x1b[32mgreen\x1b[0m\n', 'utf8');
  const payload = agentEncryptBytes(key, pt);
  assert.ok(payload.length >= 12 + 16 + pt.length);
  const rt = agentDecryptBytes(key, payload);
  assert.deepEqual(Buffer.from(rt), pt);
});

test('agent decryptBytes: tampered ciphertext rejected', () => {
  const key = Buffer.from('k'.repeat(32));
  const payload = agentEncryptBytes(key, Buffer.from('secret'));
  payload[payload.length - 5] ^= 0xff;
  assert.throws(() => agentDecryptBytes(key, payload));
});

test('agent decryptBytes: wrong key rejected', () => {
  const payload = agentEncryptBytes(Buffer.from('k'.repeat(32)), Buffer.from('secret'));
  assert.throws(() => agentDecryptBytes(Buffer.from('j'.repeat(32)), payload));
});

test('agent decryptBytes: truncated payload rejected', () => {
  const key = Buffer.from('k'.repeat(32));
  assert.throws(() => agentDecryptBytes(key, new Uint8Array(10)));
});

// ── Web ↔ Node byte interop ──────────────────────────────────────────────────

test('web encryptBytes → agent decryptBytes', async () => {
  // agent keypair (node:crypto ECDH)
  const { createECDH, hkdfSync } = await import('node:crypto');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const agentPubB64 = ecdh.getPublicKey('base64');

  const { webKey, webPubB64 } = await webKeypairAndKey(agentPubB64);
  // agent derives the same key
  const shared = ecdh.computeSecret(fromB64(webPubB64));
  const pubs = [webPubB64, agentPubB64].sort();
  const info = Buffer.from(pubs[0] + pubs[1], 'utf8');
  const agentKey = Buffer.from(hkdfSync('sha256', shared, SALT, info, 32));

  const pt = new TextEncoder().encode('binary input ^C\x03');
  const payload = await webEncryptBytes(webKey, pt);
  const rt = agentDecryptBytes(agentKey, payload);
  assert.deepEqual(new TextDecoder().decode(rt), 'binary input ^C\x03');
});

test('agent encryptBytes → web decryptBytes', async () => {
  const { createECDH, hkdfSync } = await import('node:crypto');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const agentPubB64 = ecdh.getPublicKey('base64');

  const { webKey, webPubB64 } = await webKeypairAndKey(agentPubB64);
  const shared = ecdh.computeSecret(fromB64(webPubB64));
  const pubs = [webPubB64, agentPubB64].sort();
  const info = Buffer.from(pubs[0] + pubs[1], 'utf8');
  const agentKey = Buffer.from(hkdfSync('sha256', shared, SALT, info, 32));

  const pt = new TextEncoder().encode('\x1b[2J\x1b[H screen clear');
  const payload = agentEncryptBytes(agentKey, pt);
  const rt = await webDecryptBytes(webKey, payload);
  assert.deepEqual(new TextDecoder().decode(rt), '\x1b[2J\x1b[H screen clear');
});

// ── Full frame + E2E simulation: agent output → binary frame → web decode ────

test('full path: agent encrypts output into binary frame, web decodes', async () => {
  const { createECDH, hkdfSync } = await import('node:crypto');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const agentPubB64 = ecdh.getPublicKey('base64');
  const { webKey, webPubB64 } = await webKeypairAndKey(agentPubB64);
  const shared = ecdh.computeSecret(fromB64(webPubB64));
  const pubs = [webPubB64, agentPubB64].sort();
  const info = Buffer.from(pubs[0] + pubs[1], 'utf8');
  const agentKey = Buffer.from(hkdfSync('sha256', shared, SALT, info, 32));

  // Agent: terminal output → E2E bytes → binary frame (slot 3)
  const terminalOutput = '\x1b[32mok\x1b[0m all tests pass\n';
  const encPayload = agentEncryptBytes(agentKey, Buffer.from(terminalOutput, 'utf8'));
  const frame = encodeBinaryFrame(BinaryOpcode.OUTPUT, 3, encPayload);

  // Relay forwards bytes untouched.

  // Web: decode frame → decrypt bytes → recover plaintext
  const decoded = decodeBinaryFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.opcode, BinaryOpcode.OUTPUT);
  assert.equal(decoded.slot, 3);
  const rt = await webDecryptBytes(webKey, decoded.payload);
  assert.deepEqual(new TextDecoder().decode(rt), terminalOutput);
});
