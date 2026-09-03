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

/**
 * Map of byte sequences → tmux named keys. `send-keys <Name>` honours the
 * application cursor-key / keypad modes a TUI enables, so it emits the byte
 * sequence the app actually expects (e.g. `ESC O A` vs `ESC [ A`). The keys
 * here are the sequences xterm.js emits for the corresponding physical keys
 * and for the on-screen toolbar buttons (see terminal.ts `data-send`).
 */
const KEY_NAMES: ReadonlyMap<string, string> = new Map<string, string>([
  ['\x1b[A', 'Up'],
  ['\x1b[B', 'Down'],
  ['\x1b[C', 'Right'],
  ['\x1b[D', 'Left'],
  ['\x1bOA', 'Up'],     // application cursor keys variant
  ['\x1bOB', 'Down'],
  ['\x1bOC', 'Right'],
  ['\x1bOD', 'Left'],
  ['\x1b[H', 'Home'],
  ['\x1b[F', 'End'],
  ['\x1bOH', 'Home'],
  ['\x1bOF', 'End'],
  ['\x1b[1~', 'Home'],
  ['\x1b[4~', 'End'],
  ['\x1b[5~', 'PageUp'],
  ['\x1b[6~', 'PageDown'],
  ['\x1b[2~', 'Insert'],
  ['\x1b[3~', 'Delete'],
  ['\x1b[1;2A', 'Up'],     // Shift+Up etc. — collapse to base key
  ['\x1b[1;2B', 'Down'],
  ['\x1b[1;2C', 'Right'],
  ['\x1b[1;2D', 'Left'],
  ['\r', 'Enter'],
  ['\n', 'Enter'],
  ['\t', 'Tab'],
  ['\x7f', 'BSpace'],
  ['\x08', 'BSpace'],
  ['\x1b', 'Escape'],
  ['\x1b\x1b', 'Escape'],
  ['\x03', 'C-c'],   // Ctrl-C
  ['\x04', 'C-d'],   // Ctrl-D
  // Ctrl-A..Ctrl-Z (minus the ones above) — mapped where tmux supports them.
  ['\x01', 'C-a'], ['\x02', 'C-b'], ['\x05', 'C-e'], ['\x06', 'C-f'],
  ['\x07', 'C-g'], ['\x0b', 'C-k'], ['\x0c', 'C-l'], ['\x0e', 'C-n'],
  ['\x0f', 'C-o'], ['\x10', 'C-p'], ['\x11', 'C-q'], ['\x12', 'C-r'],
  ['\x13', 'C-s'], ['\x14', 'C-t'], ['\x15', 'C-u'], ['\x16', 'C-v'],
  ['\x17', 'C-w'], ['\x18', 'C-x'], ['\x19', 'C-y'], ['\x1a', 'C-z'],
]);

/**
 * Split an input string into individual key-stroke segments. Each segment is
 * either one of the multi-byte escape sequences in KEY_NAMES, or a run of
 * literal text. This lets sendInput route each key to the right delivery
 * method (named key vs raw hex) while keeping pasted text in one piece.
 */
function splitKeys(data: string): string[] {
  const parts: string[] = [];

  // Build a matcher for the known escape sequences, longest first so that
  // e.g. `\x1b[1;2A` is preferred over `\x1b[1`-ish prefixes.
  const seqs = [...KEY_NAMES.keys()].sort((a, b) => b.length - a.length);

  let i = 0;
  let text = '';
  const flushText = () => {
    if (text) {
      parts.push(text);
      text = '';
    }
  };

  while (i < data.length) {
    let matched: string | null = null;
    for (const seq of seqs) {
      if (data.startsWith(seq, i)) {
        matched = seq;
        break;
      }
    }
    if (matched) {
      flushText();
      parts.push(matched);
      i += matched.length;
    } else {
      // Accumulate one char of literal text. Note: data is a JS string, so
      // multi-byte UTF-8 is already one code-unit per BMP char; surrogate
      // pairs are handled correctly because we only advance by 1 and the
      // low surrogate won't match any escape sequence on its own.
      text += data[i];
      i += 1;
    }
  }
  flushText();
  return parts;
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

    // Split the input into key-stroke segments. For each segment we pick the
    // delivery method that the underlying TUI will actually recognise:
    //
    //  • Known control sequences (arrows, Home/End, F-keys, common Ctrl- combos,
    //    Enter, Tab, Esc, Backspace) → `tmux send-keys <Name>`. tmux's named-key
    //    path honours the application cursor-key / keypad modes a full-screen TUI
    //    (Claude Code, codex, vim, …) enables, so it emits the *correct* byte
    //    sequence the app expects — e.g. `ESC O A` instead of `ESC [ A` when
    //    app-cursor-keys mode is on. Sending raw `ESC [ A` via hex in that state
    //    is silently ignored, which is why arrow-key selection in Claude Code's
    //    menus didn't work.
    //
    //  • Any other bytes (real text the user typed, paste, multibyte UTF-8) →
    //    `tmux send-keys -l <text>`. The `-l` flag sends the argument as literal
    //    characters that the pane's foreground app reads as typed input — this is
    //    what makes text appear in Claude Code's prompt box, vim's insert mode,
    //    a shell, etc.
    //
    //    (Earlier this used `send-keys -H <hex>`, but `-H` injects raw key-codes
    //    that tmux interprets as key *events*, not printable characters —
    //    printable text sent that way never reached the app's input line, so
    //    typed commands and Enter-to-confirm silently vanished. `-H` is only
    //    appropriate for control sequences, which we already route through named
    //    keys above.)
    //
    //    We shell-quote the literal argument (single quotes, with embedded
    //    single quotes escaped) so shell metacharacters and spaces in the text
    //    don't break the command.
    const parts = splitKeys(data);
    for (const part of parts) {
      const name = KEY_NAMES.get(part);
      if (name) {
        await exec(`tmux send-keys -t ${id} ${name}`);
      } else {
        const quoted = `'${part.replace(/'/g, `'\\''`)}'`;
        await exec(`tmux send-keys -t ${id} -l ${quoted}`);
      }
    }
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const id = this.tmuxId(sessionId);
    await exec(`tmux resize-window -t ${id} -x ${cols} -y ${rows}`).catch(() => {});
  }

  async getScrollback(sessionId: string): Promise<string> {
    const id = this.tmuxId(sessionId);
    // -e preserves ANSI escape sequences (colors, cursor moves, screen clears).
    // Without it, full-screen TUI apps (Claude Code, codex, vim, …) capture as
    // bare text and xterm.js cannot reconstruct the screen on attach — the
    // terminal renders blank/garbled until the next repaint.
    const { stdout } = await exec(`tmux capture-pane -p -e -S -5000 -t ${id}`);
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
