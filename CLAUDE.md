# CLAUDE.md

airelay is a mobile-first remote access system for AI coding agents. Your dev environment, in your pocket. End-to-end encrypted so the relay cannot read your terminal sessions.

**Supported agents:** Claude Code, Codex, Gemini CLI, and any CLI-based AI agent.

## Repository map

This is an npm workspace monorepo:

- `packages/agent` — Agent daemon: session management, tmux driver, E2E encryption
- `packages/web` — Mobile + web client (Vite + React)
- `packages/relay` — Zero-knowledge relay server for remote access
- `packages/shared` — Shared types, protocol schemas, crypto utilities

## Docs

`docs/` is the source of truth for system-level knowledge. Check here before starting non-trivial work.

| Doc                                           | What's in it                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)   | System design, E2E encryption, WebSocket protocol, agent lifecycle              |
| [docs/glossary.md](docs/glossary.md)           | Authoritative terminology — host/agent/session/relay                            |
| [docs/protocol.md](docs/protocol.md)           | WebSocket message schemas, binary frames, authentication flow                   |
| [docs/security.md](docs/security.md)           | Threat model, E2E encryption (ECDH + AES-GCM), relay zero-knowledge             |
| [docs/development.md](docs/development.md)     | Dev setup, build commands, testing, debugging                                   |
| [docs/deployment.md](docs/deployment.md)       | VPS deployment: systemd, TLS reverse proxy, firewall, backups, upgrades         |

## Quick start

```bash
# Build all packages
npm run build

# Start relay (terminal 1)
cd packages/relay
npm start

# Start agent daemon (terminal 2)
cd packages/agent
npm start

# Generate QR code for pairing
npm run gen-token

# Start web dev server (terminal 3)
cd packages/web
npm run dev
```

See [docs/development.md](docs/development.md) for full setup.

## Critical rules

- **NEVER restart an agent daemon without permission** — it manages all running tmux sessions.
- **NEVER add plaintext logging of terminal I/O** — all terminal data must stay encrypted in logs.
- **NEVER modify relay forwarding logic** — it must remain zero-knowledge (cannot decrypt).
- **Always run typecheck after changes:** `npm run typecheck`
- **Always run lint after changes:** `npm run lint`

## Architecture overview

```
┌─────────────┐
│ Phone (Web) │
└──────┬──────┘
       │ WSS + E2E encryption
       │
┌──────▼──────┐
│    Relay    │ ← Zero-knowledge router
│  (Node.js)  │    (only sees ciphertext)
└──────┬──────┘
       │ WSS + E2E encryption
       │
┌──────▼──────┐
│    Agent    │
│   Daemon    │
└──────┬──────┘
       │
   ┌───┴────┬────────┬─────────┐
   │        │        │         │
┌──▼───┐ ┌─▼────┐ ┌─▼─────┐ ┌─▼──────┐
│Claude│ │Codex │ │Gemini │ │Custom  │
│Code  │ │      │ │       │ │Agent   │
└──────┘ └──────┘ └───────┘ └────────┘
```

## Key concepts

### Host
A machine running the agent daemon. Each host has:
- `host_id` (UUID)
- `host_secret` (64-byte HMAC key for agent↔relay auth)
- `e2e_secret` (derived from host_secret for client↔agent encryption)

### Agent
A configured AI agent type (Claude Code, Codex, etc.) defined in `agents.json`.

### Session
A live tmux session running one agent. Each session has:
- `session_id` (UUID)
- `agent_id` (which agent type: claude, codex, etc.)
- `locked_by` (single-client lock)

### Relay
Optional encrypted bridge when the agent is behind a firewall. The relay:
- Routes encrypted WebSocket frames
- Cannot decrypt terminal I/O (end-to-end encryption)
- Handles client↔agent connection management

## Authentication flow

1. **Agent setup:** `airelay setup` generates `(host_id, host_secret)` → stored in `~/.config/airelay/config.json`
2. **Relay registration:** `airelay-relay register <host_id> <host_secret>` → relay stores in SQLite
3. **Token generation:** `airelay gen-token` creates JWT (5min TTL) + derives `e2e_secret` → QR code
4. **Phone scan:** QR payload → `{url, host_id, token, e2e_secret}`
5. **First connect:** JWT → relay validates → issues opaque `session_token` (7 days)
6. **Reconnect:** `session_token` → relay validates → connected

## E2E encryption

After authentication, client and agent perform ECDH handshake:

1. Client → Agent: `{type:'e2e_hello', pub:<P-256 pubkey>, sig:HMAC(e2e_secret, pub)}`
2. Agent verifies sig → derives shared secret → Agent → Client: `{type:'e2e_ack', pub, sig}`
3. Client verifies sig → derives same shared secret
4. Both derive `AES-256-GCM` key via HKDF
5. All `input.data`/`output.data`/`scrollback.data` → encrypted to `e2e` field

The relay only sees `{type:'output', session_id, e2e:{v,iv,ct}}` — cannot decrypt.

## WebSocket protocol

All communication uses WebSocket with JSON text frames.

**Agent → Relay:**
```javascript
Authorization: HMAC host_id=<uuid>, ts=<timestamp>, sig=<hmac>
```

**Client → Relay:**
```json
{"type":"auth","token":"<jwt or session_token>"}
```

