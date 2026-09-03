import { wsManager } from './ws.js';
import { parseTokenString, addHostAndConnect } from './hosts.js';

export function mountLogin(app: HTMLElement): () => void {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <h1 class="login-title">airelay</h1>
        <p class="login-sub">Connect to your AI agents remotely</p>
        <div id="login-error" class="login-error" hidden></div>
        <form id="login-form" autocomplete="off">
          <label class="field-label" for="relay-url">Relay URL</label>
          <input class="field-input" id="relay-url" type="url"
            placeholder="https://your-vps.example.com" required />
          <label class="field-label" for="token-input">Access Token</label>
          <input class="field-input" id="token-input" type="text"
            placeholder="Paste token or scan QR code" required />
          <button class="btn-primary" type="submit">Connect</button>
        </form>
      </div>
    </div>
    <style>
      .login-wrap {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--space-6);
      }
      .login-card {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        padding: var(--space-8);
        width: 100%;
        max-width: 400px;
      }
      .login-title {
        font-size: 1.5rem;
        font-weight: 600;
        letter-spacing: -0.02em;
        margin-bottom: var(--space-1);
      }
      .login-sub {
        color: var(--color-text-muted);
        margin-bottom: var(--space-6);
      }
      .login-error {
        background: oklch(95% 0.04 25);
        color: var(--color-danger);
        border: 1px solid oklch(85% 0.08 25);
        border-radius: var(--radius-sm);
        padding: var(--space-3) var(--space-4);
        margin-bottom: var(--space-4);
        font-size: 0.875rem;
      }
      @media (prefers-color-scheme: dark) {
        .login-error { background: oklch(20% 0.04 25); border-color: oklch(35% 0.08 25); }
      }
      .field-label {
        display: block;
        font-size: 0.875rem;
        font-weight: 500;
        margin-bottom: var(--space-1);
        margin-top: var(--space-4);
      }
      .field-input {
        display: block;
        width: 100%;
        padding: var(--space-2) var(--space-3);
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text);
        font-size: 0.9375rem;
        outline: none;
        transition: border-color 120ms;
        min-height: 44px;
      }
      .field-input:focus-visible {
        border-color: var(--color-accent);
        box-shadow: 0 0 0 3px oklch(from var(--color-accent) l c h / 0.2);
      }
      .btn-primary {
        display: block;
        width: 100%;
        margin-top: var(--space-6);
        padding: var(--space-3) var(--space-4);
        background: var(--color-accent);
        color: #fff;
        border: none;
        border-radius: var(--radius-sm);
        font-size: 0.9375rem;
        font-weight: 500;
        cursor: pointer;
        min-height: 44px;
        transition: background 120ms;
      }
      .btn-primary:hover { background: var(--color-accent-hover); }
      .btn-primary:active { opacity: 0.85; }
      .btn-primary:focus-visible {
        outline: 3px solid oklch(from var(--color-accent) l c h / 0.4);
        outline-offset: 2px;
      }
    </style>
  `;

  const form = app.querySelector('#login-form') as HTMLFormElement;
  const errorDiv = app.querySelector('#login-error') as HTMLDivElement;

  function showError(msg: string): void {
    errorDiv.textContent = msg;
    errorDiv.hidden = false;
  }

  const off = wsManager.on((msg) => {
    // session_token_issued is captured centrally (main.ts writes it into the
    // host entry); login only needs to surface errors here.
    if (msg['type'] === 'error') {
      showError((msg['message'] as string) ?? 'Connection error');
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errorDiv.hidden = true;
    const relayUrl = (app.querySelector('#relay-url') as HTMLInputElement).value.trim();
    const tokenInput = (app.querySelector('#token-input') as HTMLInputElement).value.trim();

    // The token may be a full QR payload (carries its own url) OR a bare JWT
    // (needs the relay-url field). Parse it to recover host_id (required to
    // build a HostEntry). Opaque session_tokens are rejected — they're for
    // reconnect, not provisioning; re-scan the QR instead.
    const parsed = parseTokenString(tokenInput, relayUrl || undefined);
    if (!parsed) {
      showError('无法识别该 token。请扫码，或粘贴 JWT / 二维码内容。（不透明的 session_token 不能用于添加主机，请重扫二维码）');
      return;
    }
    if (!parsed.relay_url) {
      showError('该 token 不含 Relay URL，请填写 Relay URL');
      return;
    }
    // addHostAndConnect writes the entry (placeholder JWT) + connects. The
    // central session_token_issued handler captures the real token; on authed
    // we jump to that host's sessions.
    const hostId = addHostAndConnect(parsed.host_id, parsed.relay_url, parsed.token);
    wsManager.setStatusCallback((connected) => {
      if (connected) location.hash = `#/hosts/${hostId}/sessions`;
    });
  });

  return () => { off(); };
}
