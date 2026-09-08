import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHmac } from 'node:crypto';
import { signHmac, validateSessionId, validateAgentId, encodeBinaryFrame, BinaryOpcode } from '@airelay/shared';
import type {
  ClientToAgentMsg, AgentDriverConfig, PtyDriverConfig,
  AgentTypeInfo, SessionInfo, ErrorCode,
} from '@airelay/shared';
import { SessionManager, type SessionEntry } from './sessions.js';
import { PtyDriver } from './drivers/pty-driver.js';
import type { Disposable, AgentDriver } from './drivers/types.js';
import { E2eSession, type E2ePayload } from './e2e.js';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
// Config directory: AIRELAY_CONFIG_DIR overrides the default location
// (used by tests/CI to run against an isolated config).
const CONFIG_DIR = process.env.AIRELAY_CONFIG_DIR ?? join(homedir(), '.config', 'airelay');
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
    // execFile (no shell) — command comes from agents.json (local config), but
    // avoid shell interpolation regardless.
    await execFile('which', [command]);
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

  // ── E2E encryption setup ───────────────────────────────────────────────────
  // Derive e2e_secret from host_secret (same derivation as gen-token).
  const e2eSecret = createHmac('sha256', config.hostSecret)
    .update('airelay-e2e-auth')
    .digest('hex');
  // One E2E session per connected client (currently single-client architecture,
  // but keyed for future multi-client). Reset on each e2e_hello.
  let e2e: E2eSession | null = null;

  // Active output/exit subscriptions per session, so we can dispose them on
  // detach/disconnect. Without this, a re-attach (e.g. after daemon restart,
  // or clicking a session from the list) would find no live callback to
  // forward tmux output to the client — the terminal would freeze.
  const subs = new Map<string, Disposable[]>();

  // ── Binary frame slots ──────────────────────────────────────────────────────
  // Terminal I/O hot path uses binary frames [opcode][slot][payload]. Slots are
  // assigned on attach and announced via the `slot` field on `attached`. The
  // client falls back to JSON when `attached` carries no slot (legacy agent).
  const MAX_SLOT = 255;
  const sessionSlots = new Map<string, number>();  // sessionId → slot
  const slotSessions = new Map<number, string>();  // slot → sessionId
  let nextSlot = 0;

  function allocateSlot(sessionId: string): number {
    // Reuse a slot if this session already has one (re-attach).
    const existing = sessionSlots.get(sessionId);
    if (existing !== undefined) return existing;
    // Reclaim slots from sessions without live subscriptions when full.
    if (slotSessions.size > MAX_SLOT) {
      for (const [sid, slot] of sessionSlots) {
        if (!subs.has(sid)) {
          sessionSlots.delete(sid);
          slotSessions.delete(slot);
        }
      }
    }
    // Linear probe for a free slot (single client → almost always first try).
    let slot = nextSlot;
    for (let i = 0; i <= MAX_SLOT; i++) {
      if (!slotSessions.has(slot)) break;
      slot = (slot + 1) % (MAX_SLOT + 1);
    }
    nextSlot = (slot + 1) % (MAX_SLOT + 1);
    sessionSlots.set(sessionId, slot);
    slotSessions.set(slot, sessionId);
    return slot;
  }

  function freeSlot(sessionId: string): void {
    const slot = sessionSlots.get(sessionId);
    if (slot !== undefined) {
      slotSessions.delete(slot);
      sessionSlots.delete(sessionId);
    }
  }

  /** Send a binary output frame for a session (E2E-encrypts payload if active). */
  function sendBinaryOutput(sessionId: string, data: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const slot = sessionSlots.get(sessionId);
    if (slot === undefined) return; // no slot — caller falls back to JSON
    const plaintext = Buffer.from(data, 'utf8');
    const payload = e2e?.isReady ? e2e.encryptBytes(plaintext) : plaintext;
    ws.send(encodeBinaryFrame(BinaryOpcode.OUTPUT, slot, payload), { binary: true });
  }

  // ── Session activity tracking ──────────────────────────────────────────────
  // Watches every session's output independent of attach state, so the phone's
  // session list can show which agents are actively working (running) vs
  // waiting for input (idle). A session is "running" if it produced output
  // within IDLE_THRESHOLD_MS; otherwise "idle". Status transitions broadcast
  // as session_status messages (throttled to avoid flooding on chatty output).
  const IDLE_THRESHOLD_MS = 3000;
  const STATUS_MIN_INTERVAL_MS = 1000;
  const activity = new Map<string, { lastOutput: number; running: boolean; lastSent: number }>();

  function broadcastStatus(sessionId: string, force = false): void {
    const a = activity.get(sessionId);
    if (!a) return;
    const running = Date.now() - a.lastOutput < IDLE_THRESHOLD_MS;
    const now = Date.now();
    if (running === a.running && !force) return; // no state change
    if (!force && now - a.lastSent < STATUS_MIN_INTERVAL_MS) return; // throttle
    // waiting = running→idle transition: the agent stopped producing output
    // and is probably blocked on user input. Drives the phone's
    // "waiting for you" notification.
    const waiting = a.running && !running;
    a.running = running;
    a.lastSent = now;
    send({
      type: 'session_status',
      session_id: sessionId,
      running,
      last_activity: Math.floor(a.lastOutput / 1000),
      ...(waiting ? { waiting: true } : {}),
    });
  }

  /** Register an activity watcher for a session (idempotent per session). */
  function watchActivity(session: SessionEntry & { driver: AgentDriver }): void {
    if (activity.has(session.sessionId)) return;
    activity.set(session.sessionId, {
      lastOutput: 0, running: false, lastSent: 0,
    });
    session.driver.onOutput(session.sessionId, () => {
      const a = activity.get(session.sessionId);
      if (!a) return;
      a.lastOutput = Date.now();
      broadcastStatus(session.sessionId);
    });
  }

  /** Push status for all sessions (used on list/attach so the phone gets fresh state). */
  function pushAllStatus(): void {
    for (const sessionId of activity.keys()) broadcastStatus(sessionId, true);
  }

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

  // Graceful shutdown on SIGTERM (systemd stop) / SIGINT: close the relay
  // socket so the relay runs its client_disconnected cleanup (unlocks,
  // disposes subscriptions), persist nothing extra — tmux sessions survive
  // the daemon by design and restore() re-attaches on next start.
  let shuttingDown = false;
  const stop = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received — closing relay connection`);
    try { ws?.close(1001, 'Agent stopping'); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // Restore surviving sessions from before restart, then set up activity watchers
  sessionManager.restore().then(() => {
    for (const s of sessionManager.list()) {
      const full = sessionManager.get(s.sessionId);
      if (full) watchActivity(full);
    }
  }).catch(() => {});

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

      // On (re)connect, unlock all sessions. If the relay restarted, the old
      // client connections are gone and no client_disconnected was received,
      // leaving sessions locked forever. Safe: single-client architecture.
      sessionManager.unlockAll();
      // Dispose all output/exit subscriptions — old callbacks reference the
      // closed WebSocket and would never deliver output. New callbacks are
      // set up when the client re-attaches.
      for (const sid of subs.keys()) disposeSubs(sid);
      // Slots are per-connection: the new client will get fresh ones on attach.
      for (const sid of sessionSlots.keys()) freeSlot(sid);
      e2e = null; // old E2E session is dead

      // Heartbeat
      const ping = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.ping();
        else clearInterval(ping);
      }, 30_000);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        handleBinaryFrame(new Uint8Array(data as ArrayBuffer));
        return;
      }
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

  /** Handle an inbound binary frame from the client: [opcode][slot][payload]. */
  function handleBinaryFrame(frame: Uint8Array): void {
    if (frame.length < 2) return;
    const opcode = frame[0];
    const slot = frame[1];
    const payload = frame.subarray(2);
    const sessionId = slotSessions.get(slot);
    if (!sessionId) return; // unknown slot — drop
    if (opcode === BinaryOpcode.INPUT) {
      // Decrypt if E2E is active, then feed the terminal as UTF-8 text.
      let bytes: Uint8Array;
      try {
        bytes = e2e?.isReady ? e2e.decryptBytes(payload) : payload;
      } catch {
        return; // tampered or wrong key — drop
      }
      const session = sessionManager.get(sessionId);
      if (!session) return;
      session.driver.sendInput(sessionId, Buffer.from(bytes).toString('utf8')).catch(() => {});
    }
    // Unknown opcodes are ignored (forward compatibility).
  }

  async function handleMessage(msg: Record<string, unknown>, _ws: WebSocket): Promise<void> {
    const type = msg['type'] as string;

    // ── Latency probe echo (no state, no logging) ─────────────────────────
    if (type === 'latency_probe') {
      send({ type: 'latency_pong', t: msg['t'] });
      return;
    }

    // ── E2E handshake ─────────────────────────────────────────────────────
    if (type === 'e2e_hello') {
      const session = new E2eSession(e2eSecret);
      const ack = session.handleHello(msg as { pub: string; sig: string });
      if (ack) {
        // Replace the session-level E2E state. All subsequent output/scrollback
        // for this client will be encrypted; input with an `e2e` field will be
        // decrypted. A fresh E2eSession per hello = new ECDH keys = forward
        // secrecy per connection.
        e2e = session;
        send(ack);
        log('E2E handshake completed');
      } else {
        log('E2E handshake failed — sig verification error');
      }
      return;
    }

    if (type === 'client_disconnected') {
      const sid = msg['session_id'] as string | undefined;
      if (sid) {
        sessionManager.unlock(sid);
        disposeSubs(sid);
        freeSlot(sid);
      }
      e2e = null; // E2E session dies with the client
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
      // Push fresh status for all sessions so the phone shows accurate
      // running/idle state immediately, not just after the next state change.
      pushAllStatus();
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
        // Register activity watcher before sending session_created, so output
        // from the agent startup is tracked even before the client attaches.
        const full = sessionManager.get(sessionId);
        if (full) watchActivity(full);
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
      // If the message has an `e2e` field, decrypt it to recover the plaintext
      // data. Fall back to the plain `data` field for backward compatibility
      // (clients without E2E / legacy QR tokens).
      let data: string | undefined;
      if (msg['e2e'] && e2e?.isReady) {
        try {
          data = e2e.decrypt(msg['e2e'] as E2ePayload);
        } catch {
          return; // decryption failed — drop (tampered or wrong key)
        }
      } else {
        data = msg['data'] as string | undefined;
      }
      if (!sessionId || !validateSessionId(sessionId) || data === undefined) return;
      const session = sessionManager.get(sessionId);
      if (!session) return;
      await session.driver.sendInput(sessionId, data).catch(() => {});
      return;
    }

    if (type === 'resize') {
      const sessionId = msg['session_id'] as string | undefined;
      const cols = msg['cols'];
      const rows = msg['rows'];
      // cols/rows flow into a tmux shell command (`-x ${cols} -y ${rows}`), so
      // they MUST be integers — a string like "100; rm -rf /" would inject a
      // second command. TypeScript's `as number` is compile-time only; verify
      // at runtime. Bound the range to sane terminal sizes.
      if (!sessionId || !validateSessionId(sessionId)) return;
      if (typeof cols !== 'number' || typeof rows !== 'number') return;
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
      if (cols < 1 || cols > 5000 || rows < 1 || rows > 5000) return;
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
      freeSlot(sessionId);
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
    // Allocate a binary-frame slot and announce it. The client uses binary
    // frames only when `slot` is present; otherwise it stays on JSON.
    const slot = allocateSlot(sessionId);
    send({ type: 'attached', session_id: sessionId, slot });

    // (Re)wire output/exit forwarding for this session. disposeSubs first so
    // a re-attach doesn't stack duplicate callbacks. This is what makes a
    // session clicked from the list (or restored after a daemon restart)
    // actually stream live output — new_session never registered callbacks
    // for restored sessions, and the original ones died with the old process.
    disposeSubs(sessionId);
    const list: Disposable[] = [];
    list.push(
      session.driver.onOutput(sessionId, (data) => {
        // Hot path: binary frame. Falls back to JSON only if the slot was
        // lost (defensive; allocateSlot in this function guarantees one).
        if (sessionSlots.has(sessionId)) {
          sendBinaryOutput(sessionId, data);
        } else if (e2e?.isReady) {
          const payload = e2e.encrypt(data);
          send({ type: 'output', session_id: sessionId, e2e: payload });
        } else {
          send({ type: 'output', session_id: sessionId, data });
        }
      }),
    );
    list.push(
      session.driver.onExit(sessionId, (code) => {
        send({ type: 'session_exited', session_id: sessionId, code });
        disposeSubs(sessionId);
        freeSlot(sessionId);
        activity.delete(sessionId);
        sessionManager.remove(sessionId).catch(() => {});
      }),
    );
    subs.set(sessionId, list);

    // Send scrollback in 64 KB chunks (encrypted if E2E is active)
    try {
      const scrollback = await session.driver.getScrollback(sessionId);
      const chunks: string[] = [];      for (let i = 0; i < scrollback.length; i += CHUNK_SIZE) {
        chunks.push(scrollback.slice(i, i + CHUNK_SIZE));
      }
      if (chunks.length === 0) {
        if (e2e?.isReady) {
          send({ type: 'scrollback', session_id: sessionId, e2e: e2e.encrypt(''), seq: 0, done: true });
        } else {
          send({ type: 'scrollback', session_id: sessionId, data: '', seq: 0, done: true });
        }
      } else {
        chunks.forEach((chunk, idx) => {
          if (e2e?.isReady) {
            send({ type: 'scrollback', session_id: sessionId, e2e: e2e.encrypt(chunk), seq: idx, done: idx === chunks.length - 1 });
          } else {
            send({ type: 'scrollback', session_id: sessionId, data: chunk, seq: idx, done: idx === chunks.length - 1 });
          }
        });
      }
    } catch { /* scrollback is best-effort */ }
  }

  connect();
}
