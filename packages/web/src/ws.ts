// WebSocket manager with auto-reconnect, session_token persistence,
// and optional E2E encryption (ECDH + AES-256-GCM).
//
// Terminal I/O hot path uses binary frames [opcode][slot][payload] (see
// shared/protocol.ts). The agent assigns a slot per session in its `attached`
// message; JSON is the fallback for everything else (attach, resize, status…)
// and whenever no slot is known.

import { BinaryOpcode, decodeBinaryFrame, encodeBinaryFrame } from '@airelay/shared';
import { E2eSession, type E2ePayload } from './e2e.js';
import { setupPushSubscription } from './notify.js';
import { showToast } from './toast.js';

export type MessageHandler = (msg: Record<string, unknown>) => void;

/** Short human-readable device name from the user agent, e.g. "iPhone Safari". */
function deriveDeviceName(): string {
  const ua = navigator.userAgent;
  const os =
    /iPhone/.test(ua) ? 'iPhone' :
    /iPad/.test(ua) ? 'iPad' :
    /Android/.test(ua) ? 'Android' :
    /Macintosh/.test(ua) ? 'Mac' :
    /Windows/.test(ua) ? 'Windows' :
    /Linux/.test(ua) ? 'Linux' : 'Web';
  const browser =
    /FxiOS|Firefox/.test(ua) ? 'Firefox' :
    /EdgiOS|Edg\//.test(ua) ? 'Edge' :
    /CriOS|Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} ${browser}`;
}

export class WSManager {
  private ws: WebSocket | null = null;
  private url: string = '';
  private token: string = '';
  private handlers = new Set<MessageHandler>();
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatusChange: (connected: boolean, reconnecting: boolean) => void = () => {};
  private onAuthFail: () => void = () => {};
  /** Human-readable name for this device, sent with the first auth so the
   *  host's device list can identify it. Derived from the user agent once. */
  private deviceName: string = deriveDeviceName();

  // ── E2E state ───────────────────────────────────────────────────────────
  private e2eSecret: string | null = null; // hex, from HostEntry; null = no E2E
  private e2eSession: E2eSession | null = null;

  // ── Binary frame state ──────────────────────────────────────────────────
  // slot → session_id, learned from `attached` messages. Empty = JSON-only.
  private slots = new Map<number, string>();

  // ── Latency probe state ─────────────────────────────────────────────────
  private latencyTimer: ReturnType<typeof setInterval> | null = null;
  private latencySentAt = 0;
  private lastRttMs = 0;

  // ── E2E downgrade watchdog ──────────────────────────────────────────────
  private e2eWatchdog: ReturnType<typeof setTimeout> | null = null;

  /** Last measured round-trip time to the agent (via latency probes), or 0. */
  get latencyMs(): number { return this.lastRttMs; }

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
    // Terminal I/O arrives as binary frames; JSON control messages as text.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      // device_name rides along on every auth: the relay uses it when minting
      // a token from a JWT (first connect) and ignores it on reconnects.
      ws.send(JSON.stringify({ type: 'auth', token: this.token, device_name: this.deviceName }));
      this.reconnectDelay = 1000;
    };

    ws.onmessage = (ev) => {
      // ── Binary frame path ────────────────────────────────────────────────
      if (ev.data instanceof ArrayBuffer) {
        this.handleBinary(new Uint8Array(ev.data));
        return;
      }

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
          // Downgrade watchdog: if the handshake doesn't complete within the
          // window, something between us and the agent (i.e. the relay) is
          // suppressing it. Warn loudly instead of silently typing in the
          // clear.
          if (this.e2eWatchdog) clearTimeout(this.e2eWatchdog);
          this.e2eWatchdog = setTimeout(() => {
            if (this.ws && !this.e2eSession?.isReady) {
              showToast('⚠️ 加密握手未完成 — 当前会话可能被降级为明文，请断开并检查中继');
            }
          }, 12_000);
        }
        // Register/refresh the Web Push subscription once per session (needs
        // the session token that auth just validated). Fire-and-forget.
        if (!sessionStorage.getItem('airelay_push_done')) {
          sessionStorage.setItem('airelay_push_done', '1');
          void setupPushSubscription();
        }
        return;
      }

      // Learn the binary-frame slot the agent assigned to this session.
      // Re-attach to the same session keeps its slot; a fresh attach gets a
      // new one (the agent frees old slots on detach).
      if (msg['type'] === 'attached') {
        const slot = msg['slot'];
        if (typeof slot === 'number' && typeof msg['session_id'] === 'string') {
          this.slots.set(slot, msg['session_id'] as string);
        }
      }

      // Latency probe echo from the agent.
      if (msg['type'] === 'latency_pong' && this.latencySentAt) {
        this.lastRttMs = Date.now() - this.latencySentAt;
        this.latencySentAt = 0;
        return;
      }

      // E2E handshake response from agent
      if (msg['type'] === 'e2e_ack' && this.e2eSession) {
        this.e2eSession.handleAck(msg as { pub: string; sig: string }).then((ok) => {
          if (!ok) console.warn('E2E handshake failed — sig verification error');
        });
        return; // don't forward handshake messages to UI handlers
      }

      // Protocol errors (session occupied, agent unavailable, …) surface as
      // toasts. AUTH_FAILED is handled by the close-code path (re-scan UI),
      // so it's skipped here to avoid double reporting.
      if (msg['type'] === 'error' && msg['code'] !== 'AUTH_FAILED') {
        showToast(String(msg['message'] ?? 'Something went wrong'));
        // fall through: handlers may still want the error message
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
      if (this.e2eWatchdog) { clearTimeout(this.e2eWatchdog); this.e2eWatchdog = null; }
      this.slots.clear();     // slot assignments die with the connection
      if (this.latencyTimer) { clearInterval(this.latencyTimer); this.latencyTimer = null; }
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

    // Latency probe: browsers can't read WS ping/pong frames, so use a JSON
    // round-trip. The agent echoes latency_probe back (see daemon.ts); RTT
    // covers relay + agent, which is the latency the user actually feels.
    this.latencyTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.latencySentAt = Date.now();
      this.ws.send(JSON.stringify({ type: 'latency_probe', t: this.latencySentAt }));
    }, 15_000);
  }

  /**
   * Send a message. If E2E is ready and the message type is 'input' (terminal
   * data), transparently encrypt the `data` field into an `e2e` payload. All
   * other message types (attach, detach, resize, list_sessions, etc.) are sent
   * in plaintext — the relay needs their metadata for routing/cleanup.
   *
   * Input for a session with a known binary slot goes out as a binary frame
   * ([0x02][slot][iv||ct or raw]) instead of JSON.
   */
  send(msg: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const obj = msg as Record<string, unknown>;
    if (obj['type'] === 'input' && typeof obj['data'] === 'string') {
      const slot = this.slotFor(obj['session_id'] as string | undefined);
      if (slot !== null) {
        this.sendBinaryInput(slot, obj['data'] as string);
        return;
      }
      if (this.e2eSession?.isReady) {
        // JSON path with E2E: sequence number bound via GCM AAD so the relay
        // cannot replay a captured input later.
        this.e2eSession.encryptInput(obj['data'] as string).then((e2e) => {
          const encrypted = { type: obj['type'], session_id: obj['session_id'], e2e };
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(encrypted));
          }
        });
        return;
      }
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** Find the binary slot for a session, or null if unknown. */
  private slotFor(sessionId: string | undefined): number | null {
    if (!sessionId) return null;
    for (const [slot, sid] of this.slots) {
      if (sid === sessionId) return slot;
    }
    return null;
  }

  /** Encode + send an input binary frame (E2E-encrypts payload if active). */
  private sendBinaryInput(slot: number, data: string): void {
    const plaintext = new TextEncoder().encode(data);
    const sendFrame = (payload: Uint8Array): void => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(encodeBinaryFrame(BinaryOpcode.INPUT, slot, payload));
    };
    if (this.e2eSession?.isReady) {
      this.e2eSession.encryptInputBytes(plaintext).then(sendFrame).catch(() => {
        console.warn('E2E encryption failed, dropping input');
      });
    } else {
      sendFrame(plaintext);
    }
  }

  /** Decode an inbound binary frame and dispatch it as a normal output message. */
  private handleBinary(frame: Uint8Array): void {
    const decoded = decodeBinaryFrame(frame);
    if (!decoded || decoded.opcode !== BinaryOpcode.OUTPUT) return;
    const sessionId = this.slots.get(decoded.slot);
    if (!sessionId) return; // unknown slot — drop

    const dispatch = (plaintext: Uint8Array): void => {
      const msg = { type: 'output', session_id: sessionId, data: new TextDecoder().decode(plaintext) };
      for (const h of this.handlers) h(msg);
    };
    if (this.e2eSession?.isReady) {
      this.e2eSession.decryptBytes(decoded.payload).then(dispatch).catch(() => {
        // Tampered or wrong key — drop silently.
        console.warn('E2E binary decryption failed, dropping frame');
      });
    } else {
      dispatch(decoded.payload);
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.e2eSession = null;
    this.slots.clear();
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