**After auth:**
```json
// Client requests
{"type":"list_sessions"}
{"type":"new_session","agent_id":"claude"}
{"type":"attach","session_id":"<uuid>"}
{"type":"input","session_id":"<uuid>","e2e":{"v":1,"iv":"...","ct":"..."}}
{"type":"resize","session_id":"<uuid>","cols":80,"rows":24}
{"type":"detach","session_id":"<uuid>"}

// Agent responses
{"type":"sessions_list","sessions":[...]}
{"type":"session_created","session_id":"<uuid>","agent_id":"claude"}
{"type":"attached","session_id":"<uuid>"}
{"type":"output","session_id":"<uuid>","e2e":{"v":1,"iv":"...","ct":"..."}}
{"type":"scrollback","session_id":"<uuid>","e2e":{...},"seq":0,"done":false}
{"type":"session_exited","session_id":"<uuid>","code":0}
```

See [docs/protocol.md](docs/protocol.md) for full schemas.

## Data persistence

```
~/.config/airelay/
├── config.json          # host_id, host_secret, relay_url
├── agents.json          # agent type definitions
├── sessions.json        # persisted session metadata
└── airelay.log          # daemon logs

Relay (SQLite):
├── hosts                # host_id → host_secret
├── session_tokens       # token → host_id (7-day TTL)
└── jtis                 # JWT replay prevention
```

## Development workflow

1. Make changes
2. Run `npm run build` (or `tsc -p packages/<pkg>/tsconfig.json`)
3. Run `npm run typecheck` — must pass
4. Run `npm run lint` — must pass
5. Test manually (agent daemon + relay + web client)
6. Commit with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Testing E2E encryption

```bash
# Terminal 1: Start relay with audit logging
cd packages/relay
npm run build
node dist/index.js start

# Terminal 2: Start agent with E2E support
cd packages/agent
npm run build
node dist/index.js agent _run

# Terminal 3: Generate QR with e2e_secret
cd packages/agent
npm run gen-token

# Scan QR → connect → send input
# Check relay logs: should see `e2e=true data=false`
```

## Common tasks

### Add a new agent type

1. Edit `~/.config/airelay/agents.json`:
   ```json
   {
     "agents": [
       {"id":"new-agent","name":"New Agent","type":"pty","command":"new-agent","args":[],"icon":"🆕"}
     ]
   }
   ```
2. Reload: `airelay agent reload` (sends SIGHUP)
3. New agent appears in sessions list

### Debug session lifecycle

```bash
# List all sessions
tmux ls

# Attach to a session manually
tmux attach -t airelay-<session-id>

# Check agent daemon state
cat ~/.config/airelay/sessions.json
```

### Add a new WebSocket message type

1. Add schema to `packages/shared/src/protocol.ts`
2. Update agent handler in `packages/agent/src/daemon.ts`
3. Update web handler in `packages/web/src/ws.ts`
4. Update relay if it needs to parse (usually not — relay forwards blindly)

## Security checklist

- [x] No plaintext terminal I/O in logs (agent logs status only; relay audit lines are metadata-only)
- [x] All `data` fields encrypted when E2E active (binary frames carry iv||ct raw; JSON path uses `e2e`)
- [x] Relay cannot decrypt (no decryption code; enforced by `packages/relay/test/zero-knowledge.test.mjs`)
- [x] Session tokens rotate on connect (in-place, 60s grace for the old value)
- [x] JTI prevents JWT replay
- [x] HMAC timestamp prevents replay (±30s)
- [x] Input validation on all user-controlled fields

## File organization

```
packages/
├── agent/
│   ├── src/
│   │   ├── index.ts        # CLI entry (setup, gen-token, agent)
│   │   ├── daemon.ts       # WebSocket server, session manager
│   │   ├── sessions.ts     # SessionManager, PtyDriver registry
│   │   ├── e2e.ts          # ECDH + AES-GCM encryption (Node.js)
│   │   └── drivers/
│   │       ├── pty-driver.ts   # tmux control mode
│   │       └── types.ts        # AgentDriver interface
│   └── dist/               # Compiled JS
├── web/
│   ├── src/
│   │   ├── main.ts         # Routing, host switching
│   │   ├── ws.ts           # WebSocket client + E2E
│   │   ├── e2e.ts          # ECDH + AES-GCM encryption (WebCrypto)
│   │   ├── hosts.ts        # Multi-host localStorage store
│   │   ├── sessions.ts     # Sessions list + agent selector
│   │   └── terminal.ts     # xterm.js + voice input
│   └── dist/               # Built static site
├── relay/
│   ├── src/
│   │   ├── index.ts        # CLI entry (init, start, register, hosts)
│   │   ├── server.ts       # WebSocket relay forwarding
│   │   ├── auth.ts         # HMAC + JWT + session token verification
│   │   └── db.ts           # SQLite (hosts, session_tokens, jtis)
│   └── dist/               # Compiled JS + bundled web client
└── shared/
    ├── src/
    │   ├── protocol.ts     # WebSocket message schemas
    │   ├── crypto.ts       # signHmac, validateSessionId, etc.
    │   └── index.ts        # Re-exports
    └── dist/               # Compiled declarations
```

## Glossary shortcuts

- **Host** = machine running agent daemon
- **Agent** = AI agent type (Claude, Codex, etc.)
- **Session** = live tmux session
- **Relay** = encrypted router (cannot decrypt)
- **E2E** = end-to-end encryption (ECDH + AES-GCM)
- **QR payload** = `{url, host_id, token, e2e_secret}`

See [docs/glossary.md](docs/glossary.md) for full definitions.
