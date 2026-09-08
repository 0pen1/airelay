import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { verifyAgentAuth, verifyClientJwt, verifySessionTokenAuth } from './auth.js';
import {
  getHost, addJti, hasJti, createSessionToken, getSessionToken,
  listSessionTokens, revokeSessionToken, rotateSessionToken,
  cleanExpiredJtis, upsertPushSubscription, getPushSubscriptions,
  deletePushSubscription,
} from './db.js';
import { initPush, getVapidPublicKey, sendPush } from './push.js';

// ESM: derive the directory of this module (was __dirname under CJS)
const __dirname = join(fileURLToPath(import.meta.url), '..');

interface AgentConn {
  ws: WebSocket;
  hostId: string;
}

interface ClientConn {
  ws: WebSocket;
  hostId: string;
  sessionId?: string;
  connId: string;
}

// Active connections
const agents = new Map<string, AgentConn>();           // hostId → conn
const clients = new Map<string, ClientConn>();         // connId → conn

// ── Counters (process-lifetime, exposed via /metrics) ─────────────────────────
const metrics = {
  startedAt: Math.floor(Date.now() / 1000),
  agentConnections: 0,       // agent WS connects (including reconnects)
  clientConnections: 0,      // successful client auths
  authFailures: 0,           // rejected auths (bad JWT/token)
  messagesAgentToClient: 0,  // forwarded frames
  messagesClientToAgent: 0,
  bytesAgentToClient: 0,
  bytesClientToAgent: 0,
  binaryFrames: 0,           // binary (terminal I/O) frames seen
  pushesSent: 0,             // successful web-push deliveries
  pushFailures: 0,
};

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/** Metadata-only audit line: direction, message type (if parseable), size.
 *  Never logs payload contents — preserves the zero-knowledge guarantee while
 *  giving operators a trace of what flowed through the relay. */
function audit(dir: 'agent->client' | 'client->agent', data: Buffer, isBinary: boolean, hostId: string): void {
  let type = isBinary ? 'binary' : '?';
  if (!isBinary) {
    try {
      const parsed = JSON.parse(data.toString()) as { type?: string };
      type = parsed.type ?? '?';
    } catch { /* keep '?' */ }
  }
  console.log(`[AUDIT ${new Date().toISOString()}] ${dir} host=${hostId} type=${type} bytes=${data.length}`);
}

