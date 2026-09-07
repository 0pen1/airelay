# Development

Dev setup, build commands, testing, and debugging for airelay.

## Prerequisites

- **Node.js 22.5+** — relay uses `node:sqlite` (DatabaseSync)
- **tmux** — agent daemon drives sessions via tmux control mode
- **AI agent CLI** — at least one of: Claude Code, Codex, Gemini CLI

Check Node version:

```bash
node --version  # must be >= 22.5
```

If you have multiple Node versions, use the full path:

```bash
/usr/local/Cellar/node@22/22.23.2_1/bin/node packages/relay/dist/index.js start
```

## Setup

```bash
# Install dependencies
npm install

# Build all packages
npm run build
```

Or build individually:

```bash
packages/shared/node_modules/.bin/tsc -p packages/shared/tsconfig.json
packages/relay/node_modules/.bin/tsc -p packages/relay/tsconfig.json
packages/agent/node_modules/.bin/tsc -p packages/agent/tsconfig.json
cd packages/web && npm run build
```

## First-time configuration

### 1. Initialize relay

```bash
cd packages/relay
node dist/index.js init
```

Creates SQLite database with `hosts`, `session_tokens`, `jtis` tables.

### 2. Set up agent

```bash
cd packages/agent
node dist/index.js setup
```

Prompts for:
- Relay URL (e.g. `http://localhost:3000`)
- Generates `host_id` (UUID) + `host_secret` (64 bytes)

Writes `~/.config/airelay/config.json`.

### 3. Register agent with relay

Copy the `host_id` and `host_secret` from agent setup output, then:

```bash
cd packages/relay
node dist/index.js register <host_id> <host_secret>
```

### 4. Configure agents.json

Edit `~/.config/airelay/agents.json`:

```json
{
  "agents": [
    { "id": "claude", "name": "Claude Code", "type": "pty", "command": "claude", "args": [], "icon": "🤖" },
    { "id": "codex", "name": "OpenAI Codex", "type": "pty", "command": "codex", "args": [], "icon": "⚡" }
  ]
}
```

Only include agents you have installed.

### 5. Generate pairing QR code

```bash
cd packages/agent
node dist/index.js gen-token
```

Outputs a QR code + URL. The URL contains:
- `url` — relay address
- `host_id` — this host's UUID
- `token` — JWT (5-min TTL, single-use)
- `e2e_secret` — E2E encryption key

Scan with phone or paste URL into browser.

## Running

### Terminal 1: Relay

```bash
cd packages/relay
node dist/index.js start
# → airelay relay listening on 127.0.0.1:3000
```

### Terminal 2: Agent daemon

```bash
cd packages/agent
node dist/index.js agent _run
# → connects to relay, starts managing tmux sessions
```

### Terminal 3: Web client (dev)

```bash
cd packages/web
npm run dev
# → http://localhost:5173
```

Or use the relay's built-in static serving:

```bash
# Build web client first
cd packages/web && npm run build

# Copy to relay's public dir
cp -r dist/* ../relay/public/

# Restart relay — now http://localhost:3000 serves the web client
```

## Testing E2E encryption

### 1. Verify relay sees only ciphertext

Add temporary audit logging to `packages/relay/src/server.ts`:

```typescript
// In agent→client forwarding:
if (parsed.type === 'output' || parsed.type === 'scrollback') {
  const hasE2e = !!parsed.e2e;
  const hasData = typeof parsed.data === 'string';
  console.log(`[E2E-AUDIT] ${parsed.type}: e2e=${hasE2e} data=${hasData}`);
}

// In client→agent forwarding:
if (parsed.type === 'input') {
  const hasE2e = !!parsed.e2e;
  const hasData = typeof parsed.data === 'string';
  console.log(`[E2E-AUDIT] input: e2e=${hasE2e} data=${hasData}`);
}
```

Rebuild, restart relay, connect with phone, send terminal input.

**Expected output:**
```
[E2E-AUDIT] input: e2e=true data=false
[E2E-AUDIT] output: e2e=true data=false
[E2E-AUDIT] scrollback: e2e=true data=false
```

`e2e=true data=false` proves the relay cannot read terminal content.

### 2. Verify agent handshake

Check agent stderr:

```bash
tail -f ~/.config/airelay/agent.log
# or wherever stderr is redirected
```

**Expected:**
```
[airelay-agent 2026-09-07T08:44:38.122Z] E2E handshake completed
```

One line per client connection.

## Common tasks

### Add a new agent type

1. Edit `~/.config/airelay/agents.json`:
   ```json
   {
     "agents": [
       {"id":"myagent","name":"My Agent","type":"pty","command":"myagent","args":[],"icon":"🆕"}
     ]
   }
   ```
2. Reload without restarting:
   ```bash
   node dist/index.js agent reload
   ```
3. New agent appears in the phone's agent selector (if installed).

### Debug a frozen session

```bash
# List all tmux sessions
tmux ls

# Attach manually to see what's happening
tmux attach -t airelay-<session-id>

# Check agent's view of the session
cat ~/.config/airelay/sessions.json
```

