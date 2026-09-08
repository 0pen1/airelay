// Uses the built-in node:sqlite module (Node 22.5+ experimental, stable in Node 25).
// No native compilation needed — zero extra dependencies.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Host {
  host_id: string;
  host_secret: string;
  name: string;
  created_at: number;
}

export interface SessionToken {
  token: string;
  host_id: string;
  expires_at: number;
  revoked: number;
  device_name: string;
  created_at: number;
  last_used_at: number;
}

function getDbPath(): string {
  const isRoot = process.getuid?.() === 0;
  const dir = process.env.AIRELAY_CONFIG_DIR
    ?? (isRoot ? '/etc/airelay' : join(homedir(), '.config', 'airelay'));
  mkdirSync(dir, { recursive: true });
  return join(dir, 'relay.db');
}

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  _db = new DatabaseSync(getDbPath());
  _db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      host_id    TEXT PRIMARY KEY,
      host_secret TEXT NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jti_blacklist (
      jti        TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_tokens (
      token       TEXT PRIMARY KEY,
      host_id     TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0,
      device_name TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL DEFAULT 0
    );

    -- Rotated-out token values that still authenticate during the grace
    -- window. Each row maps to the device row now holding a different token.
    CREATE TABLE IF NOT EXISTS token_grace (
      token      TEXT PRIMARY KEY,
      host_id    TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- Web Push subscriptions (one per browser/device). Zero-knowledge: the
    -- relay only ever pushes opaque metadata ("host has activity"), never
    -- terminal content.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint  TEXT PRIMARY KEY,
      host_id   TEXT NOT NULL,
      p256dh    TEXT NOT NULL,
      auth      TEXT NOT NULL,
      device_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  // Migrations for pre-existing DBs (CREATE TABLE IF NOT EXISTS won't add
  // columns to an older table).
  const cols = getDb().prepare("PRAGMA table_info(session_tokens)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('device_name')) {
    getDb().exec("ALTER TABLE session_tokens ADD COLUMN device_name TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.has('created_at')) {
    getDb().exec('ALTER TABLE session_tokens ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
  }
  if (!colNames.has('last_used_at')) {
    getDb().exec('ALTER TABLE session_tokens ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0');
  }
  return _db;
}

// ── Hosts ─────────────────────────────────────────────────────────────────────

export function registerHost(host_id: string, host_secret: string, name: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO hosts (host_id, host_secret, name, created_at) VALUES (?, ?, ?, ?)')
    .run(host_id, host_secret, name, Math.floor(Date.now() / 1000));
}

export function getHost(host_id: string): Host | null {
  return (getDb().prepare('SELECT * FROM hosts WHERE host_id = ?').get(host_id) as Host) ?? null;
}

export function revokeHost(host_id: string): void {
  getDb().prepare('DELETE FROM hosts WHERE host_id = ?').run(host_id);
}

export function listHosts(): Host[] {
  return getDb().prepare('SELECT * FROM hosts ORDER BY created_at').all() as Host[];
}

// ── JTI blacklist ─────────────────────────────────────────────────────────────

export function addJti(jti: string, expires_at: number): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO jti_blacklist (jti, expires_at) VALUES (?, ?)')
    .run(jti, expires_at);
}

export function hasJti(jti: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM jti_blacklist WHERE jti = ?').get(jti);
  return row !== undefined;
}

export function cleanExpiredJtis(): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare('DELETE FROM jti_blacklist WHERE expires_at < ?').run(now);
  // Also drop expired grace aliases so the table stays small.
  getDb().prepare('DELETE FROM token_grace WHERE expires_at < ?').run(now);
}

// ── Session tokens ────────────────────────────────────────────────────────────

/** Grace window (seconds): a rotated-out token keeps working this long so an
 *  in-flight reconnect doesn't race its own rotation. */
export const TOKEN_ROTATION_GRACE = 60;

export function createSessionToken(
  host_id: string,
  ttlSeconds = 7 * 24 * 3600,
  device_name = '',
): string {
  const token = randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(`INSERT INTO session_tokens
      (token, host_id, expires_at, revoked, device_name, created_at, last_used_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)`)
    .run(token, host_id, now + ttlSeconds, device_name, now, now);
  return token;
}

export function getSessionToken(token: string): SessionToken | null {
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();

  // Current credential on a device row.
  let row = db
    .prepare('SELECT * FROM session_tokens WHERE token = ?')
    .get(token) as SessionToken | undefined;
  if (!row) {
    // Rotated-out value still within its grace window → resolve to the
    // device row that replaced it.
    const grace = db
      .prepare('SELECT host_id FROM token_grace WHERE token = ? AND expires_at >= ?')
      .get(token, now) as { host_id: string } | undefined;
    if (!grace) return null;
    row = db
      .prepare('SELECT * FROM session_tokens WHERE host_id = ? ORDER BY last_used_at DESC LIMIT 1')
      .get(grace.host_id) as SessionToken | undefined;
    if (!row) return null;
  }
  if (row.revoked || row.expires_at < now) return null;
  // Touch last_used_at at most once per minute to avoid a write per message.
  if (now - row.last_used_at >= 60) {
    db.prepare('UPDATE session_tokens SET last_used_at = ? WHERE token = ?').run(now, row.token);
  }
  return row;
}

export function revokeSessionToken(token: string): void {
  getDb().prepare('UPDATE session_tokens SET revoked = 1 WHERE token = ?').run(token);
}

/** All non-expired tokens for a host (active + recently rotated-out). */
export function listSessionTokens(host_id: string): SessionToken[] {
  const now = Math.floor(Date.now() / 1000);
  return getDb()
    .prepare('SELECT * FROM session_tokens WHERE host_id = ? AND expires_at >= ? ORDER BY created_at DESC')
    .all(host_id, now) as SessionToken[];
}

/**
 * Token rotation: replace the token value in place for the device identified
 * by `oldToken`. In-place means the device stays one row: the device list is
 * stable, and revoking that row kills the device's current credential.
 * The old value keeps working for TOKEN_ROTATION_GRACE seconds (in-flight
 * reconnect race), enforced via a parallel grace window, not the row itself.
 */
export function rotateSessionToken(oldToken: string, ttlSeconds = 7 * 24 * 3600): string | null {
  const row = getSessionToken(oldToken);
  if (!row) return null;
  const newToken = randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  // Register the old value as a grace alias pointing at the same row.
  db.prepare(
    `INSERT OR REPLACE INTO token_grace (token, host_id, expires_at) VALUES (?, ?, ?)`,
  ).run(oldToken, row.host_id, now + TOKEN_ROTATION_GRACE);
  // Swap the credential on the device row.
  db.prepare(
    `UPDATE session_tokens SET token = ?, expires_at = ?, last_used_at = ? WHERE token = ?`,
  ).run(newToken, now + ttlSeconds, now, oldToken);
  return newToken;
}

// ── Push subscriptions ────────────────────────────────────────────────────────

export interface PushSubRow {
  endpoint: string;
  host_id: string;
  p256dh: string;
  auth: string;
  device_name: string;
  created_at: number;
}

export function upsertPushSubscription(
  endpoint: string,
  host_id: string,
  p256dh: string,
  auth: string,
  device_name: string,
): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO push_subscriptions
      (endpoint, host_id, p256dh, auth, device_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(endpoint, host_id, p256dh, auth, device_name, Math.floor(Date.now() / 1000));
}

export function getPushSubscriptions(host_id: string): PushSubRow[] {
  return getDb()
    .prepare('SELECT * FROM push_subscriptions WHERE host_id = ?')
    .all(host_id) as PushSubRow[];
}

export function deletePushSubscription(endpoint: string): void {
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}
