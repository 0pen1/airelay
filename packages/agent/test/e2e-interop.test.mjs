// E2E encryption interop test.
//
// Runs in Node.js 22+ which has both:
//   - node:crypto (the agent's implementation)
//   - globalThis.crypto (WebCrypto, the browser's implementation)
//
// This lets us verify cross-implementation interop in one process:
//   1. Agent side encrypts → Web side decrypts (and vice versa)
//   2. HMAC signatures are interchangeable
//   3. ECDH + HKDF produces the same session key on both sides
//   4. AES-256-GCM ciphertext format is identical

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createECDH, createHmac, createCipheriv, createDecipheriv,
  randomBytes, hkdfSync, timingSafeEqual,
} from 'node:crypto';

// ── Agent-side E2E (node:crypto) ────────────────────────────────────────────

const SALT = Buffer.from('airelay-e2e-v1', 'utf8');

function agentSignPub(e2eSecretHex, pubKeyB64) {
  return createHmac('sha256', Buffer.from(e2eSecretHex, 'hex'))
    .update(Buffer.from(pubKeyB64, 'base64'))
    .digest('base64');
}

function agentVerifySig(e2eSecretHex, pubKeyB64, sigB64) {
  const expected = Buffer.from(agentSignPub(e2eSecretHex, pubKeyB64), 'base64');
  const actual = Buffer.from(sigB64, 'base64');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function agentGenKeypair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, pubB64: ecdh.getPublicKey('base64') };
}

function agentDeriveKey(myKP, theirPubB64) {
  const sharedSecret = myKP.ecdh.computeSecret(Buffer.from(theirPubB64, 'base64'));
  const pubs = [myKP.pubB64, theirPubB64].sort();
  const info = Buffer.from(pubs[0] + pubs[1], 'utf8');
  return Buffer.from(hkdfSync('sha256', sharedSecret, SALT, info, 32));
}

function agentEncrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([ct, tag]);
  return { v: 1, iv: iv.toString('base64'), ct: combined.toString('base64') };
}

