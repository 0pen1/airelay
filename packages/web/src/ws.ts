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

  setStatusCallback(cb: (connected: boolean, reconnecting: boolean) => void): void {
    this.onStatusChange = cb;
  }

  on(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  connect(relayUrl: string, token: string): void {
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
      // Send token as first message for auth
      ws.send(JSON.stringify({ type: 'auth', token: this.token }));
      this.reconnectDelay = 1000;
      this.onStatusChange(true, false);
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

      for (const h of this.handlers) h(msg);
    };

    ws.onclose = () => {
      this.ws = null;
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
