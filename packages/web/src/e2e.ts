// E2E encryption layer for the browser (WebCrypto API).
//
// Provides ECDH P-256 key agreement, HMAC-SHA256 signing (to authenticate the
// ECDH public keys against the shared e2e_secret, preventing relay MITM), and
// AES-256-GCM encryption/decryption. All operations are async (WebCrypto is
// promise-based). The agent side (packages/agent/src/e2e.ts) mirrors this API
// using node:crypto; the two MUST produce identical outputs for interop.
//
// Wire format for encrypted payloads:
//   { v: 1, iv: <base64 12-byte nonce>, ct: <base64 ciphertext+16-byte tag> }
//
// Handshake (after WS auth completes):
//   phone → agent: { type:'e2e_hello', pub: <base64 raw P-256 pubkey>, sig: HMAC(e2eSecret, pub) }
//   agent → phone: { type:'e2e_ack',   pub: <base64 raw P-256 pubkey>, sig: HMAC(e2eSecret, pub) }
// Both sides then derive: sessionKey = HKDF(ECDH(myPriv, theirPub), salt, info)

export interface E2ePayload {
  v: 1;
  iv: string;   // base64, 12 bytes
  ct: string;   // base64, ciphertext || 16-byte GCM auth tag
}

// ── helpers ──────────────────────────────────────────────────────────────────

function b64Encode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

const SALT = new TextEncoder().encode('airelay-e2e-v1');

// ── HMAC-SHA256 signing (for ECDH pubkey authentication) ─────────────────────

async function importHmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signPub(e2eSecretHex: string, pubKeyB64: string): Promise<string> {
  const key = await importHmacKey(hexToBytes(e2eSecretHex));
  const sig = await crypto.subtle.sign('HMAC', key, b64Decode(pubKeyB64));
  return b64Encode(sig);
}

export async function verifySig(e2eSecretHex: string, pubKeyB64: string, sigB64: string): Promise<boolean> {
  const key = await importHmacKey(hexToBytes(e2eSecretHex));
  return crypto.subtle.verify('HMAC', key, b64Decode(sigB64), b64Decode(pubKeyB64));
}

// ── ECDH key pair + derivation ───────────────────────────────────────────────

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export async function exportPubKey(keyPair: CryptoKeyPair): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return b64Encode(raw);
}

async function importPeerPub(pubB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', b64Decode(pubB64),
    { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
}

/**
 * Derive a 256-bit AES-GCM session key from the ECDH shared secret.
 * Uses HKDF-SHA256 with a fixed salt and info = sorted(phonePub, agentPub)
 * to ensure both sides derive the same key regardless of who is "phone" vs
 * "agent".
 */
export async function deriveSessionKey(
  myKeyPair: CryptoKeyPair,
  theirPubB64: string,
  myPubB64: string,
): Promise<CryptoKey> {
  const peerPub = await importPeerPub(theirPubB64);
  // ECDH shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPub }, myKeyPair.privateKey, 256,
  );
  // Import shared secret as HKDF key material
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  // Info = sorted concatenation of both pubkeys (canonical order)
  const pubs = [myPubB64, theirPubB64].sort();
  const info = new TextEncoder().encode(pubs[0] + pubs[1]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── AES-256-GCM encrypt / decrypt ────────────────────────────────────────────

export async function encrypt(key: CryptoKey, plaintext: string): Promise<E2ePayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { v: 1, iv: b64Encode(iv), ct: b64Encode(ct) };
}

export async function decrypt(key: CryptoKey, payload: E2ePayload): Promise<string> {
  const iv = b64Decode(payload.iv);
  const ct = b64Decode(payload.ct);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ── E2eSession — manages handshake state + encrypt/decrypt ───────────────────

export type E2eState = 'idle' | 'hello_sent' | 'ready';

export class E2eSession {
  private state: E2eState = 'idle';
  private e2eSecret: string; // hex
  private keyPair: CryptoKeyPair | null = null;
  private myPubB64: string = '';
  private sessionKey: CryptoKey | null = null;

  constructor(e2eSecret: string) {
    this.e2eSecret = e2eSecret;
  }

  get isReady(): boolean { return this.state === 'ready'; }

  /** Generate our ECDH keypair and produce the e2e_hello message to send. */
  async createHello(): Promise<{ type: 'e2e_hello'; pub: string; sig: string }> {
    this.keyPair = await generateKeyPair();
    this.myPubB64 = await exportPubKey(this.keyPair);
    const sig = await signPub(this.e2eSecret, this.myPubB64);
    this.state = 'hello_sent';
    return { type: 'e2e_hello', pub: this.myPubB64, sig };
  }

  /** Process the agent's e2e_ack, verify sig, derive session key. */
  async handleAck(msg: { pub: string; sig: string }): Promise<boolean> {
    if (this.state !== 'hello_sent' || !this.keyPair) return false;
    const valid = await verifySig(this.e2eSecret, msg.pub, msg.sig);
    if (!valid) return false;
    this.sessionKey = await deriveSessionKey(this.keyPair, msg.pub, this.myPubB64);
    this.state = 'ready';
    return true;
  }

  async encrypt(plaintext: string): Promise<E2ePayload> {
    if (!this.sessionKey) throw new Error('E2E session not ready');
    return encrypt(this.sessionKey, plaintext);
  }

  async decrypt(payload: E2ePayload): Promise<string> {
    if (!this.sessionKey) throw new Error('E2E session not ready');
    return decrypt(this.sessionKey, payload);
  }
}
