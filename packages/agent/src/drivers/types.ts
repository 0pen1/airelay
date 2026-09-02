export interface Disposable {
  dispose(): void;
}

export interface AgentDriver {
  readonly agentId: string;
  start(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  sendInput(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  getScrollback(sessionId: string): Promise<string>;
  onOutput(sessionId: string, cb: (data: string) => void): Disposable;
  onExit(sessionId: string, cb: (code: number) => void): Disposable;
}
