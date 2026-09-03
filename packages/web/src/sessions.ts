import { wsManager } from './ws.js';

interface AgentTypeInfo {
  id: string;
  name: string;
  icon: string;
  available: boolean;
}

interface SessionInfo {
  session_id: string;
  agent_id: string;
  agent_name: string;
  icon: string;
  created_at: number;
  locked_by: string | null;
}

function relativeTime(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function mountSessions(app: HTMLElement): () => void {
  let sessions: SessionInfo[] = [];
  let agentTypes: AgentTypeInfo[] = [];
  let sheetOpen = false;

  app.innerHTML = `
    <div class="sessions-layout">
      <header class="sessions-header">
        <div class="header-title">
          <span class="header-icon" aria-hidden="true">⚡</span>
          <span>airelay</span>
        </div>
        <div id="conn-status" class="conn-status conn-status--connected" aria-live="polite">
          <span class="conn-dot" aria-hidden="true"></span>Connected
        </div>
      </header>

      <main class="sessions-main" role="main">
        <div id="sessions-list" class="sessions-list" aria-label="Active sessions">
          <div class="session-skeleton" aria-hidden="true"></div>
          <div class="session-skeleton" aria-hidden="true"></div>
        </div>
        <p id="sessions-empty" class="sessions-empty" hidden>
          No active sessions. Tap + to start one.
        </p>
      </main>

      <button class="fab" id="fab-btn" aria-label="New session">
        <span aria-hidden="true">+</span>
      </button>

      <div class="sheet-backdrop" id="sheet-backdrop" hidden aria-hidden="true"></div>
      <div class="sheet" id="agent-sheet" role="dialog" aria-modal="true"
           aria-label="Choose agent" hidden>
        <div class="sheet-handle" aria-hidden="true"></div>
        <h2 class="sheet-title">Start a new session</h2>
        <div id="agent-grid" class="agent-grid" role="list"></div>
      </div>
    </div>

    <style>
      .sessions-layout {
        flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative;
      }
      .sessions-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: var(--space-4) var(--space-6);
        background: var(--color-surface);
        border-bottom: 1px solid var(--color-border);
        position: sticky; top: 0; z-index: 10;
      }
      .header-title {
        font-weight: 600; font-size: 1.0625rem; letter-spacing: -0.01em;
        display: flex; align-items: center; gap: var(--space-2);
      }
      .header-icon { font-size: 1.1em; }
      .conn-status {
        display: flex; align-items: center; gap: var(--space-1);
        font-size: 0.8125rem; color: var(--color-text-muted);
      }
      .conn-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: oklch(55% 0.15 145);
        transition: background 200ms;
      }
      .conn-status--disconnected .conn-dot { background: var(--color-danger); }
      .conn-status--reconnecting .conn-dot {
        background: oklch(65% 0.18 80);
        animation: pulse 1s ease-in-out infinite;
      }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

      .sessions-main { flex: 1; overflow-y: auto; padding: var(--space-4) var(--space-4); }
      .sessions-list { display: flex; flex-direction: column; gap: var(--space-3); }
      .session-skeleton {
        height: 72px; background: var(--color-border);
        border-radius: var(--radius-md); animation: shimmer 1.4s linear infinite;
        background: linear-gradient(90deg,
          var(--color-border) 25%, oklch(from var(--color-border) calc(l + 0.04) c h) 50%,
          var(--color-border) 75%);
        background-size: 200% 100%;
      }
      @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

      .session-card {
        background: var(--color-surface); border: 1px solid var(--color-border);
        border-radius: var(--radius-md); padding: var(--space-4);
        display: flex; align-items: center; gap: var(--space-3);
        cursor: pointer; transition: border-color 120ms, box-shadow 120ms;
        min-height: 72px;
      }
      .session-card:hover { border-color: var(--color-accent); box-shadow: 0 0 0 2px oklch(from var(--color-accent) l c h / 0.12); }
      .session-card:active { opacity: 0.8; }
      .session-card:focus-visible {
        outline: 3px solid oklch(from var(--color-accent) l c h / 0.5); outline-offset: 2px;
      }
      .session-card[aria-disabled="true"] {
        opacity: 0.45; cursor: not-allowed; pointer-events: none;
      }
      .session-icon { font-size: 1.75rem; line-height: 1; flex-shrink: 0; }
      .session-info { flex: 1; min-width: 0; }
      .session-name {
        font-weight: 500; font-size: 0.9375rem;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .session-meta { font-size: 0.8125rem; color: var(--color-text-muted); margin-top: 2px; }
      .session-lock {
        font-size: 0.75rem; color: var(--color-text-muted);
        background: var(--color-bg); border: 1px solid var(--color-border);
        padding: 2px var(--space-2); border-radius: 999px; white-space: nowrap;
      }
      .sessions-empty {
        text-align: center; color: var(--color-text-muted); padding: var(--space-8);
      }
      .fab {
        position: absolute; bottom: var(--space-6); right: var(--space-6);
        width: 56px; height: 56px; border-radius: 50%;
        background: var(--color-accent); color: #fff; border: none;
        font-size: 1.75rem; line-height: 1; cursor: pointer;
        box-shadow: 0 2px 8px oklch(from var(--color-accent) l c h / 0.4);
        transition: background 120ms, transform 120ms;
        display: flex; align-items: center; justify-content: center;
      }
      .fab:hover { background: var(--color-accent-hover); transform: scale(1.05); }
      .fab:active { transform: scale(0.96); }
      .fab:focus-visible { outline: 3px solid oklch(from var(--color-accent) l c h / 0.5); outline-offset: 3px; }

      .sheet-backdrop {
        position: fixed; inset: 0; background: oklch(0% 0 0 / 0.4);
        z-index: 20; backdrop-filter: blur(2px);
      }
      .sheet {
        position: fixed; bottom: 0; left: 0; right: 0; z-index: 30;
        background: var(--color-surface); border-radius: var(--radius-lg) var(--radius-lg) 0 0;
        padding: var(--space-3) var(--space-6) calc(var(--space-6) + env(safe-area-inset-bottom));
        box-shadow: 0 -4px 24px oklch(0% 0 0 / 0.15);
        max-height: 70vh; overflow-y: auto;
      }
      .sheet-handle {
        width: 40px; height: 4px; background: var(--color-border);
        border-radius: 2px; margin: 0 auto var(--space-4);
      }
      .sheet-title { font-weight: 600; font-size: 1.0625rem; margin-bottom: var(--space-4); }
      .agent-grid { display: flex; flex-direction: column; gap: var(--space-2); }
      .agent-btn {
        display: flex; align-items: center; gap: var(--space-3); width: 100%;
        padding: var(--space-4); border: 1px solid var(--color-border);
        border-radius: var(--radius-md); background: var(--color-bg);
        cursor: pointer; transition: border-color 120ms; text-align: left; min-height: 56px;
      }
      .agent-btn:hover { border-color: var(--color-accent); }
      .agent-btn:focus-visible {
        outline: 3px solid oklch(from var(--color-accent) l c h / 0.5); outline-offset: 2px;
      }
      .agent-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
      .agent-btn-icon { font-size: 1.5rem; }
      .agent-btn-name { font-weight: 500; font-size: 0.9375rem; color: var(--color-text); }
      .agent-btn-unavail { font-size: 0.8rem; color: var(--color-text-muted); margin-left: auto; }
    </style>
  `;

  const connStatus = app.querySelector('#conn-status') as HTMLElement;
  const sessionsList = app.querySelector('#sessions-list') as HTMLElement;
  const sessionsEmpty = app.querySelector('#sessions-empty') as HTMLElement;
  const fabBtn = app.querySelector('#fab-btn') as HTMLButtonElement;
  const sheetBackdrop = app.querySelector('#sheet-backdrop') as HTMLElement;
  const agentSheet = app.querySelector('#agent-sheet') as HTMLElement;
  const agentGrid = app.querySelector('#agent-grid') as HTMLElement;

  function updateStatus(connected: boolean, reconnecting: boolean): void {
    connStatus.className = 'conn-status ' + (
      connected ? 'conn-status--connected' :
      reconnecting ? 'conn-status--reconnecting' :
      'conn-status--disconnected'
    );
    connStatus.lastChild!.textContent = connected ? 'Connected' : reconnecting ? 'Reconnecting…' : 'Disconnected';
    // When the socket (re)connects, re-request the session list. Without this,
    // a refresh on #/sessions races the async reconnect: mountSessions fires
    // list_sessions before the socket is OPEN, ws.send() silently drops it,
    // and the list stays empty forever.
    if (connected) requestSessions();
  }

  function requestSessions(): void {
    wsManager.send({ type: 'list_sessions' });
  }

  wsManager.setStatusCallback(updateStatus);

  let receivedList = false;
  // Safety net: if we're connected but never received a sessions_list (e.g. the
  // WS authed but the relay/agent dropped the list_sessions request during a
  // brief reconnect glitch), re-request once after a short delay. Without this
  // the page can sit on the skeleton placeholders forever after a refresh.
  const retryTimer = setTimeout(() => {
    if (!receivedList) requestSessions();
  }, 1500);

  function renderSessions(): void {
    sessionsList.innerHTML = '';
    if (sessions.length === 0) {
      sessionsEmpty.hidden = false;
      return;
    }
    sessionsEmpty.hidden = true;
    for (const s of sessions) {
      const occupied = s.locked_by !== null;
      const card = document.createElement('div');
      card.className = 'session-card';
      card.setAttribute('role', 'listitem');
      card.setAttribute('tabindex', occupied ? '-1' : '0');
      if (occupied) card.setAttribute('aria-disabled', 'true');
      card.innerHTML = `
        <span class="session-icon" aria-hidden="true">${s.icon}</span>
        <div class="session-info">
          <div class="session-name">${s.agent_name}</div>
          <div class="session-meta">${relativeTime(s.created_at)}</div>
        </div>
        ${occupied ? '<span class="session-lock">In use</span>' : ''}
      `;
      if (!occupied) {
        card.addEventListener('click', () => {
          wsManager.send({ type: 'attach', session_id: s.session_id });
          location.hash = `#/terminal/${s.session_id}`;
        });
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') card.click();
        });
      }
      sessionsList.appendChild(card);
    }
  }

  function openSheet(): void {
    wsManager.send({ type: 'list_agent_types' });
    sheetOpen = true;
    sheetBackdrop.hidden = false;
    agentSheet.hidden = false;
    sheetBackdrop.removeAttribute('aria-hidden');
    agentSheet.removeAttribute('aria-hidden');
    fabBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSheet(): void {
    sheetOpen = false;
    sheetBackdrop.hidden = true;
    agentSheet.hidden = true;
    sheetBackdrop.setAttribute('aria-hidden', 'true');
    agentSheet.setAttribute('aria-hidden', 'true');
    fabBtn.setAttribute('aria-expanded', 'false');
  }

  function renderAgentTypes(): void {
    agentGrid.innerHTML = '';
    for (const a of agentTypes) {
      const btn = document.createElement('button');
      btn.className = 'agent-btn';
      btn.disabled = !a.available;
      btn.setAttribute('role', 'listitem');
      btn.innerHTML = `
        <span class="agent-btn-icon" aria-hidden="true">${a.icon}</span>
        <span class="agent-btn-name">${a.name}</span>
        ${!a.available ? '<span class="agent-btn-unavail">Not installed</span>' : ''}
      `;
      if (a.available) {
        btn.addEventListener('click', () => {
          wsManager.send({ type: 'new_session', agent_id: a.id });
          closeSheet();
        });
      }
      agentGrid.appendChild(btn);
    }
  }

  fabBtn.addEventListener('click', openSheet);
  sheetBackdrop.addEventListener('click', closeSheet);

  // Request data on mount (covers the already-connected case; the reconnect
  // case is handled by updateStatus above).
  requestSessions();

  const off = wsManager.on((msg) => {
    if (msg['type'] === 'sessions_list') {
      receivedList = true;
      sessions = msg['sessions'] as SessionInfo[];
      renderSessions();
    } else if (msg['type'] === 'agent_types') {
      agentTypes = msg['agents'] as AgentTypeInfo[];
      renderAgentTypes();
    } else if (msg['type'] === 'session_created') {
      const sid = msg['session_id'] as string;
      location.hash = `#/terminal/${sid}`;
    }
  });

  return () => {
    off();
    clearTimeout(retryTimer);
    // Drop our status callback so a later (re)connect doesn't fire
    // requestSessions against a stale DOM after we've unmounted.
    wsManager.setStatusCallback(() => {});
  };
}
