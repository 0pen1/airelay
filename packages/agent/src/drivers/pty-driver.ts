import { spawn, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentDriver, Disposable } from './types.js';

const exec = promisify(execCb);

/**
 * tmux control mode escapes non-printable bytes in %output data as octal \ooo.
 * Decode them back to their original characters.
 */
function unescapeTmux(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

interface Callbacks {
  output: Set<(data: string) => void>;
  exit: Set<(code: number) => void>;
}

export class PtyDriver implements AgentDriver {
  readonly agentId: string;
  private command: string;
  private args: string[];
  private callbacks = new Map<string, Callbacks>();
  private controlProcs = new Map<string, ReturnType<typeof spawn>>();

  constructor(config: { agentId: string; command: string; args: string[] }) {
    this.agentId = config.agentId;
    this.command = config.command;
    this.args = config.args;
  }

  private tmuxId(sessionId: string): string {
    return `airelay-${sessionId}`;
  }

  private getCallbacks(sessionId: string): Callbacks {
    if (!this.callbacks.has(sessionId)) {
      this.callbacks.set(sessionId, { output: new Set(), exit: new Set() });
    }
    return this.callbacks.get(sessionId)!;
  }

  async start(sessionId: string): Promise<void> {
    const id = this.tmuxId(sessionId);
    const cmd = [this.command, ...this.args].join(' ');
    await exec(`tmux new-session -d -s ${id} "${cmd}"`);
    this.attachControlMode(sessionId, id);
  }

  private attachControlMode(sessionId: string, tmuxId: string): void {
    // stdin MUST be a live pipe: with 'ignore' (=/dev/null) tmux sees an
    // immediate EOF on the control client and emits %exit right away.
    const proc = spawn('tmux', ['-C', 'attach-session', '-t', tmuxId], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this.controlProcs.set(sessionId, proc);

    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('%output ')) {
          // Format: %output %<pane-id> <octal-escaped data>
          const afterPane = line.indexOf(' ', 8);
          const raw = afterPane >= 0 ? line.slice(afterPane + 1) : '';
          const data = unescapeTmux(raw);
          for (const cb of this.getCallbacks(sessionId).output) cb(data);
        } else if (line.startsWith('%session-closed') || line.startsWith('%exit')) {
          for (const cb of this.getCallbacks(sessionId).exit) cb(0);
          this.cleanup(sessionId);
        }
      }
    });

    proc.on('exit', () => {
      for (const cb of this.getCallbacks(sessionId).exit) cb(0);
      this.cleanup(sessionId);
    });
  }

  private cleanup(sessionId: string): void {
    this.controlProcs.get(sessionId)?.kill();
    this.controlProcs.delete(sessionId);
    this.callbacks.delete(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    const id = this.tmuxId(sessionId);
    this.cleanup(sessionId);
    await exec(`tmux kill-session -t ${id}`).catch(() => {});
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    const id = this.tmuxId(sessionId);
    // Use load-buffer + paste-buffer for binary safety (avoids send-keys escaping issues)
    const b64 = Buffer.from(data).toString('base64');
    await exec(`printf '%s' '${b64}' | base64 -d | tmux load-buffer -`);
    await exec(`tmux paste-buffer -t ${id}`);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const id = this.tmuxId(sessionId);
    await exec(`tmux resize-window -t ${id} -x ${cols} -y ${rows}`).catch(() => {});
  }

  async getScrollback(sessionId: string): Promise<string> {
    const id = this.tmuxId(sessionId);
    const { stdout } = await exec(`tmux capture-pane -p -S -5000 -t ${id}`);
    return stdout;
  }

  onOutput(sessionId: string, cb: (data: string) => void): Disposable {
    this.getCallbacks(sessionId).output.add(cb);
    return { dispose: () => this.getCallbacks(sessionId).output.delete(cb) };
  }

  onExit(sessionId: string, cb: (code: number) => void): Disposable {
    this.getCallbacks(sessionId).exit.add(cb);
    return { dispose: () => this.getCallbacks(sessionId).exit.delete(cb) };
  }

  /** Re-attach control mode after agent restart (tmux session already exists). */
  reattach(sessionId: string): void {
    const id = this.tmuxId(sessionId);
    this.attachControlMode(sessionId, id);
  }
}
