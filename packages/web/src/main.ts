import { wsManager } from './ws.js';
import { mountLogin } from './login.js';
import { mountSessions } from './sessions.js';
import { mountTerminal } from './terminal.js';
import { mountHosts } from './hostsView.js';
import {
  listHosts, getHost, getActiveHostId, setActiveHostId,
  updateSessionToken, getActiveHost, hostScopedHash, parseTokenString, addHostAndConnect,
} from './hosts.js';

const app = document.getElementById('app')!;
let currentCleanup: (() => void) | null = null;

function unmount(): void {
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }
  app.innerHTML = '';
}

// ── ensureHostConnected ─────────────────────────────────────────────────────
// The single funnel for "make the WS talk to this host". Because only one host
// is connected at a time, switching = connect() to the other host's stored
// (relay_url, session_token). wsManager.connect() clears any pending reconnect
// from the old socket and closes it, so this is safe to call on every route.
//
// Returns true if the requested host is already connected+authed (the caller
// can mount its view immediately); false if a (re)connect was initiated (the
// view's status callback handles authed → list re-request, exactly as the old
// ad-hoc connect blocks did).
function ensureHostConnected(hostId: string): boolean {
  const entry = getHost(hostId);
  if (!entry) {
    // Unknown host — bounce to the hosts list. (e.g. a bookmarked route for a
    // host that was since removed.)
    location.hash = '#/hosts';
    return false;
  }
  if (wsManager.connected && getActiveHostId() === hostId) {
    return true;
  }
  setActiveHostId(hostId);
  wsManager.connect(entry.relay_url, entry.session_token);
  return false;
}

// ── routing ─────────────────────────────────────────────────────────────────
function route(): void {
  const hash = location.hash || '#/';
  unmount();

  const rawHash = hash.slice(1); // remove leading '#'

  // ── QR-code payload deep-link: #<base64url> (no leading '/') ──────────────
  if (rawHash && !rawHash.startsWith('/')) {
    const parsed = parseTokenString(rawHash);
    if (parsed && parsed.relay_url) {
      history.replaceState(null, '', '/'); // strip payload from URL bar/history
      addHostAndConnect(parsed.host_id, parsed.relay_url, parsed.token);
      // On a successful connect the relay issues a session_token (captured
      // centrally) and sends {type:'authed'}; the sessions view we land on
      // requests the list once authed. Navigate there now.
      wsManager.setStatusCallback((connected) => {
        if (connected) location.hash = `#/hosts/${parsed.host_id}/sessions`;
      });
      currentCleanup = mountSessions(app);
      return;
    }
    // Undecodable payload — drop to the hosts list rather than login, since a
    // user with existing hosts would lose their list by going to login.
    location.hash = '#/hosts';
    return;
  }

  // ── Host-scoped routes ────────────────────────────────────────────────────
  if (rawHash === '/hosts') {
    currentCleanup = mountHosts(app);
    return;
  }

  const sessionsMatch = rawHash.match(/^\/hosts\/([^/]+)\/sessions$/);
  if (sessionsMatch) {
    const hostId = sessionsMatch[1];
    ensureHostConnected(hostId);
    currentCleanup = mountSessions(app);
    return;
  }

  const terminalMatch = rawHash.match(/^\/hosts\/([^/]+)\/terminal\/(.+)$/);
  if (terminalMatch) {
    const hostId = terminalMatch[1];
    const sessionId = terminalMatch[2];
    ensureHostConnected(hostId);
    currentCleanup = mountTerminal(app, sessionId);
    return;
  }

  // ── Backward-compat redirects (old bookmarks / QR scans already in the wild)
  if (rawHash === '/sessions') {
    const active = getActiveHostId();
    location.hash = active ? `#/hosts/${active}/sessions` : '#/hosts';
    return;
  }
  if (rawHash.startsWith('/terminal/')) {
    const sid = rawHash.slice('/terminal/'.length);
    const active = getActiveHostId();
    location.hash = active ? `#/hosts/${active}/terminal/${sid}` : '#/hosts';
    return;
  }

  // ── Default (#/, #/login, empty) ─────────────────────────────────────────
  // If we have an active host with a stored token, go straight to its sessions
  // (covers refresh on the root path). Otherwise land on the hosts list (which
  // shows the empty state + add affordance when there are no hosts).
  const active = getActiveHost();
  if (active) {
    location.hash = `#/hosts/${active.host_id}/sessions`;
    return;
  }
  // No hosts at all → login (paste/scan to add the first host).
  currentCleanup = mountLogin(app);
}

// ── Central session_token_issued capture ─────────────────────────────────────
// Single handler that mirrors the relay-issued session_token into the active
// host entry. ws.ts already persists it to the global airelay_session_token
// (the write-through mirror / migration source); here we also update the
// per-host store so the entry is reusable for future reconnects/switches.
// This must be the ONE place capture happens — do not scatter it across the
// mount* functions.
wsManager.on((msg) => {
  if (msg['type'] === 'session_token_issued' && typeof msg['session_token'] === 'string') {
    const activeId = getActiveHostId();
    if (activeId) {
      updateSessionToken(activeId, msg['session_token'] as string);
    }
  }
});

// Trigger lazy migration (forced re-scan of legacy single-host users) before
// the first route resolves, by touching the store.
listHosts();

window.addEventListener('hashchange', route);
route();
