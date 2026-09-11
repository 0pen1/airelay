// E2E encryption layer for the agent (node:crypto).
//
// Mirrors the browser's packages/web/src/e2e.ts API using node:crypto.
// The two implementations MUST produce identical ciphertext/signatures for
// interop. Parameters are pinned:
//   ECDH: P-256 (prime256v1), uncompressed point format (65 bytes raw)
//   HMAC: SHA-256
//   HKDF: SHA-256, salt = "airelay-e2e-v1", info = sorted(pubA, pubB) base64
//   AES:  AES-256-GCM, 12-byte IV, 16-byte auth tag appended to ciphertext

import {
  createECDH, createHmac, createCipheriv, createDecipheriv,
  randomBytes, hkdfSync, timingSafeEqual,
} from 'node:crypto';

export interface E2ePayload {
  v: 1;
  /** Input sequence number — bound into GCM AAD for replay protection. */
  seq?: number;
  iv: string;   // base64, 12 bytes
  ct: string;   // base64, ciphertext || 16-byte GCM auth tag
}

const SALT = Buffer.from('airelay-e2e-v1', 'utf8');

// ── HMAC-SHA256 signing (for ECDH pubkey authentication) ─────────────────────

export function signPub(e2eSecretHex: string, pubKeyB64: string): string {
  return createHmac('sha256', Buffer.from(e2eSecretHex, 'hex'))
    .update(Buffer.from(pubKeyB64, 'base64'))
    .digest('base64');
}

export function verifySig(e2eSecretHex: string, pubKeyB64: string, sigB64: string): boolean {
  const expected = Buffer.from(signPub(e2eSecretHex, pubKeyB64), 'base64');
  const actual = Buffer.from(sigB64, 'base64');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ── ECDH key pair + derivation ───────────────────────────────────────────────

export interface AgentKeyPair {
  ecdh: ReturnType<typeof createECDH>;
  pubB64: string;
}

export function generateKeyPair(): AgentKeyPair {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // Export as uncompressed point (65 bytes) in base64 — matches WebCrypto 'raw' format
  const pubB64 = ecdh.getPublicKey('base64');
  return { ecdh, pubB64 };
}

/**
 * Derive a 256-bit AES-GCM session key from the ECDH shared secret.
 * Uses HKDF-SHA256, same parameters as the browser side.
 */
export function deriveSessionKey(
  myKeyPair: AgentKeyPair,
  theirPubB64: string,
): Buffer {
  const peerPub = Buffer.from(theirPubB64, 'base64');
  const sharedSecret = myKeyPair.ecdh.computeSecret(peerPub);
  // Info = sorted concatenation of both pubkeys (canonical order, same as browser)
  const pubs = [myKeyPair.pubB64, theirPubB64].sort();
  const info = Buffer.from(pubs[0] + pubs[1], 'utf8');
  // HKDF-SHA256 → 32 bytes
  return Buffer.from(hkdfSync('sha256', sharedSecret, SALT, info, 32));
}

// ── AES-256-GCM encrypt / decrypt ────────────────────────────────────────────

export function encrypt(key: Buffer, plaintext: string, aad?: Buffer): E2ePayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  // Concatenate ciphertext + tag (same layout as WebCrypto AES-GCM output)
  const combined = Buffer.concat([ct, tag]);
  return { v: 1, iv: iv.toString('base64'), ct: combined.toString('base64') };
}

