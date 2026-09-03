// WebSocket manager with auto-reconnect and session_token persistence.

export type MessageHandler = (msg: Record<string, unknown>) => void;

export class WSManager {
  private ws: WebSocket | null = null;
  private url: string = '';
  private token: string = '';
  private handlers = new Set<MessageHandler>();
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatusChange: (connected: boolean, reconnecting: boolean) => void = () => {};
  // Fired once when the relay rejects auth (close 4001) — i.e. the session
  // token is expired/invalid/revoked. Distinct from onStatusChange because the
  // caller needs to stop the reconnect loop and prompt a re-scan rather than
  // silently retry a dead token forever. Single callback, replaced via
  // setAuthFailCallback (mirrors setStatusCallback's shape).
  private onAuthFail: () => void = () => {};

  setStatusCallback(cb: (connected: boolean, reconnecting: boolean) => void): void {
    this.onStatusChange = cb;
  }

  setAuthFailCallback(cb: () => void): void {
    this.onAuthFail = cb;
  }

  on(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  connect(relayUrl: string, token: string): void {
    // Clear any pending reconnect from a PREVIOUS socket before we touch
    // url/token. Without this, a stale timer from the old connection's onclose
    // fires doConnect(), which closes this brand-new socket and reconnects to
    // the OLD url — so switching hosts via connect() alone would bounce back.
    // disconnect() already clears it; doing it here makes every connect() safe
    // (the QR/sessions/default routes also call connect() while a prior socket
    // may have a pending reconnect).
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.url = relayUrl.replace(/^http/, 'ws') + '/ws/client';
    this.token = token;
    this.reconnectDelay = 1000;
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
      // Send token as first message for auth. Do NOT signal "connected" yet —
      // the socket is open but the relay has not verified the token. We flip
      // to connected only on receiving {type:'authed'} (see onmessage), so
      // that any request fired on connect (e.g. list_sessions) lands after
      // auth completes instead of being rejected/closing the socket.
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

      // Relay confirms auth is complete — now the connection is truly usable.
      if (msg['type'] === 'authed') {
        this.onStatusChange(true, false);
        return;
      }

      for (const h of this.handlers) h(msg);
    };

    ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      // 4001 = the relay rejected our auth (token expired / invalid / revoked).
      // The token is dead — retrying on backoff just hammers a dead credential
      // forever. Stop the reconnect loop and surface a one-shot onAuthFail so
      // the UI can prompt a re-scan instead of spinning. (The relay also sends
      // a {type:'error',code:'AUTH_FAILED'} just before close; that lands in
      // onmessage but we treat close-code as the authoritative signal since
      // it's guaranteed.) 4002 (agent offline) and anything else → keep the
      // normal reconnect loop: the token is fine, the host is just down.
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

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.onStatusChange(false, false);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const wsManager = new WSManager();
