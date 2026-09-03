import { wsManager } from './ws.js';
import {
  listHosts, getActiveHostId, setActiveHostId, removeHost, updateNickname,
  getActiveHost, hostScopedHash, defaultNickname,
} from './hosts.js';

export function mountHosts(app: HTMLElement): () => void {
  const hosts = listHosts();
  let sheetOpen = false;

  app.innerHTML = `
    <div class="hosts-layout">
      <header class="hosts-header">
        <div class="header-title">
          <span class="header-icon" aria-hidden="true">⚡</span>
          <span>主机</span>
        </div>
        <div id="host-status" class="conn-status conn-status--disconnected" aria-live="polite">
          <span class="conn-dot" aria-hidden="true"></span><span class="conn-label">未连接</span>
        </div>
      </header>

      <main class="hosts-main" role="main">
        <div id="hosts-list" class="hosts-list" aria-label="已添加的主机"></div>
        <p id="hosts-empty" class="hosts-empty" hidden>
          还没有主机。点 + 添加（扫码或粘贴 token）。
        </p>
        <div id="auth-fail-banner" class="auth-fail-banner" hidden>
          <span>该主机的访问已过期，请重新扫码。</span>
        </div>
      </main>

      <button class="fab" id="fab-btn" aria-label="添加主机">
        <span aria-hidden="true">+</span>
      </button>

      <div class="sheet-backdrop" id="sheet-backdrop" hidden aria-hidden="true"></div>
      <div class="sheet" id="add-sheet" role="dialog" aria-modal="true"
           aria-label="添加主机" hidden>
        <div class="sheet-handle" aria-hidden="true"></div>
        <h2 class="sheet-title">添加主机</h2>
        <p class="sheet-hint">用手机相机扫该主机的二维码，或在下面粘贴 token/二维码内容。</p>
        <div class="add-form">
          <label class="field-label" for="add-relay-url">Relay URL（粘贴 token 时需要）</label>
          <input class="field-input" id="add-relay-url" type="url"
            placeholder="https://your-vps.example.com" autocomplete="off" />
          <label class="field-label" for="add-token">Token 或二维码内容</label>
          <input class="field-input" id="add-token" type="text"
            placeholder="粘贴 JWT / 二维码 payload" autocomplete="off" />
          <button class="btn-primary" id="add-submit" type="button">添加</button>
          <p id="add-error" class="add-error" hidden></p>
        </div>
      </div>
    </div>

    <style>
      .hosts-layout {
        flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative;
      }
      .hosts-header {
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

      .hosts-main { flex: 1; overflow-y: auto; padding: var(--space-4) var(--space-4); }
      .hosts-list { display: flex; flex-direction: column; gap: var(--space-3); }

      .host-card {
        background: var(--color-surface); border: 1px solid var(--color-border);
        border-radius: var(--radius-md); padding: var(--space-4);
        display: flex; align-items: center; gap: var(--space-3);
        cursor: pointer; transition: border-color 120ms, box-shadow 120ms;
        min-height: 72px;
      }
      .host-card:hover { border-color: var(--color-accent); box-shadow: 0 0 0 2px oklch(from var(--color-accent) l c h / 0.12); }
      .host-card:active { opacity: 0.8; }
      .host-card:focus-visible {
        outline: 3px solid oklch(from var(--color-accent) l c h / 0.5); outline-offset: 2px;
      }
      .host-card.is-active { border-color: var(--color-accent); }
      .host-icon { font-size: 1.75rem; line-height: 1; flex-shrink: 0; }
      .host-info { flex: 1; min-width: 0; }
      .host-name {
        font-weight: 500; font-size: 0.9375rem;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .host-meta {
        font-size: 0.8125rem; color: var(--color-text-muted); margin-top: 2px;
        display: flex; align-items: center; gap: var(--space-1);
      }
      .host-meta .conn-dot { width: 6px; height: 6px; }
      .host-meta .meta-dot--neutral { background: var(--color-text-muted); opacity: 0.5; }
      .host-menu {
        background: none; border: none; color: var(--color-text-muted);
        font-size: 1.2rem; cursor: pointer; width: 36px; height: 36px;
        border-radius: var(--radius-sm); flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
      }
      .host-menu:hover { background: var(--color-bg); color: var(--color-text); }
      .hosts-empty {
        text-align: center; color: var(--color-text-muted); padding: var(--space-8);
      }
      .auth-fail-banner {
        margin-top: var(--space-3); padding: var(--space-3) var(--space-4);
        background: oklch(95% 0.04 25); color: var(--color-danger);
        border: 1px solid oklch(85% 0.08 25); border-radius: var(--radius-sm);
        font-size: 0.875rem;
      }
      @media (prefers-color-scheme: dark) {
        .auth-fail-banner { background: oklch(20% 0.04 25); border-color: oklch(35% 0.08 25); }
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
        max-height: 80vh; overflow-y: auto;
      }
      .sheet-handle {
        width: 40px; height: 4px; background: var(--color-border);
        border-radius: 2px; margin: 0 auto var(--space-4);
      }
      .sheet-title { font-weight: 600; font-size: 1.0625rem; margin-bottom: var(--space-2); }
      .sheet-hint { font-size: 0.875rem; color: var(--color-text-muted); margin-bottom: var(--space-4); }
      .add-form { display: flex; flex-direction: column; gap: var(--space-2); }
      .field-label {
        display: block; font-size: 0.875rem; font-weight: 500;
        margin-bottom: var(--space-1); margin-top: var(--space-3);
      }
      .field-input {
        display: block; width: 100%; padding: var(--space-2) var(--space-3);
        background: var(--color-bg); border: 1px solid var(--color-border);
        border-radius: var(--radius-sm); color: var(--color-text);
        font-size: 0.9375rem; outline: none; transition: border-color 120ms; min-height: 44px;
      }
      .field-input:focus-visible { border-color: var(--color-accent); box-shadow: 0 0 0 3px oklch(from var(--color-accent) l c h / 0.2); }
      .btn-primary {
        display: block; width: 100%; margin-top: var(--space-4);
        padding: var(--space-3) var(--space-4); background: var(--color-accent);
        color: #fff; border: none; border-radius: var(--radius-sm);
        font-size: 0.9375rem; font-weight: 500; cursor: pointer; min-height: 44px;
        transition: background 120ms;
      }
      .btn-primary:hover { background: var(--color-accent-hover); }
      .btn-primary:active { opacity: 0.85; }
      .add-error {
        color: var(--color-danger); font-size: 0.8125rem; margin-top: var(--space-2);
      }
    </style>
  `;

  const hostsListEl = app.querySelector('#hosts-list') as HTMLElement;
  const hostsEmpty = app.querySelector('#hosts-empty') as HTMLElement;
  const hostStatus = app.querySelector('#host-status') as HTMLElement;
  const authFailBanner = app.querySelector('#auth-fail-banner') as HTMLElement;
  const fabBtn = app.querySelector('#fab-btn') as HTMLButtonElement;
  const sheetBackdrop = app.querySelector('#sheet-backdrop') as HTMLElement;
  const addSheet = app.querySelector('#add-sheet') as HTMLElement;
  const addRelayUrl = app.querySelector('#add-relay-url') as HTMLInputElement;
  const addToken = app.querySelector('#add-token') as HTMLInputElement;
  const addSubmit = app.querySelector('#add-submit') as HTMLButtonElement;
  const addError = app.querySelector('#add-error') as HTMLElement;

  function dotClass(active: boolean, connected: boolean, reconnecting: boolean): string {
    if (!active) return 'conn-status--disconnected';
    if (connected) return '';
    if (reconnecting) return 'conn-status--reconnecting';
    return 'conn-status--disconnected';
  }

  function updateHeaderStatus(): void {
    const active = getActiveHostId();
    // wsManager doesn't expose reconnecting separately; infer from connected.
    // The status callback gives us (connected, reconnecting) transitions — we
    // stash the last state in a closure var for the header + active card.
    hostStatus.className = 'conn-status ' + dotClass(!!active, lastConnected, lastReconnecting);
    const label = hostStatus.querySelector('.conn-label') as HTMLElement;
    if (!active) label.textContent = '未连接';
    else if (lastConnected) label.textContent = '已连接';
    else if (lastReconnecting) label.textContent = '重连中…';
    else label.textContent = '离线';
  }

  function renderList(): void {
    hostsListEl.innerHTML = '';
    const all = listHosts();
    if (all.length === 0) {
      hostsEmpty.hidden = false;
      return;
    }
    hostsEmpty.hidden = true;
    const activeId = getActiveHostId();
    for (const h of all) {
      const isActive = h.host_id === activeId;
      const card = document.createElement('div');
      card.className = 'host-card' + (isActive ? ' is-active' : '');
      card.setAttribute('role', 'listitem');
      card.setAttribute('tabindex', '0');
      card.innerHTML = `
        <span class="host-icon" aria-hidden="true">${h.emoji}</span>
        <div class="host-info">
          <div class="host-name">${escapeHtml(h.nickname)}</div>
          <div class="host-meta">
            <span class="conn-dot ${
              isActive
                ? (lastConnected ? '' : lastReconnecting ? 'conn-status--reconnecting' : 'conn-status--disconnected')
                : 'meta-dot--neutral'
            }" aria-hidden="true"></span>
            <span>${escapeHtml(hostShort(h))}</span>
          </div>
        </div>
        <button class="host-menu" aria-label="主机菜单" data-menu="${h.host_id}">⋯</button>
      `;
      card.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.host-menu')) return;
        // Switch to this host and go to its sessions.
        setActiveHostId(h.host_id);
        const entry = getActiveHost();
        if (entry) wsManager.connect(entry.relay_url, entry.session_token);
        location.hash = `#/hosts/${h.host_id}/sessions`;
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
      });
      hostsListEl.appendChild(card);
    }
    // Wire menu buttons
    hostsListEl.querySelectorAll<HTMLButtonElement>('.host-menu').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const hid = btn.dataset['menu']!;
        showHostMenu(hid);
      });
    });
  }

  function showHostMenu(hostId: string): void {
    // Lightweight menu via native confirm/prompt — the host list isn't
    // high-frequency, so this is acceptable for v1 (avoids a custom menu
    // component). Rename first; if the user cancels rename, offer remove.
    const h = listHosts().find((x) => x.host_id === hostId);
    if (!h) return;
    const name = window.prompt('重命名主机（留空取消）', h.nickname);
    if (name !== null && name.trim()) {
      updateNickname(hostId, name.trim());
      renderList();
      return;
    }
    if (window.confirm(`移除主机“${h.nickname}”？\n（仅从本机删除；服务端 token 仍有效至过期）`)) {
      const wasActive = getActiveHostId() === hostId;
      removeHost(hostId);
      if (wasActive) {
        wsManager.disconnect();
        location.hash = '#/hosts';
      } else {
        renderList();
      }
    }
  }

  // Status tracking (mirrors sessions.ts/terminal.ts pattern but also drives
  // the per-card dot for the active host).
  let lastConnected = false;
  let lastReconnecting = false;
  function setStatus(connected: boolean, reconnecting: boolean): void {
    lastConnected = connected;
    lastReconnecting = reconnecting;
    updateHeaderStatus();
    renderList();
  }
  wsManager.setStatusCallback(setStatus);

  // Auth-fail: token expired/invalid. Show the banner and stop here (do NOT
  // auto-navigate away — the user picks a host to re-scan or switch).
  wsManager.setAuthFailCallback(() => {
    authFailBanner.hidden = false;
    setStatus(false, false);
  });

  // ── add sheet ─────────────────────────────────────────────────────────────
  function openSheet(): void {
    sheetOpen = true;
    sheetBackdrop.hidden = false;
    addSheet.hidden = false;
    sheetBackdrop.removeAttribute('aria-hidden');
    addSheet.removeAttribute('aria-hidden');
    fabBtn.setAttribute('aria-expanded', 'true');
    addError.hidden = true;
  }
  function closeSheet(): void {
    sheetOpen = false;
    sheetBackdrop.hidden = true;
    addSheet.hidden = true;
    sheetBackdrop.setAttribute('aria-hidden', 'true');
    addSheet.setAttribute('aria-hidden', 'true');
    fabBtn.setAttribute('aria-expanded', 'false');
  }

  fabBtn.addEventListener('click', openSheet);
  sheetBackdrop.addEventListener('click', closeSheet);

  addSubmit.addEventListener('click', () => {
    addError.hidden = true;
    const tokenStr = addToken.value.trim();
    const urlOverride = addRelayUrl.value.trim();
    if (!tokenStr) {
      showAddError('请粘贴 token 或二维码内容');
      return;
    }
    // Delegate parsing + add to the central logic in main.ts by navigating to
    // a QR-style payload hash if the input decodes to a full QR payload, else
    // build a synthetic payload. We reuse parseTokenString via the hash route
    // so all add logic lives in one place.
    //
    // If the input is a full QR payload (has url), encode it back into the
    // hash and let the route handler do the add. If it's a bare JWT, we need
    // a relay URL — require urlOverride.
    try {
      const decoded = atob(tokenStr.replace(/-/g, '+').replace(/_/g, '/'));
      const json = JSON.parse(decoded) as { url?: string; host_id?: string; token?: string };
      if (json.host_id && json.token && json.url) {
        closeSheet();
        location.hash = '#' + tokenStr; // triggers the QR-payload route → addHostAndConnect
        return;
      }
    } catch { /* not a QR payload */ }
    // Bare JWT path: need a URL.
    if (tokenStr.split('.').length === 3) {
      if (!urlOverride) {
        showAddError('JWT 需要 Relay URL，请填写');
        return;
      }
      // Build a QR-style payload and route through it so add logic is unified.
      const payload = btoa(JSON.stringify({ url: urlOverride, host_id: '', token: tokenStr }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      // host_id empty above — but the route handler needs host_id. Instead,
      // decode the JWT here to get host_id and build a proper payload.
      try {
        const jwtPayload = JSON.parse(atob(tokenStr.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { hostId?: string };
        if (!jwtPayload.hostId) { showAddError('无法从 JWT 解析 host_id'); return; }
        const full = btoa(JSON.stringify({ url: urlOverride, host_id: jwtPayload.hostId, token: tokenStr }))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        closeSheet();
        location.hash = '#' + full;
        return;
      } catch {
        showAddError('无法解析 JWT');
        return;
      }
    }
    showAddError('无法识别该 token。请扫码，或粘贴 JWT / 二维码内容。（不透明的 session_token 不能用于添加主机，请重扫二维码）');
  });

  function showAddError(msg: string): void {
    addError.textContent = msg;
    addError.hidden = false;
  }

  renderList();
  updateHeaderStatus();

  return () => {
    wsManager.setStatusCallback(() => {});
    wsManager.setAuthFailCallback(() => {});
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function hostShort(h: { relay_url: string; host_id: string }): string {
  try {
    return new URL(h.relay_url).hostname;
  } catch {
    return h.host_id.slice(0, 8);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
