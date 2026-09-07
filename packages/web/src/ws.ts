// WebSocket manager with auto-reconnect, session_token persistence,
// and optional E2E encryption (ECDH + AES-256-GCM).

import { E2eSession, type E2ePayload } from './e2e.js';

export type MessageHandler = (msg: Record<string, unknown>) => void;

export class WSManager {
  private ws: WebSocket | null = null;
  private url: string = '';
  private token: string = '';
  private handlers = new Set<MessageHandler>();
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatusChange: (connected: boolean, reconnecting: boolean) => void = () => {};
  private onAuthFail: () => void = () => {};

  // ── E2E state ───────────────────────────────────────────────────────────
  private e2eSecret: string | null = null; // hex, from HostEntry; null = no E2E
  private e2eSession: E2eSession | null = null;

  setStatusCallback(cb: (connected: boolean, reconnecting: boolean) => void): void {
    this.onStatusChange = cb;
  }

  setAuthFailCallback(cb: () => void): void {
    this.onAuthFail = cb;
  }

  /** Set the E2E secret for the next connection. null = plaintext mode. */
  setE2eSecret(secret: string | null): void {
    this.e2eSecret = secret;
  }

  on(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  connect(relayUrl: string, token: string): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.url = relayUrl.replace(/^http/, 'ws') + '/ws/client';
    this.token = token;
    this.reconnectDelay = 1000;
    // Reset E2E session on every (re)connect — new ECDH handshake needed.
    this.e2eSession = null;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.token }));
      this.reconnectDelay = 1000;
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      // Persist session_token issued by relay
      if (msg['type'] === 'session_token_issued' && typeof msg['session_token'] === 'string') {
        localStorage.setItem('airelay_session_token', msg['session_token'] as string);
        this.token = msg['session_token'] as string;
      }

      // Relay confirms auth — initiate E2E handshake if we have a secret.
      if (msg['type'] === 'authed') {
        this.onStatusChange(true, false);
        if (this.e2eSecret) {
          this.initiateE2eHandshake();
        }
        return;
      }

      // E2E handshake response from agent
      if (msg['type'] === 'e2e_ack' && this.e2eSession) {
        this.e2eSession.handleAck(msg as { pub: string; sig: string }).then((ok) => {
          if (!ok) console.warn('E2E handshake failed — sig verification error');
        });
        return; // don't forward handshake messages to UI handlers
      }

      // Transparent E2E decryption: if the message has an `e2e` field, decrypt
      // it back into `data` before handing to handlers. This makes terminal.ts
      // / sessions.ts completely unaware of encryption.
      if (msg['e2e'] && this.e2eSession?.isReady) {
        this.e2eSession.decrypt(msg['e2e'] as E2ePayload).then((plaintext) => {
          msg['data'] = plaintext;
          delete msg['e2e'];
          for (const h of this.handlers) h(msg);
        }).catch(() => {
          // Decryption failed — drop the message (tampered or wrong key).
          console.warn('E2E decryption failed, dropping message');
        });
        return;
      }

      for (const h of this.handlers) h(msg);
    };

    ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      this.e2eSession = null; // E2E state dies with the connection
      if (ev.code === 4001) {
        this.onStatusChange(false, false);
        this.onAuthFail();
        return;
      }
      this.onStatusChange(false, true);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.doConnect();
      }, this.reconnectDelay);
    };

    ws.onerror = () => { /* handled by onclose */ };
  }

  /**
   * Send a message. If E2E is ready and the message type is 'input' (terminal
   * data), transparently encrypt the `data` field into an `e2e` payload. All
   * other message types (attach, detach, resize, list_sessions, etc.) are sent
   * in plaintext — the relay needs their metadata for routing/cleanup.
   */
  send(msg: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const obj = msg as Record<string, unknown>;
    if (obj['type'] === 'input' && typeof obj['data'] === 'string' && this.e2eSession?.isReady) {
      // Encrypt asynchronously, then send
      this.e2eSession.encrypt(obj['data'] as string).then((e2e) => {
        const encrypted = { type: obj['type'], session_id: obj['session_id'], e2e };
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(encrypted));
        }
      });
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.e2eSession = null;
    this.onStatusChange(false, false);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── E2E handshake initiation ──────────────────────────────────────────────
  private async initiateE2eHandshake(): Promise<void> {
    if (!this.e2eSecret) return;
    this.e2eSession = new E2eSession(this.e2eSecret);
    const hello = await this.e2eSession.createHello();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(hello));
    }
  }
}

export const wsManager = new WSManager();
