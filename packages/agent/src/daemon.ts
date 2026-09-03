import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { signHmac, validateSessionId, validateAgentId } from '@airelay/shared';
import type {
  ClientToAgentMsg, AgentDriverConfig, PtyDriverConfig,
  AgentTypeInfo, SessionInfo, ErrorCode,
} from '@airelay/shared';
import { SessionManager } from './sessions.js';
import { PtyDriver } from './drivers/pty-driver.js';
import type { Disposable } from './drivers/types.js';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);
const CONFIG_DIR = join(homedir(), '.config', 'airelay');
const CHUNK_SIZE = 64 * 1024; // 64 KB

interface Config {
  relayUrl: string;
  hostId: string;
  hostSecret: string;
}

function loadConfig(): Config {
  return JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8')) as Config;
}

function loadAgentsConfig(): AgentDriverConfig[] {
  try {
    const raw = JSON.parse(readFileSync(join(CONFIG_DIR, 'agents.json'), 'utf8'));
    return raw.agents as AgentDriverConfig[];
  } catch {
    return [];
  }
}

/** Build PtyDriver instances for every pty-type agent in agents.json. */
function buildDriversFromConfig(): PtyDriver[] {
  const drivers: PtyDriver[] = [];
  for (const a of loadAgentsConfig()) {
    if (a.type === 'pty') {
      drivers.push(new PtyDriver({ agentId: a.id, command: a.command, args: a.args }));
    }
    // BrowserDriver: v2, skip for now
  }
  return drivers;
}

function buildAuthHeader(hostId: string, hostSecret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signHmac(hostSecret, hostId, ts);
  return `HMAC host_id=${hostId}, ts=${ts}, sig=${sig}`;
}

async function isAvailable(command: string): Promise<boolean> {
  try {
    await exec(`which ${command}`);
    return true;
  } catch {
    return false;
  }
}

/** Timestamped stderr log — launchd/nohup redirect this to agent.err.log. */
function log(msg: string): void {
  process.stderr.write(`[airelay-agent ${new Date().toISOString()}] ${msg}\n`);
}

