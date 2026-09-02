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
}

function getDbPath(): string {
  const isRoot = process.getuid?.() === 0;
  const dir = isRoot ? '/etc/airelay' : join(homedir(), '.config', 'airelay');
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
      token      TEXT PRIMARY KEY,
      host_id    TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked    INTEGER NOT NULL DEFAULT 0
    );
  `);
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
}

// ── Session tokens ────────────────────────────────────────────────────────────

export function createSessionToken(host_id: string, ttlSeconds = 7 * 24 * 3600): string {
  const token = randomBytes(32).toString('hex');
  const expires_at = Math.floor(Date.now() / 1000) + ttlSeconds;
  getDb()
    .prepare('INSERT INTO session_tokens (token, host_id, expires_at, revoked) VALUES (?, ?, ?, 0)')
    .run(token, host_id, expires_at);
  return token;
}

export function getSessionToken(token: string): SessionToken | null {
  const row = getDb()
    .prepare('SELECT * FROM session_tokens WHERE token = ?')
    .get(token) as SessionToken | undefined;
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.revoked || row.expires_at < now) return null;
  return row;
}

export function revokeSessionToken(token: string): void {
  getDb().prepare('UPDATE session_tokens SET revoked = 1 WHERE token = ?').run(token);
}
