import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { wsManager } from './ws.js';
import { VoiceInput } from './voice.js';

export function mountTerminal(app: HTMLElement, sessionId: string): () => void {
  app.innerHTML = `
    <div class="term-layout">
      <header class="term-header">
        <button class="term-back" id="term-back" aria-label="Back to sessions">
          <span aria-hidden="true">←</span>
        </button>
        <div class="term-title" id="term-title">
          <span id="term-agent-icon" aria-hidden="true">🤖</span>
          <span id="term-agent-name">Session</span>
        </div>
        <button class="term-disconnect" id="term-disconnect" aria-label="Disconnect session">
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <div class="term-container" id="term-container" role="main" aria-label="Terminal"></div>

      <div class="term-toolbar" role="toolbar" aria-label="Special keys">
        <button class="key-btn" data-send="\x03" aria-label="Control C">^C</button>
        <button class="key-btn" data-send="\x04" aria-label="Control D">^D</button>
        <button class="key-btn" data-send="\t"   aria-label="Tab">Tab</button>
        <button class="key-btn" data-send="\x1b" aria-label="Escape">Esc</button>
        <button class="key-btn" data-send="\x1b[A" aria-label="Up arrow">↑</button>
        <button class="key-btn" data-send="\x1b[B" aria-label="Down arrow">↓</button>
        <button class="key-btn" data-send="\x1b[C" aria-label="Right arrow">→</button>
        <button class="key-btn" data-send="\x1b[D" aria-label="Left arrow">←</button>
      </div>

      <div class="term-input-row">
        <textarea class="term-input" id="term-input" rows="1"
          placeholder="Type a command…" aria-label="Command input"
          autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
        <button class="voice-btn" id="voice-btn" aria-label="Voice input" aria-pressed="false">🎤</button>
        <button class="send-btn" id="send-btn" aria-label="Send">↵</button>
      </div>
    </div>

    <style>
      .term-layout {
        flex: 1; display: flex; flex-direction: column; overflow: hidden;
        background: #1a1a18;
      }
      .term-header {
        display: flex; align-items: center; gap: var(--space-2);
        padding: var(--space-2) var(--space-4);
        background: #111110; border-bottom: 1px solid #2a2a28;
        flex-shrink: 0;
      }
      .term-back, .term-disconnect {
        background: none; border: none; color: #888680; cursor: pointer;
        font-size: 1.1rem; width: 36px; height: 36px; border-radius: var(--radius-sm);
        display: flex; align-items: center; justify-content: center;
        transition: color 120ms, background 120ms;
      }
      .term-back:hover, .term-disconnect:hover { color: #f0ede8; background: #2a2a28; }
      .term-back:focus-visible, .term-disconnect:focus-visible {
        outline: 2px solid var(--color-accent); outline-offset: 2px;
      }
      .term-title {
        flex: 1; display: flex; align-items: center; gap: var(--space-2);
        font-size: 0.9rem; font-weight: 500; color: #c8c5bf;
        overflow: hidden; white-space: nowrap;
      }
      .term-container {
        flex: 1; overflow: hidden; padding: var(--space-2);
      }
      .term-container .xterm { height: 100%; }
      .term-toolbar {
        display: flex; gap: var(--space-1); padding: var(--space-2) var(--space-3);
        background: #111110; border-top: 1px solid #2a2a28;
        overflow-x: auto; flex-shrink: 0;
        scrollbar-width: none;
      }
      .term-toolbar::-webkit-scrollbar { display: none; }
      .key-btn {
        flex-shrink: 0; background: #1e1e1c; border: 1px solid #3a3a38;
        color: #c8c5bf; border-radius: var(--radius-sm);
        padding: 0 var(--space-3); height: 34px; cursor: pointer;
        font-size: 0.8125rem; font-family: 'Menlo', monospace;
        transition: background 120ms, border-color 120ms;
        min-width: 44px;
      }
      .key-btn:hover { background: #2a2a28; border-color: #5a5a58; }
      .key-btn:active { background: #333330; }
      .key-btn:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
      .term-input-row {
        display: flex; gap: var(--space-2); padding: var(--space-2) var(--space-3);
        background: #111110; border-top: 1px solid #2a2a28;
        padding-bottom: calc(var(--space-2) + env(safe-area-inset-bottom));
        flex-shrink: 0;
      }
      .term-input {
        flex: 1; background: #1e1e1c; border: 1px solid #3a3a38;
        color: #f0ede8; border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3);
        font-size: 0.9rem; font-family: 'Menlo', 'Monaco', monospace;
        resize: none; line-height: 1.4; max-height: 120px; overflow-y: auto;
        outline: none; transition: border-color 120ms;
      }
      .term-input:focus-visible { border-color: var(--color-accent); }
      .voice-btn, .send-btn {
        flex-shrink: 0; width: 40px; height: 40px; border-radius: var(--radius-sm);
        border: 1px solid #3a3a38; background: #1e1e1c; color: #c8c5bf;
        cursor: pointer; font-size: 1.1rem;
        display: flex; align-items: center; justify-content: center;
        transition: background 120ms, border-color 120ms;
      }
      .voice-btn:hover, .send-btn:hover { background: #2a2a28; }
      .send-btn { background: var(--color-accent); border-color: transparent; color: #fff; }
      .send-btn:hover { background: var(--color-accent-hover); }
      .voice-btn[aria-pressed="true"] {
        background: oklch(40% 0.15 25); border-color: var(--color-danger); color: #fff;
        animation: pulse-rec 1s ease-in-out infinite;
      }
      @keyframes pulse-rec { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
      .voice-btn:focus-visible, .send-btn:focus-visible {
        outline: 2px solid var(--color-accent); outline-offset: 2px;
      }
    </style>
  `;

  const termContainer = app.querySelector('#term-container') as HTMLElement;
  const termInput = app.querySelector('#term-input') as HTMLTextAreaElement;
  const sendBtn = app.querySelector('#send-btn') as HTMLButtonElement;
  const voiceBtn = app.querySelector('#voice-btn') as HTMLButtonElement;
  const backBtn = app.querySelector('#term-back') as HTMLButtonElement;
  const disconnectBtn = app.querySelector('#term-disconnect') as HTMLButtonElement;
  const agentIcon = app.querySelector('#term-agent-icon') as HTMLElement;
  const agentName = app.querySelector('#term-agent-name') as HTMLElement;

  // ── xterm.js setup ────────────────────────────────────────────────────────
  const term = new Terminal({
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: '#1a1a18',
      foreground: '#f0ede8',
      cursor: '#f0ede8',
      selectionBackground: 'rgba(240,237,232,0.2)',
    },
    scrollback: 10000,
    convertEol: true,
  });

  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.open(termContainer);

  function fitAndSync(): void {
    fitAddon.fit();
    wsManager.send({
      type: 'resize',
      session_id: sessionId,
      cols: term.cols,
      rows: term.rows,
    });
  }

  setTimeout(fitAndSync, 50);

  const ro = new ResizeObserver(() => fitAndSync());
  ro.observe(termContainer);
  window.addEventListener('orientationchange', fitAndSync);

  // ── scrollback buffer ─────────────────────────────────────────────────────
  const scrollbackChunks = new Map<number, string>();

  // ── voice input ───────────────────────────────────────────────────────────
  const voice = new VoiceInput();
  let recording = false;

  if (!voice.isSupported()) {
    voiceBtn.disabled = true;
    voiceBtn.title = 'Voice input is not supported in this browser';
  }

  voiceBtn.addEventListener('pointerdown', () => {
    if (!voice.isSupported()) return;
    recording = true;
    voiceBtn.setAttribute('aria-pressed', 'true');
    voice.start(
      (interim) => { termInput.value = interim; },
      (final) => { termInput.value = final; recording = false; voiceBtn.setAttribute('aria-pressed', 'false'); },
    );
  });

  window.addEventListener('pointerup', () => {
    if (recording) {
      voice.stop();
      recording = false;
      voiceBtn.setAttribute('aria-pressed', 'false');
    }
  });

  // ── send input ────────────────────────────────────────────────────────────
  function sendInput(): void {
    const data = termInput.value;
    if (!data) return;
    wsManager.send({ type: 'input', session_id: sessionId, data: data + '\n' });
    termInput.value = '';
    termInput.style.height = 'auto';
  }

  sendBtn.addEventListener('click', sendInput);
  termInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput();
    }
  });
  termInput.addEventListener('input', () => {
    termInput.style.height = 'auto';
    termInput.style.height = Math.min(termInput.scrollHeight, 120) + 'px';
  });

  // ── special keys toolbar ──────────────────────────────────────────────────
  app.querySelectorAll<HTMLButtonElement>('.key-btn').forEach((btn) => {
    const data = btn.dataset['send'];
    if (data) {
      btn.addEventListener('click', () => {
        wsManager.send({ type: 'input', session_id: sessionId, data });
      });
    }
  });

  // ── navigation ────────────────────────────────────────────────────────────
  backBtn.addEventListener('click', () => {
    wsManager.send({ type: 'detach', session_id: sessionId });
    location.hash = '#/sessions';
  });

  disconnectBtn.addEventListener('click', () => {
    wsManager.send({ type: 'detach', session_id: sessionId });
    location.hash = '#/sessions';
  });

  // ── message handler ───────────────────────────────────────────────────────
  const off = wsManager.on((msg) => {
    if (msg['type'] === 'output' && msg['session_id'] === sessionId) {
      term.write(msg['data'] as string);
    } else if (msg['type'] === 'scrollback' && msg['session_id'] === sessionId) {
      const seq = msg['seq'] as number;
      scrollbackChunks.set(seq, msg['data'] as string);
      if (msg['done'] as boolean) {
        // Write all chunks in order
        const keys = Array.from(scrollbackChunks.keys()).sort((a, b) => a - b);
        for (const k of keys) term.write(scrollbackChunks.get(k)!);
        scrollbackChunks.clear();
      }
    } else if (msg['type'] === 'sessions_list') {
      // Update agent name from session list
      const sessions = msg['sessions'] as Array<{session_id: string; agent_name: string; icon: string}>;
      const s = sessions.find((x) => x.session_id === sessionId);
      if (s) {
        agentIcon.textContent = s.icon;
        agentName.textContent = s.agent_name;
      }
    } else if (msg['type'] === 'session_exited' && msg['session_id'] === sessionId) {
      term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    }
  });

  // Request session list to get agent name
  wsManager.send({ type: 'list_sessions' });

  // ── cleanup ───────────────────────────────────────────────────────────────
  return () => {
    off();
    ro.disconnect();
    window.removeEventListener('orientationchange', fitAndSync);
    term.dispose();
  };
}