export function startDaemon(): void {
  const config = loadConfig();
  const sessionManager = new SessionManager();

  // Active output/exit subscriptions per session, so we can dispose them on
  // detach/disconnect. Without this, a re-attach (e.g. after daemon restart,
  // or clicking a session from the list) would find no live callback to
  // forward tmux output to the client — the terminal would freeze.
  const subs = new Map<string, Disposable[]>();

  function disposeSubs(sessionId: string): void {
    const list = subs.get(sessionId);
    if (list) {
      for (const d of list) d.dispose();
      subs.delete(sessionId);
    }
  }

  // Register drivers from agents.json
  sessionManager.syncDrivers(buildDriversFromConfig());

  // Reload drivers on SIGHUP (sent by `airelay agent reload`). Safe to call
  // at any time: syncDrivers preserves live sessions' driver instances.
  process.on('SIGHUP', () => {
    const { added, removed } = sessionManager.syncDrivers(buildDriversFromConfig());
    log(`agents.json reloaded (SIGHUP): +${added.length} -${removed.length}`);
    if (added.length) log(`  added: ${added.join(', ')}`);
    if (removed.length) log(`  removed: ${removed.join(', ')}`);
  });

  // Restore surviving sessions from before restart
  sessionManager.restore().catch(() => {});

  let ws: WebSocket | null = null;
  let reconnectDelay = 1000;

  function connect(): void {
    const url = config.relayUrl.replace(/^http/, 'ws') + '/ws/agent';
    ws = new WebSocket(url, {
      headers: { Authorization: buildAuthHeader(config.hostId, config.hostSecret) },
    });

    ws.on('open', () => {
      reconnectDelay = 1000;
      ws!.send(JSON.stringify({ type: 'agent_hello', host_id: config.hostId, version: '0.1.0' }));

      // Heartbeat
      const ping = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.ping();
        else clearInterval(ping);
      }, 30_000);
    });

    ws.on('message', (data) => {
      let msg: ClientToAgentMsg & Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleMessage(msg, ws!);
    });

    ws.on('close', () => {
      ws = null;
      setTimeout(connect, Math.min(reconnectDelay, 60_000));
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    });

    ws.on('error', () => { /* handled by close */ });
  }

  function send(obj: unknown): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  async function handleMessage(msg: Record<string, unknown>, _ws: WebSocket): Promise<void> {
    const type = msg['type'] as string;

    if (type === 'client_disconnected') {
      const sid = msg['session_id'] as string | undefined;
      if (sid) {
        sessionManager.unlock(sid);
        disposeSubs(sid);
      }
      return;
    }

    if (type === 'list_agent_types') {
      const agentsConfig = loadAgentsConfig();
      const agents: AgentTypeInfo[] = await Promise.all(
        agentsConfig.map(async (a) => ({
          id: a.id,
          name: a.name,
          icon: a.icon,
          available: a.type === 'pty' ? await isAvailable(a.command) : false,
        })),
      );
      send({ type: 'agent_types', agents });
      return;
    }

    if (type === 'list_sessions') {
      const agentsConfig = loadAgentsConfig();
      const sessions: SessionInfo[] = sessionManager.list().map((s) => {
        const cfg = agentsConfig.find((a) => a.id === s.agentId);
        return {
          session_id: s.sessionId,
          agent_id: s.agentId,
          agent_name: cfg?.name ?? s.agentId,
          icon: cfg?.icon ?? '🤖',
          created_at: s.createdAt,
          locked_by: s.lockedBy,
        };
      });
      send({ type: 'sessions_list', sessions });
      return;
    }

    if (type === 'new_session') {
      const agentId = msg['agent_id'] as string | undefined;
      if (!agentId || !validateAgentId(agentId)) {
        send({ type: 'error', code: 'AGENT_NOT_FOUND' as ErrorCode, message: 'Invalid agent_id' });
        return;
      }
      let driver = sessionManager.getDriver(agentId);
      if (!driver) {
        // The agent may have been added to agents.json after the daemon
        // started (or after a SIGHUP race). Re-sync from disk once before
        // giving up, so new agents work without a daemon restart.
        sessionManager.syncDrivers(buildDriversFromConfig());
      }
      driver = sessionManager.getDriver(agentId);
      if (!driver) {
        send({ type: 'error', code: 'AGENT_NOT_FOUND' as ErrorCode, message: `Agent not found: ${agentId}` });
        return;
      }
      try {
        const sessionId = await sessionManager.create(agentId);
        send({ type: 'session_created', session_id: sessionId, agent_id: agentId });
        // Auto-attach (doAttach wires up output/exit forwarding)
        await doAttach(sessionId, 'auto');
      } catch (err) {
        send({ type: 'error', code: 'AGENT_UNAVAILABLE' as ErrorCode, message: String(err) });
      }
      return;
    }

    if (type === 'attach') {
      const sessionId = msg['session_id'] as string | undefined;
      if (!sessionId || !validateSessionId(sessionId)) {
        send({ type: 'error', code: 'SESSION_NOT_FOUND' as ErrorCode, message: 'Invalid session_id' });
        return;
      }
      await doAttach(sessionId, 'explicit');
      return;
    }

    if (type === 'input') {
      const sessionId = msg['session_id'] as string | undefined;
      const data = msg['data'] as string | undefined;
      if (!sessionId || !validateSessionId(sessionId) || data === undefined) return;
      const session = sessionManager.get(sessionId);
      if (!session) return;
      await session.driver.sendInput(sessionId, data).catch(() => {});
      return;
    }

    if (type === 'resize') {
      const sessionId = msg['session_id'] as string | undefined;
      const cols = msg['cols'] as number | undefined;
      const rows = msg['rows'] as number | undefined;
      if (!sessionId || !validateSessionId(sessionId) || !cols || !rows) return;
      const session = sessionManager.get(sessionId);
      if (!session) return;
      await session.driver.resize(sessionId, cols, rows).catch(() => {});
      return;
    }

    if (type === 'detach') {
      const sessionId = msg['session_id'] as string | undefined;
      if (!sessionId || !validateSessionId(sessionId)) return;
      sessionManager.unlock(sessionId);
      disposeSubs(sessionId);
      return;
    }
  }

  async function doAttach(sessionId: string, _source: 'auto' | 'explicit'): Promise<void> {
    const session = sessionManager.get(sessionId);
    if (!session) {
      send({ type: 'error', code: 'SESSION_NOT_FOUND' as ErrorCode, message: `Session not found: ${sessionId}` });
      return;
    }
    if (session.lockedBy !== null && _source !== 'auto') {
      send({ type: 'error', code: 'SESSION_OCCUPIED' as ErrorCode, message: 'Session is occupied' });
      return;
    }
    if (_source === 'explicit') sessionManager.lock(sessionId, 'client');
    send({ type: 'attached', session_id: sessionId });

    // (Re)wire output/exit forwarding for this session. disposeSubs first so
    // a re-attach doesn't stack duplicate callbacks. This is what makes a
    // session clicked from the list (or restored after a daemon restart)
    // actually stream live output — new_session never registered callbacks
    // for restored sessions, and the original ones died with the old process.
    disposeSubs(sessionId);
    const list: Disposable[] = [];
    list.push(
      session.driver.onOutput(sessionId, (data) =>
        send({ type: 'output', session_id: sessionId, data }),
      ),
    );
    list.push(
      session.driver.onExit(sessionId, (code) => {
        send({ type: 'session_exited', session_id: sessionId, code });
        disposeSubs(sessionId);
        sessionManager.remove(sessionId).catch(() => {});
      }),
    );
    subs.set(sessionId, list);

    // Send scrollback in 64 KB chunks
    try {
      const scrollback = await session.driver.getScrollback(sessionId);
      const chunks: string[] = [];
      for (let i = 0; i < scrollback.length; i += CHUNK_SIZE) {
        chunks.push(scrollback.slice(i, i + CHUNK_SIZE));
      }
      if (chunks.length === 0) {
        send({ type: 'scrollback', session_id: sessionId, data: '', seq: 0, done: true });
      } else {
        chunks.forEach((chunk, idx) => {
          send({ type: 'scrollback', session_id: sessionId, data: chunk, seq: idx, done: idx === chunks.length - 1 });
        });
      }
    } catch { /* scrollback is best-effort */ }
  }

  connect();
}
