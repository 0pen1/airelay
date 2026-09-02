import { verifyHmac, verifyJwt } from '@airelay/shared';
import type { Host } from './db.js';

// ── Agent auth (HMAC) ─────────────────────────────────────────────────────────

interface AgentAuthResult {
  hostId: string;
}

/**
 * Parse and verify the HMAC authorization header sent by the agent.
 * Header format: HMAC host_id=<uuid>, ts=<unix_timestamp>, sig=<hex>
 */
export function verifyAgentAuth(
  header: string | undefined,
  getHost: (id: string) => Host | null,
): AgentAuthResult | null {
  if (!header?.startsWith('HMAC ')) return null;

  const parts = Object.fromEntries(
    header
      .slice(5)
      .split(',')
      .map((p) => p.trim().split('=') as [string, string]),
  );

  const { host_id, ts: tsStr, sig } = parts;
  if (!host_id || !tsStr || !sig) return null;

  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return null;

  const host = getHost(host_id);
  if (!host) return null;

  if (!verifyHmac(host.host_secret, host_id, ts, sig, 30)) return null;

  return { hostId: host_id };
}

// ── Client auth (JWT first, session_token on reconnect) ───────────────────────

interface ClientAuthResult {
  hostId: string;
  sessionToken: string;
}

/**
 * Verify a JWT access_token (first connection after scanning QR code).
 * On success, the jti is written to the blacklist and a new session_token is created.
 */
export async function verifyClientJwt(
  token: string,
  getHost: (id: string) => Host | null,
  hasJti: (jti: string) => boolean,
  addJti: (jti: string, expiresAt: number) => void,
  createSessionToken: (hostId: string) => string,
): Promise<ClientAuthResult | null> {
  try {
    // Decode without verification first to get host_id for key lookup
    const [, payloadB64] = token.split('.');
    if (!payloadB64) return null;
    const raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const hostId: string = raw.hostId;
    if (!hostId) return null;

    const host = getHost(hostId);
    if (!host) return null;

    const payload = await verifyJwt(host.host_secret, token);

    if (hasJti(payload.jti)) return null; // already used
    addJti(payload.jti, payload.exp);

    const sessionToken = createSessionToken(hostId);
    return { hostId, sessionToken };
  } catch {
    return null;
  }
}

/**
 * Verify a session_token (reconnection path).
 */
export function verifySessionTokenAuth(
  token: string,
  getSessionToken: (token: string) => { host_id: string } | null,
): { hostId: string } | null {
  const row = getSessionToken(token);
  if (!row) return null;
  return { hostId: row.host_id };
}