export function decrypt(key: Buffer, payload: E2ePayload, aad?: Buffer): string {
  const iv = Buffer.from(payload.iv, 'base64');
  const combined = Buffer.from(payload.ct, 'base64');
  // Last 16 bytes = auth tag; rest = ciphertext
  const ct = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── Raw-byte AES-256-GCM (binary frame payloads) ─────────────────────────────
//
// Same wire layout as E2ePayload but without base64: payload = iv(12) || ct||tag.
// Used for terminal I/O binary frames where base64+JSON overhead is avoided.

export function encryptBytes(key: Buffer, plaintext: Uint8Array, aad?: Buffer): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

export function decryptBytes(key: Buffer, payload: Uint8Array, aad?: Buffer): Uint8Array {
  if (payload.length < 12 + 16) throw new Error('E2E payload too short');
  const iv = payload.subarray(0, 12);
  const combined = payload.subarray(12);
  const ct = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── E2eSession — manages handshake state + encrypt/decrypt (agent side) ──────

export type E2eState = 'idle' | 'ready';

export class E2eSession {
  private state: E2eState = 'idle';
  private e2eSecret: string; // hex
  private keyPair: AgentKeyPair | null = null;
  private sessionKey: Buffer | null = null;
  // Replay protection (input direction): the client's sequence counter must
  // strictly increase. A captured payload replayed by the relay fails here
  // (and fails GCM anyway, since seq is bound into the AAD).
  private recvSeq = 0;

  constructor(e2eSecret: string) {
    this.e2eSecret = e2eSecret;
  }

  get isReady(): boolean { return this.state === 'ready'; }

  /**
   * Handle the client's e2e_hello: verify its sig, generate our keypair,
   * derive the shared session key, and return the e2e_ack to send back.
   */
  handleHello(msg: { pub: string; sig: string }): { type: 'e2e_ack'; pub: string; sig: string } | null {
    if (!verifySig(this.e2eSecret, msg.pub, msg.sig)) return null;
    this.keyPair = generateKeyPair();
    this.sessionKey = deriveSessionKey(this.keyPair, msg.pub);
    const sig = signPub(this.e2eSecret, this.keyPair.pubB64);
    this.state = 'ready';
    return { type: 'e2e_ack', pub: this.keyPair.pubB64, sig };
  }

  encrypt(plaintext: string): E2ePayload {
    if (!this.sessionKey) throw new Error('E2E session not ready');
    return encrypt(this.sessionKey, plaintext);
  }

  /**
   * Decrypt an INPUT payload with replay protection: the payload's seq must
   * match the AAD used at encryption (else GCM fails) and strictly exceed the
   * last accepted seq (else it is a replay). Throws on any violation.
   */
  decryptInput(payload: E2ePayload): string {
    if (!this.sessionKey) throw new Error('E2E session not ready');
    const seq = payload.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= this.recvSeq) {
      throw new Error('E2E input replay rejected');
    }
    const aad = Buffer.from(JSON.stringify({ v: 1, seq }), 'utf8');
    const plaintext = decrypt(this.sessionKey, payload, aad);
    this.recvSeq = seq;
    return plaintext;
  }

  /**
   * Decrypt raw INPUT bytes for a binary frame with replay protection.
   * Wire layout: seq(4, big-endian) || iv(12) || ct||tag — the sender's
   * counter travels in a fixed header and is bound into the GCM AAD, so a
   * replayed frame both fails the counter check and (if seq were mutated to
   * pass it) fails the GCM tag.
   */
  decryptInputBytes(payload: Uint8Array): Uint8Array {
    if (!this.sessionKey) throw new Error('E2E session not ready');
    if (payload.length < 4 + 12 + 16) throw new Error('E2E payload too short');
    const seq = (payload[0] << 24 | payload[1] << 16 | payload[2] << 8 | payload[3]) >>> 0;
    if (seq <= this.recvSeq) throw new Error('E2E input replay rejected');
    const aad = Buffer.from(JSON.stringify({ v: 1, seq }), 'utf8');
    const plaintext = decryptBytes(this.sessionKey, payload.subarray(4), aad);
    this.recvSeq = seq;
    return plaintext;
  }

  /** Encrypt raw bytes for a binary frame (output direction — no seq). */
  encryptBytes(plaintext: Uint8Array): Uint8Array {
    if (!this.sessionKey) throw new Error('E2E session not ready');
    return encryptBytes(this.sessionKey, plaintext);
  }

  /** Decrypt a binary frame payload (non-input): iv(12) || ct||tag. */
  decryptBytes(payload: Uint8Array): Uint8Array {
    if (!this.sessionKey) throw new Error('E2E session not ready');
    return decryptBytes(this.sessionKey, payload);
  }
}