function agentDecrypt(key, payload) {
  const iv = Buffer.from(payload.iv, 'base64');
  const combined = Buffer.from(payload.ct, 'base64');
  const ct = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── Web-side E2E (WebCrypto API, available in Node 22+) ────────────────────

const webCrypto = globalThis.crypto.subtle;

function b64Encode(buf) {
  return Buffer.from(buf).toString('base64');
}

function b64Decode(s) {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function hexToBytes(hex) {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function webSignPub(e2eSecretHex, pubKeyB64) {
  const key = await webCrypto.importKey('raw', hexToBytes(e2eSecretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const sig = await webCrypto.sign('HMAC', key, b64Decode(pubKeyB64));
  return b64Encode(sig);
}

async function webVerifySig(e2eSecretHex, pubKeyB64, sigB64) {
  const key = await webCrypto.importKey('raw', hexToBytes(e2eSecretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return webCrypto.verify('HMAC', key, b64Decode(sigB64), b64Decode(pubKeyB64));
}

async function webGenKeypair() {
  const kp = await webCrypto.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = await webCrypto.exportKey('raw', kp.publicKey);
  return { kp, pubB64: b64Encode(raw) };
}

async function webDeriveKey(myKP, theirPubB64, myPubB64) {
  const peerPub = await webCrypto.importKey('raw', b64Decode(theirPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedBits = await webCrypto.deriveBits({ name: 'ECDH', public: peerPub }, myKP.privateKey, 256);
  const hkdfKey = await webCrypto.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const pubs = [myPubB64, theirPubB64].sort();
  const info = new TextEncoder().encode(pubs[0] + pubs[1]);
  return webCrypto.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function webEncrypt(key, plaintext) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ct = await webCrypto.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { v: 1, iv: b64Encode(iv), ct: b64Encode(ct) };
}

async function webDecrypt(key, payload) {
  const iv = b64Decode(payload.iv);
  const ct = b64Decode(payload.ct);
  const pt = await webCrypto.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ── Test data ────────────────────────────────────────────────────────────────

const TEST_SECRET_HEX = '75bd35632eed25345f25f6ec39538f29bb157f950ce7e011bfa1c2fc7af368e0';
const TEST_PLAINTEXTS = [
  'hello',
  'hello e2e test\n',
  '🤖 Claude Code response with emoji ✅',
  'A'.repeat(10000),  // large payload
  '',
  '\x1b[32mgreen text\x1b[0m\r\n\x1b[1mbold\x1b[0m',
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('HMAC signature interop', () => {
  it('agent sign → web verify', async () => {
    const pub = b64Encode(randomBytes(65)); // fake pubkey
    const sig = agentSignPub(TEST_SECRET_HEX, pub);
    const valid = await webVerifySig(TEST_SECRET_HEX, pub, sig);
    assert.equal(valid, true);
  });

  it('web sign → agent verify', async () => {
    const pub = b64Encode(randomBytes(65));
    const sig = await webSignPub(TEST_SECRET_HEX, pub);
    const valid = agentVerifySig(TEST_SECRET_HEX, pub, sig);
    assert.equal(valid, true);
  });

  it('wrong secret → verification fails', async () => {
    const pub = b64Encode(randomBytes(65));
    const sig = agentSignPub(TEST_SECRET_HEX, pub);
    const valid = await webVerifySig('deadbeef' + '0'.repeat(56), pub, sig);
    assert.equal(valid, false);
  });

  it('tampered pubkey → verification fails', async () => {
    const pub = b64Encode(randomBytes(65));
    const sig = agentSignPub(TEST_SECRET_HEX, pub);
    const tamperedPub = b64Encode(randomBytes(65));
    const valid = agentVerifySig(TEST_SECRET_HEX, tamperedPub, sig);
    assert.equal(valid, false);
  });
});

describe('ECDH key exchange interop', () => {
  it('both sides derive the same session key', async () => {
    const agentKP = agentGenKeypair();
    const webKP = await webGenKeypair();

    const agentKey = agentDeriveKey(agentKP, webKP.pubB64);
    const webKey = await webDeriveKey(webKP.kp, agentKP.pubB64, webKP.pubB64);

    // Verify keys match by encrypting the same plaintext on both sides
    // and confirming each can decrypt the other's ciphertext.
    const plaintext = 'interop key check';
    const agentEnc = agentEncrypt(agentKey, plaintext);
    const webDec = await webDecrypt(webKey, agentEnc);
    assert.equal(webDec, plaintext);

    const webEnc = await webEncrypt(webKey, plaintext);
    const agentDec = agentDecrypt(agentKey, webEnc);
    assert.equal(agentDec, plaintext);
  });

  it('public keys are 65 bytes (uncompressed P-256 point)', async () => {
    const agentKP = agentGenKeypair();
    const webKP = await webGenKeypair();

    const agentPub = Buffer.from(agentKP.pubB64, 'base64');
    const webPub = Buffer.from(webKP.pubB64, 'base64');

    assert.equal(agentPub.length, 65);
    assert.equal(webPub.length, 65);
    assert.equal(agentPub[0], 0x04); // uncompressed point prefix
    assert.equal(webPub[0], 0x04);
  });
});

describe('AES-256-GCM encrypt/decrypt interop', () => {
  // Set up shared session keys for cross-decrypt tests
  let agentKP, webKP, agentKey, webKey;

  it('setup: derive shared keys', async () => {
    agentKP = agentGenKeypair();
    webKP = await webGenKeypair();
    agentKey = agentDeriveKey(agentKP, webKP.pubB64);
    webKey = await webDeriveKey(webKP.kp, agentKP.pubB64, webKP.pubB64);
  });

  for (const pt of TEST_PLAINTEXTS) {
    const label = pt.length > 50 ? `${pt.length} chars` : JSON.stringify(pt);
    it(`agent encrypt → web decrypt: ${label}`, async () => {
      const payload = agentEncrypt(agentKey, pt);
      const decrypted = await webDecrypt(webKey, payload);
      assert.equal(decrypted, pt);
    });

    it(`web encrypt → agent decrypt: ${label}`, async () => {
      const payload = await webEncrypt(webKey, pt);
      const decrypted = agentDecrypt(agentKey, payload);
      assert.equal(decrypted, pt);
    });
  }

  it('tampered ciphertext → decrypt fails', async () => {
    const payload = agentEncrypt(agentKey, 'secret data');
    // Flip a bit in the ciphertext
    const ct = Buffer.from(payload.ct, 'base64');
    ct[0] ^= 0x01;
    payload.ct = ct.toString('base64');
    await assert.rejects(
      async () => webDecrypt(webKey, payload),
      /OperationError|decrypt/i,
    );
  });

  it('wrong key → decrypt fails', async () => {
    const payload = agentEncrypt(agentKey, 'secret data');
    // Derive with a different pair to get a different key
    const otherKP = await webGenKeypair();
    const otherAgentKP = agentGenKeypair();
    const otherKey = await webDeriveKey(otherKP.kp, otherAgentKP.pubB64, otherKP.pubB64);
    await assert.rejects(
      async () => webDecrypt(otherKey, payload),
      /OperationError|decrypt/i,
    );
  });

  it('IV is 12 bytes', () => {
    const payload = agentEncrypt(agentKey, 'test');
    const iv = Buffer.from(payload.iv, 'base64');
    assert.equal(iv.length, 12);
  });

  it('ciphertext includes 16-byte GCM tag', () => {
    const payload = agentEncrypt(agentKey, 'test');
    const ct = Buffer.from(payload.ct, 'base64');
    // plaintext "test" = 4 bytes + 16 byte tag = 20 bytes
    assert.equal(ct.length, 4 + 16);
  });

  it('each encryption uses a unique IV', () => {
    const ivs = new Set();
    for (let i = 0; i < 100; i++) {
      const payload = agentEncrypt(agentKey, 'test');
      ivs.add(payload.iv);
    }
    assert.equal(ivs.size, 100);
  });
});

describe('Full handshake simulation', () => {
  it('simulates complete E2E handshake + bidirectional encrypted communication', async () => {
    const e2eSecret = TEST_SECRET_HEX;

    // 1. Web (client) generates keypair + signs
    const webKP = await webGenKeypair();
    const webSig = await webSignPub(e2eSecret, webKP.pubB64);

    // 2. Agent verifies web's sig + generates own keypair + signs + derives key
    assert.ok(agentVerifySig(e2eSecret, webKP.pubB64, webSig));
    const agentKP = agentGenKeypair();
    const agentSig = agentSignPub(e2eSecret, agentKP.pubB64);
    const agentKey = agentDeriveKey(agentKP, webKP.pubB64);

    // 3. Web verifies agent's sig + derives key
    assert.ok(await webVerifySig(e2eSecret, agentKP.pubB64, agentSig));
    const webKey = await webDeriveKey(webKP.kp, agentKP.pubB64, webKP.pubB64);

    // 4. Bidirectional encrypted communication
    // Web → Agent
    const msg1 = 'hello from phone';
    const enc1 = await webEncrypt(webKey, msg1);
    assert.equal(agentDecrypt(agentKey, enc1), msg1);

    // Agent → Web
    const msg2 = 'ack from agent 🤖';
    const enc2 = agentEncrypt(agentKey, msg2);
    assert.equal(await webDecrypt(webKey, enc2), msg2);

    // Round-trip many messages
    for (let i = 0; i < 50; i++) {
      const pt = `message-${i}-🦀-\x1b[32mcolor\x1b[0m`;
      const enc = agentEncrypt(agentKey, pt);
      const dec = await webDecrypt(webKey, enc);
      assert.equal(dec, pt);
    }
  });
});