export function createRelayServer(port: number): void {
  const app = express();

  // Periodic cleanup of expired JTIs and token-grace aliases (1/hour).
  setInterval(cleanExpiredJtis, 3600_000).unref();

  // ── Web Push (VAPID) ─────────────────────────────────────────────────────────
  // Subscriptions are authorized with the client's session token; pushes carry
  // metadata only ("agent waiting"), never terminal content.

  app.get('/api/push/key', (_req, res) => {
    res.json({ publicKey: getVapidPublicKey() });
  });

  app.post('/api/push/subscribe', express.json(), (req, res) => {
    const token = String(req.headers['authorization']?.replace(/^Bearer\s+/i, '') ?? '');
    const row = getSessionToken(token);
    if (!row) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const sub = req.body?.['subscription'] as
      { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
    if (
      !sub?.endpoint || typeof sub.endpoint !== 'string' ||
      !sub.keys?.p256dh || !sub.keys?.auth
    ) {
      res.status(400).json({ error: 'invalid subscription' });
      return;
    }
    initPush();
    upsertPushSubscription(sub.endpoint, row.host_id, sub.keys.p256dh, sub.keys.auth, row.device_name);
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', express.json(), (req, res) => {
    const token = String(req.headers['authorization']?.replace(/^Bearer\s+/i, '') ?? '');
    if (!getSessionToken(token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const endpoint = String(req.body?.['endpoint'] ?? '');
    if (endpoint) deletePushSubscription(endpoint);
    res.json({ ok: true });
  });

  /** Fire "agent waiting" pushes to all of a host's subscriptions. Failures
   *  with 404/410 mean the subscription is dead — drop it. */
  async function pushWaiting(hostId: string): Promise<void> {
    const subs = getPushSubscriptions(hostId);
    for (const sub of subs) {
      try {
        await sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          { title: 'airelay', body: 'Your agent is waiting for input' },
        );
        metrics.pushesSent++;
      } catch (err) {
        metrics.pushFailures++;
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          deletePushSubscription(sub.endpoint);
        }
        // Other errors (network blips): keep the subscription, retry next time.
      }
    }
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, agents: agents.size, clients: clients.size });
  });

  // Process-lifetime counters + current connection gauge. Host-id metadata
  // only — no message contents, keeping the zero-knowledge posture.
  app.get('/metrics', (_req, res) => {
    res.json({
      uptime_seconds: Math.floor(Date.now() / 1000) - metrics.startedAt,
      connections: {
        agents_online: agents.size,
        clients_online: clients.size,
        agent_connects_total: metrics.agentConnections,
        client_auths_total: metrics.clientConnections,
        auth_failures_total: metrics.authFailures,
      },
      forwarding: {
        messages_agent_to_client: metrics.messagesAgentToClient,
        messages_client_to_agent: metrics.messagesClientToAgent,
        bytes_agent_to_client: metrics.bytesAgentToClient,
        bytes_client_to_agent: metrics.bytesClientToAgent,
        binary_frames: metrics.binaryFrames,
      },
      push: {
        sent: metrics.pushesSent,
        failures: metrics.pushFailures,
      },
    });
  });

  // ── Device management API (HMAC-authenticated, host manages own devices) ────
  // The agent CLI calls these with the same Authorization header it uses for
  // the WS connection, so the relay never needs an extra credential. Responses
  // never include token values — only short prefixes for identification.

  app.get('/api/devices', (req, res) => {
    const result = verifyAgentAuth(req.headers['authorization'] as string | undefined, getHost);
    if (!result) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const devices = listSessionTokens(result.hostId).map((t) => ({
      id: t.token.slice(0, 8),
      device_name: t.device_name || '(unnamed)',
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      expires_at: t.expires_at,
      expired: t.expires_at < now,
      status: t.revoked ? 'revoked' : 'active',
    }));
    res.json({ devices });
  });

  app.post('/api/devices/revoke', express.json(), (req, res) => {
    const result = verifyAgentAuth(req.headers['authorization'] as string | undefined, getHost);
    if (!result) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const id = String(req.body?.['id'] ?? '');
    if (!/^[0-9a-f]{8}$/.test(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    // id is the 8-char token prefix — revoke every live token matching it.
    let revoked = 0;
    for (const t of listSessionTokens(result.hostId)) {
      if (t.token.startsWith(id)) {
        revokeSessionToken(t.token);
        revoked++;
      }
    }
    res.json({ revoked });
  });

  // Serve web frontend (built by packages/web)
  const publicDir = join(__dirname, 'public');
  app.use(express.static(publicDir));
  app.get('*', (_req, res) => {
    res.sendFile(join(publicDir, 'index.html'));
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '', `http://localhost`);
    const path = url.pathname;
    const authHeader = req.headers['authorization'] as string | undefined;

    // ── Agent connection ─────────────────────────────────────────────────────
    if (path === '/ws/agent') {
      const result = verifyAgentAuth(authHeader, getHost);
      if (!result) {
        ws.close(4001, 'Unauthorized');
        return;
      }
      const { hostId } = result;

      // Replace any stale connection for this host
      const existing = agents.get(hostId);
      if (existing) existing.ws.close(4000, 'Replaced by new connection');

      metrics.agentConnections++;
      agents.set(hostId, { ws, hostId });

      ws.on('message', (data, isBinary) => {
        // Forward to all clients bound to this host. The relay is
        // zero-knowledge: it never needs to interpret payload contents.
        metrics.messagesAgentToClient++;
        metrics.bytesAgentToClient += (data as Buffer).length;
        if (isBinary) metrics.binaryFrames++;
        audit('agent->client', data as Buffer, isBinary, hostId);
        for (const client of clients.values()) {
          if (client.hostId !== hostId) continue;
          if (isBinary) {
            // Binary frames (terminal I/O) pass through untouched —
            // decoding/encoding here would corrupt them.
            if (client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(data, { binary: true });
            }
          } else {
            // Text frames are JSON. Track session_id for cleanup on
            // disconnect, then forward the string as-is (no parse→
            // stringify roundtrip). Parse errors are tolerated: the
            // message still gets forwarded.
            const msg = data.toString();
            try {
              const parsed = JSON.parse(msg) as { type?: string; session_id?: string; waiting?: boolean };
              if (parsed.type === 'session_created' || parsed.type === 'attached') {
                client.sessionId = parsed.session_id;
              }
              // Fire-and-forget: agent went idle → notify subscribed devices.
              // Not awaited: must never delay the forwarded frame.
              if (parsed.type === 'session_status' && parsed.waiting === true) {
                void pushWaiting(hostId);
              }
            } catch { /* not JSON — forward anyway */ }
            if (client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(msg);
            }
          }
        }
      });

      ws.on('close', () => {
        agents.delete(hostId);
        // Notify all clients bound to this host
        for (const client of clients.values()) {
          if (client.hostId === hostId) {
            sendJson(client.ws, { type: 'agent_disconnected' });
          }
        }
      });

      return;
    }

    // ── Client connection ────────────────────────────────────────────────────
    if (path === '/ws/client') {
      // Browsers cannot set custom WebSocket headers, so the client authenticates
      // with a first message: { type: 'auth', token }. Everything before that is
      // buffered and ignored until auth succeeds.
      let authed = false;
      let hostId = '';
      let connId = '';

      const authTimeout = setTimeout(() => {
        if (!authed) ws.close(4001, 'Auth timeout');
      }, 10_000);

      ws.on('message', async (data, isBinary) => {
        if (!authed) {
          if (isBinary) {
            // Auth must be a JSON text frame
            sendJson(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Bad auth message' });
            ws.close(4001, 'Bad auth message');
            return;
          }
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            sendJson(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Bad auth message' });
            ws.close(4001, 'Bad auth message');
            return;
          }
          if (msg['type'] !== 'auth' || typeof msg['token'] !== 'string') {
            sendJson(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Expected auth message' });
            ws.close(4001, 'Expected auth message');
            return;
          }

          const token = msg['token'] as string;
          // Optional device name (client sends it on first auth; used for the
          // device management list). Bounded and sanitized below.
          const rawDevice = typeof msg['device_name'] === 'string' ? msg['device_name'] : '';
          const deviceName = rawDevice.replace(/[^\w\s.-]/g, '').slice(0, 40);

          // Try session_token first (reconnect path), then JWT (first connection)
          const stRow = verifySessionTokenAuth(token, getSessionToken);
          if (stRow) {
            hostId = stRow.hostId;
            // Rotate on every successful reconnect: the presented token is
            // retired after a short grace window and a fresh one is issued.
            // A stolen token therefore works only until the next connect.
            const fresh = rotateSessionToken(token);
            if (fresh) {
              sendJson(ws, { type: 'session_token_issued', session_token: fresh });
            }
          } else {
            const jwtResult = await verifyClientJwt(
              token, getHost, hasJti, addJti, createSessionToken, deviceName,
            );
            if (!jwtResult) {
              metrics.authFailures++;
              // Send an explicit AUTH_FAILED before the 4001 close so the client
              // can distinguish "token expired/invalid — re-scan" from a
              // transient disconnect and stop its reconnect loop. (The client
              // keys off the 4001 close code; this message is for clarity/UI.)
              sendJson(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Token expired or invalid' });
              ws.close(4001, 'Unauthorized');
              return;
            }
            hostId = jwtResult.hostId;
            sendJson(ws, { type: 'session_token_issued', session_token: jwtResult.sessionToken });
          }

          const agent = agents.get(hostId);
          if (!agent) {
            sendJson(ws, { type: 'error', code: 'AGENT_OFFLINE', message: 'Host agent is not connected' });
            ws.close(4002, 'Agent not connected');
            return;
          }

          authed = true;
          clearTimeout(authTimeout);
          metrics.clientConnections++;
          connId = randomUUID();
          clients.set(connId, { ws, hostId, connId });
          // Tell the client the connection is now authenticated and ready.
          // Without this, the client cannot distinguish "socket open" from
          // "authenticated" — it would fire list_sessions on socket open,
          // before auth completes, and we'd close the socket (4001) for the
          // unexpected non-auth message. See server.ts message handler above.
          sendJson(ws, { type: 'authed' });
          return;
        }

        // Authenticated: forward messages to the agent. Binary frames
        // (terminal I/O) pass through as binary; text frames are re-sent as
        // text (Buffer would go out as a binary frame and break the agent's
        // JSON path / isBinary discrimination).
        metrics.messagesClientToAgent++;
        metrics.bytesClientToAgent += (data as Buffer).length;
        audit('client->agent', data as Buffer, isBinary, hostId);
        const agentConn = agents.get(hostId);
        if (!agentConn) {
          sendJson(ws, { type: 'error', code: 'AGENT_OFFLINE', message: 'Host agent disconnected' });
          return;
        }
        if (agentConn.ws.readyState === WebSocket.OPEN) {
          if (isBinary) {
            agentConn.ws.send(data, { binary: true });
          } else {
            agentConn.ws.send(data.toString(), { binary: false });
          }
        }
      });
      ws.on('close', () => {
        clearTimeout(authTimeout);
        const client = clients.get(connId);
        if (client?.sessionId) {
          const agentConn = agents.get(hostId);
          if (agentConn) {
            sendJson(agentConn.ws, {
              type: 'client_disconnected',
              session_id: client.sessionId,
            });
          }
        }
        clients.delete(connId);
      });

      return;
    }

    ws.close(4004, 'Unknown path');
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`airelay relay listening on 127.0.0.1:${port}`);
  });
}
