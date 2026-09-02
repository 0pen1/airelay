import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { v4 as uuidv4 } from 'uuid';
import type { AgentDriver } from './drivers/types.js';
import type { PtyDriverConfig, AgentDriverConfig } from '@airelay/shared';

const exec = promisify(execCb);
const CONFIG_DIR = join(homedir(), '.config', 'airelay');
const SESSIONS_FILE = join(CONFIG_DIR, 'sessions.json');

export interface SessionEntry {
  sessionId: string;
  agentId: string;
  lockedBy: string | null;
  createdAt: number;
}

interface PersistedSession {
  sessionId: string;
  agentId: string;
  createdAt: number;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry & { driver: AgentDriver }>();
  private drivers = new Map<string, AgentDriver>();

  registerDriver(driver: AgentDriver): void {
    this.drivers.set(driver.agentId, driver);
  }

  getDriver(agentId: string): AgentDriver | undefined {
    return this.drivers.get(agentId);
  }

  /** Restore sessions surviving an agent restart by scanning tmux. */
  async restore(): Promise<void> {
    let raw: string;
    try {
      const { stdout } = await exec("tmux list-sessions -F '#{session_name}'");
      raw = stdout;
    } catch {
      return; // no tmux server running yet
    }

    const tmuxIds = raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('airelay-'));

    const persisted = this.loadPersistedSessions();

    for (const tmuxId of tmuxIds) {
      const sessionId = tmuxId.slice('airelay-'.length);
      const meta = persisted.find((p) => p.sessionId === sessionId);
      if (!meta) continue;

      const driver = this.drivers.get(meta.agentId);
      if (!driver) continue;

      // Re-attach control mode without starting a new tmux session
      if ('reattach' in driver && typeof (driver as any).reattach === 'function') {
        (driver as any).reattach(sessionId);
      }

      this.sessions.set(sessionId, {
        sessionId,
        agentId: meta.agentId,
        lockedBy: null,
        createdAt: meta.createdAt,
        driver,
      });
    }
  }

  async create(agentId: string): Promise<string> {
    const driver = this.drivers.get(agentId);
    if (!driver) throw new Error(`No driver for agent: ${agentId}`);

    const sessionId = uuidv4();
    await driver.start(sessionId);

    this.sessions.set(sessionId, {
      sessionId,
      agentId,
      lockedBy: null,
      createdAt: Math.floor(Date.now() / 1000),
      driver,
    });

    this.persistSessions();
    return sessionId;
  }

  get(sessionId: string): (SessionEntry & { driver: AgentDriver }) | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionEntry[] {
    return Array.from(this.sessions.values()).map(({ driver: _d, ...rest }) => rest);
  }

  lock(sessionId: string, connId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.lockedBy !== null) return false;
    s.lockedBy = connId;
    return true;
  }

  unlock(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lockedBy = null;
  }

  isLocked(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.lockedBy ?? null) !== null;
  }

  async remove(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      await s.driver.stop(sessionId).catch(() => {});
      this.sessions.delete(sessionId);
      this.persistSessions();
    }
  }

  private loadPersistedSessions(): PersistedSession[] {
    if (!existsSync(SESSIONS_FILE)) return [];
    try {
      return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as PersistedSession[];
    } catch {
      return [];
    }
  }

  private persistSessions(): void {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const data: PersistedSession[] = Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      agentId: s.agentId,
      createdAt: s.createdAt,
    }));
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  }
}
