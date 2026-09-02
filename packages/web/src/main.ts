import { wsManager } from './ws.js';
import { mountLogin } from './login.js';
import { mountSessions } from './sessions.js';
import { mountTerminal } from './terminal.js';

const app = document.getElementById('app')!;
let currentCleanup: (() => void) | null = null;

function unmount(): void {
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }
  app.innerHTML = '';
}

function route(): void {
  const hash = location.hash || '#/';
  unmount();

  const sessionToken = localStorage.getItem('airelay_session_token');
  const relayUrl = localStorage.getItem('airelay_relay_url');

  // Parse QR-code payload from hash: #/<base64>
  // The hash may contain a base64url payload from gen-token QR code
  const rawHash = hash.slice(1); // remove leading '#'
  if (rawHash && !rawHash.startsWith('/')) {
    // Looks like a base64 payload (no leading slash)
    try {
      const decoded = JSON.parse(atob(rawHash.replace(/-/g, '+').replace(/_/g, '/')));
      if (decoded.url && decoded.host_id && decoded.token) {
        // Store relay URL, clear old session token, connect immediately
        localStorage.setItem('airelay_relay_url', decoded.url);
        localStorage.removeItem('airelay_session_token');
        history.replaceState(null, '', '/');
        location.hash = '#/login';
        // Pre-fill and connect
        wsManager.connect(decoded.url, decoded.token);
        wsManager.setStatusCallback((connected) => {
          if (connected) location.hash = '#/sessions';
        });
        wsManager.on((msg) => {
          if (msg['type'] === 'session_token_issued') {
            location.hash = '#/sessions';
          }
        });
        currentCleanup = mountLogin(app);
        return;
      }
    } catch { /* not a QR payload, fall through */ }
  }

  if (rawHash.startsWith('/terminal/')) {
    const sessionId = rawHash.slice('/terminal/'.length);
    if (!sessionId) { location.hash = '#/sessions'; return; }
    currentCleanup = mountTerminal(app, sessionId);
    return;
  }

  if (rawHash === '/sessions') {
    // Auto-reconnect with stored session_token if not already connected
    if (!wsManager.connected && sessionToken && relayUrl) {
      wsManager.connect(relayUrl, sessionToken);
    }
    currentCleanup = mountSessions(app);
    return;
  }

  // Default: login
  // If we have a session_token, try to reconnect silently
  if (sessionToken && relayUrl && !wsManager.connected) {
    wsManager.connect(relayUrl, sessionToken);
    wsManager.setStatusCallback((connected) => {
      if (connected) location.hash = '#/sessions';
    });
  }
  currentCleanup = mountLogin(app);
}

// Persist relay URL whenever we connect successfully
wsManager.on((msg) => {
  if (msg['type'] === 'session_token_issued') {
    // session_token already persisted by ws.ts; store nothing extra here
  }
});

window.addEventListener('hashchange', route);
route();
