// Local multi-host store.
//
// The phone can manage several hosts (each = a relay URL + an access token).
// Only ONE is connected at a time (see ws.ts / main.ts ensureHostConnected);
// this module is just the persistent list + the "active" pointer. Host
// nicknames live here locally — the relay/agent never send a human-readable
// host name over the wire, so the phone names each host itself (default =
// the relay hostname, user-renameable).
//
// Storage layout (localStorage, JSON):
//   airelay_hosts        → HostEntry[]   (keyed by host_id; upsert semantics)
//   airelay_active_host  → host_id       (the host the single WS is bound to)
//
// host_id is a UUID stable across reinstalls and is also the route key
// (#/hosts/<host_id>/...). session_token is the 7-day opaque reconnect token
// the relay mints from the one-time JWT on first connect — so a HostEntry is
// only reusable once that exchange has happened (see captureSessionToken).

const HOSTS_KEY = 'airelay_hosts';
const ACTIVE_KEY = 'airelay_active_host';

export interface HostEntry {
  host_id: string;        // primary key + route key (UUID)
  relay_url: string;      // origin as given (ws.ts does http→ws + /ws/client)
  session_token: string;  // 7-day opaque token; placeholder JWT only transiently
  nickname: string;       // local-only display name
  emoji: string;          // default '💻'
  added_at: number;       // ms
}

// ── migration (forced re-scan) ───────────────────────────────────────────────
// Pre-multi-host builds stored a single connection in `airelay_session_token`
// + `airelay_relay_url`. That token is opaque 32-byte hex — its host_id is NOT
// recoverable client-side (the relay resolves it from its DB). We can't build
// a proper HostEntry (which is keyed/routed by host_id) from it. Per the
// agreed design we don't fabricate a sentinel: clear the legacy keys and let
// the user re-scan a host QR, which yields a host_id (from the payload) plus a
// fresh JWT. Called lazily on first listHosts().
let migrated = false;
function migrateLegacy(): void {
  if (migrated) return;
  migrated = true;
  const hasHosts = localStorage.getItem(HOSTS_KEY) !== null;
  if (hasHosts) return;
  const legacyToken = localStorage.getItem('airelay_session_token');
  const legacyUrl = localStorage.getItem('airelay_relay_url');
  if (legacyToken || legacyUrl) {
    localStorage.removeItem('airelay_session_token');
    localStorage.removeItem('airelay_relay_url');
  }
}

function readAll(): HostEntry[] {
  migrateLegacy();
  try {
    const raw = localStorage.getItem(HOSTS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as HostEntry[];
  } catch {
    return [];
  }
}

function writeAll(hosts: HostEntry[]): void {
  localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
}

export function listHosts(): HostEntry[] {
  return readAll();
}

export function getHost(hostId: string): HostEntry | null {
  return readAll().find((h) => h.host_id === hostId) ?? null;
}

export function getActiveHostId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveHostId(hostId: string): void {
  localStorage.setItem(ACTIVE_KEY, hostId);
}

/** Upsert by host_id. Updates an existing entry's token/nickname; else inserts. */
export function addHost(entry: HostEntry): void {
  const hosts = readAll();
  const i = hosts.findIndex((h) => h.host_id === entry.host_id);
  if (i >= 0) {
    hosts[i] = { ...hosts[i], ...entry };
  } else {
    hosts.push(entry);
  }
  writeAll(hosts);
}

export function updateNickname(hostId: string, nickname: string): void {
  const hosts = readAll();
  const h = hosts.find((x) => x.host_id === hostId);
  if (h) {
    h.nickname = nickname;
    writeAll(hosts);
  }
}

export function removeHost(hostId: string): void {
  writeAll(readAll().filter((h) => h.host_id !== hostId));
  if (getActiveHostId() === hostId) {
    localStorage.removeItem(ACTIVE_KEY);
  }
}

/** Called by the central session_token_issued handler (main.ts) for the active host. */
export function updateSessionToken(hostId: string, token: string): void {
  const hosts = readAll();
  const h = hosts.find((x) => x.host_id === hostId);
  if (h) {
    h.session_token = token;
    writeAll(hosts);
  }
}

export function getActiveHost(): HostEntry | null {
  const id = getActiveHostId();
  return id ? getHost(id) : null;
}

/** Build a host-scoped route hash for the currently-active host. */
export function hostScopedHash(sub: string): string {
  const id = getActiveHostId();
  // sub like '/sessions' or '/terminal/<sid>'; if no active host, fall back to
  // the hosts list so callers don't produce a dangling route.
  return id ? `#/hosts/${id}${sub}` : '#/hosts';
}

/** Derive a default nickname from a relay URL (the hostname). */
export function defaultNickname(relayUrl: string): string {
  try {
    return new URL(relayUrl).hostname;
  } catch {
    return 'Host';
  }
}

// ── token parsing + add-and-connect (shared by QR landing + login paste) ─────
// These live in the store module (not main.ts) so both the QR-landing route
// and the login paste form can call them without main.ts↔views import cycles.
// Importing wsManager here is safe: ws.ts has no dependency back on hosts.ts.

import { wsManager } from './ws.js';

export interface ParsedToken {
  host_id: string;
  relay_url: string | null; // null when the input was a bare JWT (caller must supply a URL)
  token: string;
}

/**
 * Parse a pasted/scanned token string. Accepts:
 *   • a full QR payload (base64url JSON: {url, host_id, token}), OR
 *   • a raw JWT (header.payload.signature) — middle segment decodes to {hostId}.
 * Returns null for an opaque session_token (32-byte hex, undecodable): those are
 * reconnect-only credentials and can't provision a new host entry (host_id is
 * unknowable). When the input is a bare JWT, relay_url is null and fallbackUrl
 * (if provided) is substituted.
 */
export function parseTokenString(input: string, fallbackUrl?: string): ParsedToken | null {
  const s = input.trim();
  // Try as QR payload: base64url → JSON {url, host_id, token}
  try {
    const decoded = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const json = JSON.parse(decoded) as { url?: string; host_id?: string; token?: string };
    if (json.host_id && json.token) {
      return { host_id: json.host_id, relay_url: json.url ?? null, token: json.token };
    }
  } catch { /* not a base64 JSON payload */ }
  // Try as JWT: split on '.', decode middle segment → {hostId, ...}
  const parts = s.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
        hostId?: string;
      };
      if (payload.hostId) {
        return { host_id: payload.hostId, relay_url: fallbackUrl ?? null, token: s };
      }
    } catch { /* not a JWT */ }
  }
  return null;
}

/**
 * Write a HostEntry (upsert by host_id) using the one-time JWT as a PLACEHOLDER
 * session_token, then connect. The central session_token_issued handler
 * (main.ts) overwrites the placeholder with the real 7-day token once the relay
 * mints it. The entry must exist before connect so the handler has something
 * to update. Re-scanning an existing host_id refreshes its token (and keeps the
 * user's nickname). Returns the host_id.
 */
export function addHostAndConnect(hostId: string, relayUrl: string, jwt: string): string {
  const existing = getHost(hostId);
  const entry: HostEntry = {
    host_id: hostId,
    relay_url: relayUrl,
    session_token: jwt, // placeholder; replaced on session_token_issued
    nickname: existing?.nickname ?? defaultNickname(relayUrl),
    emoji: existing?.emoji ?? '💻',
    added_at: existing?.added_at ?? Date.now(),
  };
  addHost(entry);
  setActiveHostId(hostId);
  wsManager.connect(relayUrl, jwt);
  return hostId;
}
