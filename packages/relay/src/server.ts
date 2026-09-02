import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyAgentAuth, verifyClientJwt, verifySessionTokenAuth } from './auth.js';
import {
  getHost, addJti, hasJti, createSessionToken, getSessionToken,
} from './db.js';

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

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

export function createRelayServer(port: number): void {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ ok: true, agents: agents.size, clients: clients.size });
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

      agents.set(hostId, { ws, hostId });

      ws.on('message', (data) => {
        // Forward to all clients bound to this host
        const msg = data.toString();
        for (const client of clients.values()) {
          if (client.hostId === hostId) {
            // Track session_id for cleanup on disconnect
            try {
              const parsed = JSON.parse(msg);
              if (parsed.type === 'session_created' || parsed.type === 'attached') {
                client.sessionId = parsed.session_id;
              }
            } catch { /* ignore parse errors */ }
            sendJson(client.ws, JSON.parse(msg));
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

      ws.on('message', async (data) => {
        if (!authed) {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            ws.close(4001, 'Bad auth message');
            return;
          }
          if (msg['type'] !== 'auth' || typeof msg['token'] !== 'string') {
            ws.close(4001, 'Expected auth message');
            return;
          }

          const token = msg['token'] as string;

          // Try session_token first (reconnect path), then JWT (first connection)
          const stRow = verifySessionTokenAuth(token, getSessionToken);
          if (stRow) {
            hostId = stRow.hostId;
          } else {
            const jwtResult = await verifyClientJwt(
              token, getHost, hasJti, addJti, createSessionToken,
            );
            if (!jwtResult) {
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
          connId = randomUUID();
          clients.set(connId, { ws, hostId, connId });
          return;
        }

        // Authenticated: forward messages to the agent
        const agentConn = agents.get(hostId);
        if (!agentConn) {
          sendJson(ws, { type: 'error', code: 'AGENT_OFFLINE', message: 'Host agent disconnected' });
          return;
        }
        if (agentConn.ws.readyState === WebSocket.OPEN) {
          agentConn.ws.send(data);
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
