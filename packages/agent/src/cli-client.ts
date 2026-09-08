// CLI WebSocket client: connects to the relay as a client (same protocol as
// the phone), authenticates with a fresh short-lived JWT minted from the
// local host_secret, and performs E2E handshake so logs/input are encrypted.
//
// Minting the JWT locally means no persisted client credential is needed —
// the CLI holds the same secret as the daemon, on the same machine. The
// relay sees a normal first-time client and issues a one-off session token
// for the duration of the command.

import { WebSocket } from 'ws';
import { createHmac, createECDH, hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SignJWT } from 'jose';
import { v4 as uuidv4 } from 'uuid';
import { BinaryOpcode, decodeBinaryFrame, encodeBinaryFrame } from '@airelay/shared';

const SALT = Buffer.from('airelay-e2e-v1', 'utf8');

interface Config {
  relayUrl: string;
  hostId: string;
  hostSecret: string;
}

export function loadConfig(): Config {
  return JSON.parse(readFileSync(join(homedir(), '.config', 'airelay', 'config.json'), 'utf8')) as Config;
}

export interface SessionListItem {
  session_id: string;
  agent_id: string;
  agent_name: string;
  icon: string;
  created_at: number;
  locked_by: string | null;
}

/** One live CLI connection. Create per command with `connect()`. */
export class CliClient {
  private ws!: WebSocket;
  private e2eKey: Buffer | null = null;
  private ecdh = createECDH('prime256v1');
  private slots = new Map<number, string>(); // slot → session_id
  private slotsBySession = new Map<string, number>();
  private waiters: Array<{ pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  private binaryBuffer = ''; // decrypted UTF-8 output accumulation (all sessions)
  private binaryBySession = new Map<string, string>();
  private scrollback = new Map<string, { chunks: Map<number, string>; done: boolean }>();

  constructor(private config: Config) {
    this.ecdh.generateKeys();
  }

  get e2eReady(): boolean { return this.e2eKey !== null; }

  /** Open, auth (JWT → session token), E2E handshake. Resolves once ready. */
  async connect(): Promise<void> {
    const url = this.config.relayUrl.replace(/^http/, 'ws') + '/ws/client';
    this.ws = new WebSocket(url);
    // Register the message handler BEFORE sending anything — early messages
    // (authed, session_token_issued) must not be missed.
    this.ws.on('message', (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    await new Promise<void>((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });

    const jwt = await new SignJWT({ hostId: this.config.hostId, jti: uuidv4() })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode(this.config.hostSecret));
    this.ws.send(JSON.stringify({ type: 'auth', token: jwt, device_name: 'CLI' }));
    await this.waitFor((m) => m.type === 'authed', 'authed');

    // E2E handshake (same math as the web client, node:crypto flavor)
    const myPub = this.ecdh.getPublicKey('base64');
    const sig = createHmac('sha256', Buffer.from(this.e2eSecretHex(), 'hex'))
      .update(Buffer.from(myPub, 'base64')).digest('base64');
    this.ws.send(JSON.stringify({ type: 'e2e_hello', pub: myPub, sig }));
    const ack = await this.waitFor((m) => m.type === 'e2e_ack', 'e2e_ack') as { pub: string; sig: string };
    const expected = createHmac('sha256', Buffer.from(this.e2eSecretHex(), 'hex'))
      .update(Buffer.from(ack.pub, 'base64')).digest('base64');
    if (expected !== ack.sig) throw new Error('e2e_ack signature invalid — possible relay MITM');
    const shared = this.ecdh.computeSecret(Buffer.from(ack.pub, 'base64'));
    const pubs = [myPub, ack.pub].sort();
    const info = Buffer.from(pubs[0] + pubs[1], 'utf8');
    this.e2eKey = Buffer.from(hkdfSync('sha256', shared, SALT, info, 32));
  }

  private e2eSecretHex(): string {
    return createHmac('sha256', this.config.hostSecret).update('airelay-e2e-auth').digest('hex');
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      if (data.length < 2) return;
      const decoded = decodeBinaryFrame(new Uint8Array(data));
      if (!decoded || decoded.opcode !== BinaryOpcode.OUTPUT) return;
      const sid = this.slots.get(decoded.slot);
      if (!sid) return;
      const text = this.decryptBytes(decoded.payload).toString('utf8');
      this.binaryBuffer += text;
      this.binaryBySession.set(sid, (this.binaryBySession.get(sid) ?? '') + text);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg['type'] === 'attached' && typeof msg['slot'] === 'number') {
      const sid = msg['session_id'] as string;
      this.slots.set(msg['slot'] as number, sid);
      this.slotsBySession.set(sid, msg['slot'] as number);
    }
    if (msg['type'] === 'scrollback') {
      const sid = msg['session_id'] as string;
      let entry = this.scrollback.get(sid);
      if (!entry) { entry = { chunks: new Map(), done: false }; this.scrollback.set(sid, entry); }
      entry.chunks.set(msg['seq'] as number, this.decryptText(msg));
      if (msg['done'] === true) entry.done = true;
    }
    this.dispatch(msg);
  }

  /** Decrypt a JSON message's e2e payload (or return its plaintext data). */
  private decryptText(msg: Record<string, unknown>): string {
    if (msg['e2e'] && this.e2eKey) {
      const p = msg['e2e'] as { iv: string; ct: string };
      const iv = Buffer.from(p.iv, 'base64');
      const combined = Buffer.from(p.ct, 'base64');
      const d = createDecipheriv('aes-256-gcm', this.e2eKey, iv);
      d.setAuthTag(combined.subarray(combined.length - 16));
      return Buffer.concat([d.update(combined.subarray(0, combined.length - 16)), d.final()]).toString('utf8');
    }
    return (msg['data'] as string) ?? '';
  }

  private decryptBytes(payload: Uint8Array): Buffer {
    if (!this.e2eKey) return Buffer.from(payload);
    const iv = payload.subarray(0, 12);
    const rest = payload.subarray(12);
    const d = createDecipheriv('aes-256-gcm', this.e2eKey, iv);
    d.setAuthTag(rest.subarray(rest.length - 16));
    return Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]);
  }

  private encryptBytes(plaintext: Uint8Array): Buffer {
    const key = this.e2eKey;
    if (!key) return Buffer.from(plaintext);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, c.update(plaintext), c.final(), c.getAuthTag()]);
  }

  private dispatch(msg: Record<string, unknown>): void {
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].pred(msg)) {
        this.waiters.splice(i, 1)[0].resolve(msg);
        return;
      }
    }
  }

  /** Wait for the next message matching pred (up to timeoutMs). */
  waitFor(pred: (m: Record<string, unknown>) => boolean, label = 'message', timeoutMs = 8000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => { clearTimeout(t); resolve(m); },
      });
    });
  }

  sendJson(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async listSessions(): Promise<SessionListItem[]> {
    this.sendJson({ type: 'list_sessions' });
    const m = await this.waitFor((x) => x['type'] === 'sessions_list', 'sessions_list');
    return m['sessions'] as SessionListItem[];
  }

  /** Attach and collect scrollback. Resolves with the full scrollback text. */
  async attachWithScrollback(sessionId: string): Promise<string> {
    this.sendJson({ type: 'attach', session_id: sessionId });
    await this.waitFor((m) => m['type'] === 'attached' && m['session_id'] === sessionId, 'attached');
    // Scrollback arrives after `attached` — wait for it to show up (up to 5s),
    // then for its final chunk. An empty session still sends one done chunk.
    const deadline = Date.now() + 5000;
    let entry = this.scrollback.get(sessionId);
    while (!entry && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      entry = this.scrollback.get(sessionId);
    }
    if (!entry) return '';
    while (!entry.done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const keys = Array.from(entry.chunks.keys()).sort((a, b) => a - b);
    return keys.map((k) => entry.chunks.get(k)).join('');
  }

  /** Send user input to a session (binary frame when a slot is known). */
  sendInput(sessionId: string, data: string): void {
    const slot = this.slotsBySession.get(sessionId);
    if (slot !== undefined) {
      this.ws.send(encodeBinaryFrame(BinaryOpcode.INPUT, slot, this.encryptBytes(Buffer.from(data, 'utf8'))));
    } else {
      const msg: Record<string, unknown> = { type: 'input', session_id: sessionId, data };
      if (this.e2eKey) {
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', this.e2eKey, iv);
        const ct = Buffer.concat([c.update(Buffer.from(data, 'utf8')), c.final(), c.getAuthTag()]);
        msg['e2e'] = { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64') };
        delete msg['data'];
      }
      this.sendJson(msg);
    }
  }

  /** Drain live binary output accumulated since last drain (all sessions). */
  drainOutput(sessionId?: string): string {
    if (sessionId) {
      const text = this.binaryBySession.get(sessionId) ?? '';
      this.binaryBySession.delete(sessionId);
      return text;
    }
    const text = this.binaryBuffer;
    this.binaryBuffer = '';
    return text;
  }

  detach(sessionId: string): void {
    this.sendJson({ type: 'detach', session_id: sessionId });
    const slot = this.slotsBySession.get(sessionId);
    if (slot !== undefined) {
      this.slots.delete(slot);
      this.slotsBySession.delete(sessionId);
    }
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}