### Reset everything

```bash
# Kill all airelay tmux sessions
tmux ls | grep airelay- | cut -d: -f1 | xargs -I{} tmux kill-session -t {}

# Clear session persistence
rm ~/.config/airelay/sessions.json

# Clear phone state (in browser console):
# localStorage.clear()

# Restart relay + agent
```

### View relay database

```bash
sqlite3 packages/relay/airelay-relay.db

sqlite> .tables
hosts  jtis  session_tokens

sqlite> SELECT host_id FROM hosts;
sqlite> SELECT COUNT(*) FROM session_tokens;
```

## Debugging

### Agent won't connect to relay

1. Check relay is running: `curl http://localhost:3000/health`
2. Check `relayUrl` in `~/.config/airelay/config.json` matches relay address
3. Check `host_secret` matches what relay has registered
4. Check agent logs for HMAC errors

### Phone can't authenticate

1. Check token hasn't expired (JWT: 5 min; session_token: 7 days)
2. Re-scan QR code to get fresh JWT
3. Check browser console for `AUTH_FAILED` errors

### Terminal is blank after reload

Known issue fixed in commit `4764a60` — if you see this, update to latest main.

**Root cause:** relay restart leaves sessions locked (`SESSION_OCCUPIED`).

**Fix:** agent calls `unlockAll()` on reconnect.

### E2E handshake fails

1. Check `e2e_secret` in QR payload matches agent's derivation:
   ```bash
   node -e "
     const {createHmac} = require('crypto');
     const cfg = require('$HOME/.config/airelay/config.json');
     console.log(createHmac('sha256', cfg.hostSecret).update('airelay-e2e-auth').digest('hex'));
   "
   ```
2. Compare with `e2e_secret` field in QR payload — must match exactly.

## Code organization

See [CLAUDE.md](../CLAUDE.md#file-organization) for the full tree.

### Adding a WebSocket message type

1. **Define schema** in `packages/shared/src/protocol.ts`
2. **Agent handler** in `packages/agent/src/daemon.ts` (`handleMessage`)
3. **Web handler** in `packages/web/src/ws.ts` (`onmessage`) or feature module
4. **Relay** usually needs no changes (forwards blindly)

### Adding a new UI view

1. Create `packages/web/src/<view>.ts` with `mount<View>(app: HTMLElement): () => void`
2. Export cleanup function that unregisters WS handlers
3. Add route in `packages/web/src/main.ts` (`route()`)
4. Follow existing patterns in `sessions.ts` / `terminal.ts`

## Type checking

```bash
# All packages
npm run typecheck  # if defined

# Individually
packages/shared/node_modules/.bin/tsc -p packages/shared/tsconfig.json --noEmit
packages/relay/node_modules/.bin/tsc -p packages/relay/tsconfig.json --noEmit
packages/agent/node_modules/.bin/tsc -p packages/agent/tsconfig.json --noEmit
cd packages/web && npx tsc --noEmit
```

## Deployment

### Relay on VPS

```bash
# On the VPS
git clone https://github.com/0pen1/airelay.git
cd airelay
npm install
cd packages/relay && npm run build

# Initialize + start
node dist/index.js init
node dist/index.js start
```

Use nginx/caddy for TLS termination in front of the relay (WSS).

### Agent on dev machine

```bash
# Setup points at your relay URL
node dist/index.js setup
# → Relay URL: https://relay.example.com

# Register on the relay (SSH to VPS)
node dist/index.js register <host_id> <host_secret>

# Run agent as launchd/systemd service
node dist/index.js agent start
```

### Web client

The relay serves the built web client from `packages/relay/public/`. Build and copy:

```bash
cd packages/web && npm run build
cp -r dist/* ../relay/public/
```

## Gotchas

### Node version

`node:sqlite` requires Node 22.5+. If you see `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`, you're on an older Node.

### Port conflicts

Relay defaults to `127.0.0.1:3000`. If occupied:

```bash
lsof -ti :3000 | xargs kill
```

### Browser cache

After rebuilding the web client, hard-refresh (`Cmd+Shift+R`) — the HTML references hashed JS bundles, but a stale HTML can point at deleted bundles.

### tmux control mode

The agent attaches with `tmux -C` (control mode). Don't manually attach to the same session with `tmux attach` while the agent holds it — output will split between both.

### JWT reuse

Each JWT works once. Re-scanning an old QR after first use gets `AUTH_FAILED`. Generate a fresh token with `gen-token`.

## Testing checklist

Before pushing:

- [ ] `tsc --noEmit` passes for all packages
- [ ] Relay starts and serves `/health`
- [ ] Agent connects (check relay `/health` shows `agents:1`)
- [ ] Phone can scan QR and see sessions list
- [ ] Terminal input/output works
- [ ] Terminal reload restores scrollback
- [ ] E2E audit shows `e2e=true data=false` (if audit logging enabled)
- [ ] Session lock releases on disconnect
