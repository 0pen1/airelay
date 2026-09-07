# Architecture

airelay is a client-server system for remote access to AI coding agents. The agent daemon runs on your machine, manages tmux sessions, and streams terminal output in real time over WebSocket. The phone client connects through an optional encrypted relay.

Your terminal I/O never leaves your machine in plaintext. airelay is end-to-end encrypted.

## System overview

```
┌─────────────┐
│ Phone (Web) │  ← React + Vite + xterm.js
└──────┬──────┘
       │ WSS + E2E encryption (ECDH + AES-GCM)
       │
┌──────▼──────┐
│    Relay    │  ← Zero-knowledge router (Node.js + SQLite)
│  (Node.js)  │     Only sees encrypted frames
└──────┬──────┘
       │ WSS + E2E encryption
       │
┌──────▼──────┐
│    Agent    │  ← Session manager + E2E crypto (Node.js)
│   Daemon    │     Manages tmux sessions
└──────┬──────┘
       │
   ┌───┴────┬────────┬─────────┐
   │        │        │         │
┌──▼───┐ ┌─▼────┐ ┌─▼─────┐ ┌─▼──────┐
│Claude│ │Codex │ │Gemini │ │Custom  │
│Code  │ │      │ │       │ │Agent   │
└──────┘ └──────┘ └───────┘ └────────┘
  (tmux)  (tmux)   (tmux)    (tmux)
```

## Components

### Agent Daemon (`packages/agent`)

The heart of airelay. A Node.js process that:

- Listens for WebSocket connections from the relay
- Authenticates with HMAC signatures (host_secret)
- Performs E2E handshake with clients (ECDH + AES-GCM)
- Manages tmux sessions in control mode (`tmux -C`)
- Streams terminal output and input in real time
- Encrypts all terminal I/O with E2E session keys
- Reloads agent configurations on SIGHUP

**Key modules:**

| Module           | Responsibility                                              |
| ---------------- | ----------------------------------------------------------- |
| `index.ts`       | CLI entry: setup, gen-token, agent start/stop/reload       |
| `daemon.ts`      | WebSocket client, E2E handshake, message routing            |
| `sessions.ts`    | SessionManager, PtyDriver registry, session persistence     |
| `e2e.ts`         | ECDH + AES-GCM encryption (Node.js crypto)                  |
| `drivers/`       | PtyDriver (tmux control mode) + AgentDriver interface       |

**State:**

- `SessionManager` tracks all sessions (live + persisted)
- Each session has a `PtyDriver` instance (one per agent type)
- `E2eSession` per connected client (new keys per connection)

**Data flow:**

1. Client connects → E2E handshake
2. Client sends `attach` → daemon wires up `onOutput`/`onExit` callbacks
3. tmux emits output → driver parses → daemon encrypts → sends `output` message
4. Client sends `input` → daemon decrypts → driver forwards to tmux

### Web Client (`packages/web`)

React app for iOS, Android, and web browsers.

- Vite + React Router
- xterm.js for terminal rendering
- WebSocket client with auto-reconnect
- E2E encryption (WebCrypto API)
- Multi-host support (localStorage)
- Voice input (Web Speech API)

**Key modules:**

| Module         | Responsibility                                             |
| -------------- | ---------------------------------------------------------- |
| `main.ts`      | Routing, host switching, QR payload parsing                |
| `ws.ts`        | WebSocket client, E2E handshake, auto-reconnect            |
| `e2e.ts`       | ECDH + AES-GCM encryption (WebCrypto)                      |
| `hosts.ts`     | Multi-host localStorage store, migration                   |
| `sessions.ts`  | Sessions list, agent selector sheet                        |
| `terminal.ts`  | xterm.js integration, input handling, voice input          |

**State:**

- `HostEntry[]` in localStorage (one per paired host)
- Active host determined by URL hash (`#/hosts/:hostId/sessions`)
- `wsManager` singleton (one WS connection at a time)
- `E2eSession` per connection (destroyed on reconnect)

### Relay Server (`packages/relay`)

Optional encrypted router when the agent is behind a firewall.

- Node.js WebSocket server
- SQLite for host registry + session tokens
- HMAC authentication for agents
- JWT → session_token exchange for clients
- Zero-knowledge forwarding (cannot decrypt E2E traffic)

**Key modules:**

| Module      | Responsibility                                                  |
| ----------- | --------------------------------------------------------------- |
| `index.ts`  | CLI entry: init, start, register, hosts, revoke-host           |
| `server.ts` | WebSocket server, agent/client connection management           |
| `auth.ts`   | HMAC verification, JWT verification, session_token issuance     |
| `db.ts`     | SQLite CRUD (hosts, session_tokens, jtis)                       |

**Authentication flow:**

1. Agent connects → sends HMAC `Authorization` header
2. Relay verifies HMAC → accepts agent connection
3. Client connects → sends `{type:'auth', token:<jwt or session_token>}`
4. Relay verifies JWT (first time) → issues `session_token` (7 days)
5. Relay verifies `session_token` (reconnect) → accepts client connection
6. Relay forwards all messages between agent ↔ client

### Shared Protocol (`packages/shared`)

Wire schemas and types shared by all packages.

- WebSocket message schemas (Zod? or TypeScript interfaces)
- HMAC/validation utilities
- Constants (e2e derivation string, etc.)

## E2E Encryption

### Key derivation

```
host_secret (64 bytes)
    |
    ├─ HMAC-SHA256(host_secret, "airelay-e2e-auth")
    │       → e2e_secret (32 bytes)
    │
    └─ Included in QR payload
           → Sent to phone
```

### ECDH handshake

```
1. Phone generates ECDH P-256 keypair
   → pubkey_phone

2. Phone → Agent: {
     type: 'e2e_hello',
     pub: base64(pubkey_phone),
     sig: HMAC-SHA256(e2e_secret, pubkey_phone)
   }

3. Agent verifies sig
   → Generates ECDH P-256 keypair (pubkey_agent)
   → Computes shared_secret = ECDH(privkey_agent, pubkey_phone)
   → Derives session_key = HKDF-SHA256(
       shared_secret,
       salt: "airelay-e2e-v1",
       info: pubkey_phone || pubkey_agent
     )

4. Agent → Phone: {
     type: 'e2e_ack',
     pub: base64(pubkey_agent),
     sig: HMAC-SHA256(e2e_secret, pubkey_agent)
   }

5. Phone verifies sig
   → Computes shared_secret = ECDH(privkey_phone, pubkey_agent)
   → Derives same session_key

6. Both sides now have AES-256-GCM key
```

### Encryption

Every `input.data`, `output.data`, `scrollback.data` becomes:

```json
{
  "type": "output",
  "session_id": "...",
  "e2e": {
    "v": 1,
    "iv": "<base64 12-byte nonce>",
    "ct": "<base64 ciphertext + 16-byte GCM tag>"
  }
}
```

The relay only sees this structure — cannot decrypt `ct`.

### Forward secrecy

Each connection generates new ECDH keys. Old session keys cannot decrypt future sessions.

## WebSocket Protocol

All clients and agents speak the same WebSocket protocol. JSON text frames only (no binary frames yet).

### Agent → Relay authentication

```
WebSocket connection with header:
Authorization: HMAC host_id=<uuid>, ts=<unix_timestamp>, sig=<hmac_hex>

where sig = HMAC-SHA256(host_secret, "host_id:timestamp")
```

Relay verifies:
1. host_id exists in database
2. Recompute HMAC with stored host_secret
3. Timestamp within ±60 seconds (replay prevention)

### Client → Relay authentication

```json
// First message after WS connect
{
  "type": "auth",
  "token": "<jwt or session_token>"
}
```

**First time (JWT):**
- Relay verifies JWT signature (signed with host_secret)
- Checks JTI not used (replay prevention)
- Issues new `session_token` (64 bytes random)
- Sends `{type:'session_token_issued', session_token}`
- Sends `{type:'authed'}`

**Reconnect (session_token):**
- Relay looks up token in `session_tokens` table
- Verifies not expired (7 days)
- Sends `{type:'authed'}`

### Message types

**Client → Agent:**

```typescript
// E2E handshake
{type:'e2e_hello', pub:string, sig:string}

// Session management
{type:'list_sessions'}
{type:'new_session', agent_id:string}
{type:'attach', session_id:string}
{type:'detach', session_id:string}

// Terminal I/O
{type:'input', session_id:string, e2e?:E2ePayload, data?:string}
{type:'resize', session_id:string, cols:number, rows:number}
```

**Agent → Client:**

```typescript
// E2E handshake
{type:'e2e_ack', pub:string, sig:string}

// Session state
{type:'sessions_list', sessions:SessionInfo[]}
{type:'session_created', session_id:string, agent_id:string}
{type:'attached', session_id:string}
{type:'session_exited', session_id:string, code:number}

// Terminal output
{type:'output', session_id:string, e2e?:E2ePayload, data?:string}
{type:'scrollback', session_id:string, e2e?:E2ePayload, data?:string, seq:number, done:boolean}

// Errors
{type:'error', code:ErrorCode, message:string}
```

### Backward compatibility

Without E2E:
- `input` has `data` field (plaintext)
- `output` has `data` field (plaintext)
- `scrollback` has `data` field (plaintext)

With E2E:
- `input` has `e2e` field (ciphertext), no `data`
- `output` has `e2e` field (ciphertext), no `data`
- `scrollback` has `e2e` field (ciphertext), no `data`

Relay forwards both formats blindly.

## Session Lifecycle

### Create session

1. Client sends `{type:'new_session', agent_id:'claude'}`
2. Agent finds PtyDriver for `agent_id`
3. Agent spawns tmux session: `tmux new-session -d -s airelay-<uuid> claude`
4. Agent attaches in control mode: `tmux -C attach -t airelay-<uuid>`
5. Agent persists session to `sessions.json`
6. Agent sends `{type:'session_created', session_id, agent_id}`
7. Agent auto-attaches (wires up output/exit callbacks)

### Attach session

1. Client sends `{type:'attach', session_id}`
2. Agent checks `session.lockedBy` (single-client lock)
3. Agent locks session (`lockedBy = 'client'`)
4. Agent sends `{type:'attached', session_id}`
5. Agent wires up `onOutput`/`onExit` callbacks
6. Agent sends scrollback in 64KB chunks:
   ```
   {type:'scrollback', session_id, e2e:{...}, seq:0, done:false}
   {type:'scrollback', session_id, e2e:{...}, seq:1, done:false}
   {type:'scrollback', session_id, e2e:{...}, seq:2, done:true}
   ```
7. Client receives live output via `{type:'output', ...}`

### Send input

1. Client encrypts user input with E2E session key
2. Client sends `{type:'input', session_id, e2e:{v,iv,ct}}`
3. Relay forwards (cannot decrypt)
4. Agent decrypts with E2E session key
5. Agent sends to tmux: `send-keys -t airelay-<uuid> "<plaintext>"`

### Detach session

1. Client sends `{type:'detach', session_id}`
2. Agent unlocks session (`lockedBy = null`)
3. Agent disposes output/exit callbacks
4. tmux session keeps running (background)

### Session exit

1. tmux process exits (agent finished/crashed)
2. Driver's `onExit` callback fires
3. Agent sends `{type:'session_exited', session_id, code}`
4. Agent removes session from registry
5. Agent deletes from `sessions.json`

## Multi-Host Support

The web client can pair with multiple hosts and switch between them.

### Storage (`localStorage`)

```typescript
interface HostEntry {
  host_id: string;
  relay_url: string;
  session_token: string;  // Opaque 64-byte token
  e2e_secret?: string;    // Hex, derived from host_secret
}

const hosts: HostEntry[] = JSON.parse(localStorage.getItem('airelay_hosts') || '[]');
const activeHostId: string | null = localStorage.getItem('airelay_active_host');
```

### Host switching

1. User navigates to `#/hosts` (host switcher)
2. User taps a different host card
3. Route changes to `#/hosts/<new-host-id>/sessions`
4. `ensureHostConnected(newHostId)` runs:
   - Disconnect current WS (if any)
   - Set active host ID
   - Call `wsManager.connect(entry.relay_url, entry.session_token)`
   - Set `wsManager.setE2eSecret(entry.e2e_secret)`
5. WS connects → `authed` → E2E handshake → request sessions list

### Adding a new host

1. User scans QR code on another host
2. QR payload: `{url, host_id, token, e2e_secret}`
3. `addHostAndConnect()` runs:
   - Add `HostEntry` to localStorage
   - Set as active host
   - Connect WS + E2E handshake
   - Navigate to sessions page

## Agent Types

Agents are configured in `~/.config/airelay/agents.json`:

```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude Code",
      "type": "pty",
      "command": "claude",
      "args": [],
      "icon": "🤖"
    },
    {
      "id": "codex",
      "name": "OpenAI Codex",
      "type": "pty",
      "command": "codex",
      "args": [],
      "icon": "⚡"
    }
  ]
}
```

**Supported types:**
- `pty` — CLI agent via tmux (implemented)
- `browser` — Browser-based agent (future)

**Agent lifecycle:**

1. Daemon startup → `buildDriversFromConfig()` creates PtyDrivers
2. `sessionManager.syncDrivers(drivers)` registers them
3. SIGHUP → reload `agents.json` → re-sync drivers (preserves live sessions)
4. `list_agent_types` → check `which <command>` → return `available:true/false`

**PtyDriver:**

- Manages all sessions for one agent type
- Spawns: `tmux new-session -d -s airelay-<uuid> <command> <args>`
- Attaches: `tmux -C attach -t airelay-<uuid>`
- Parses control-mode output: `%output <pane-id> <base64-data>`
- Sends input: `send-keys -t airelay-<uuid> "<data>"`
- Resizes: `refresh-client -t airelay-<uuid> -x <cols> -y <rows>`
- Fetches scrollback: `capture-pane -p -e -S -5000 -t airelay-<uuid>`

## Data Persistence

### Agent daemon

```
~/.config/airelay/
├── config.json         # {hostId, hostSecret, relayUrl}
├── agents.json         # [{id, name, type, command, args, icon}]
└── sessions.json       # [{sessionId, agentId, createdAt}]
```

**Restore on startup:**

1. Scan tmux for sessions named `airelay-*`
2. Load `sessions.json` for metadata
3. Match tmux sessions with persisted sessions
4. Re-attach control mode: `tmux -C attach -t airelay-<uuid>`
5. Rebuild `SessionManager` state (no output callbacks yet)
6. Output callbacks wired up when client attaches

### Relay server

SQLite database (default: `./airelay-relay.db`):

```sql
CREATE TABLE hosts (
  host_id TEXT PRIMARY KEY,
  host_secret TEXT NOT NULL
);

CREATE TABLE session_tokens (
  token TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE jtis (
  jti TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
```

**Cleanup:**
- `session_tokens` older than 7 days → deleted on relay startup
- `jtis` older than 10 minutes → deleted on relay startup

### Web client

```
localStorage:
  airelay_hosts         = JSON.stringify(HostEntry[])
  airelay_active_host   = hostId (string)
  airelay_session_token = token (legacy, migrated to hosts[].session_token)
```

## Security Boundaries

### Threat model

**Assumptions:**
- Host machine is trusted (you control it)
- Relay is untrusted (may be compromised)
- Network is untrusted (eavesdropping, MITM)

**Protections:**
- E2E encryption → relay cannot read terminal I/O
- HMAC signatures → relay cannot impersonate host
- JTI tracking → JWT replay prevented
- Timestamp validation → HMAC replay prevented (±60s window)
- Forward secrecy → old keys cannot decrypt future sessions

**Out of scope:**
- Host compromise (attacker has access to `host_secret`)
- Phone compromise (attacker has access to `e2e_secret`)
- Relay DoS (relay can refuse connections)

### Attack scenarios

| Attack                     | Mitigation                                    |
| -------------------------- | --------------------------------------------- |
| Relay reads terminal I/O   | E2E encryption (relay only sees ciphertext)   |
| Relay impersonates host    | HMAC signature (relay doesn't have secret)    |
| MITM modifies messages     | AES-GCM auth tag (tampering detected)         |
| Replay old JWT             | JTI tracking (used tokens rejected)           |
| Replay old HMAC            | Timestamp (±60s, then rejected)               |
| Steal future keys          | Forward secrecy (new ECDH per connection)     |

See [docs/security.md](docs/security.md) for full threat model.

## Deployment Models

### 1. Local relay (development)

```bash
# Terminal 1: Start relay
cd packages/relay
npm start  # → ws://localhost:3000

# Terminal 2: Start agent
cd packages/agent
npm start  # → connects to localhost:3000

# Terminal 3: Start web dev server
cd packages/web
npm run dev  # → http://localhost:5173
```

Agent and phone both connect to `ws://localhost:3000`.

### 2. Remote relay (production)

```
Phone (4G/5G) → WSS relay.example.com (public)
                       ↓
                Agent (VPS, behind NAT) → connects outbound to relay
```

Agent daemon starts with `relayUrl = https://relay.example.com` in `config.json`.

### 3. Tailscale/VPN (no relay)

Future: Phone connects directly to agent via Tailscale/WireGuard.

```
Phone (Tailscale IP) → WS 100.x.y.z:6767 (agent)
```

No relay needed (direct encrypted tunnel).

## Future Extensions

### Workspace concept
- Group multiple sessions under one project
- Archive/restore entire workspace
- Shared scrollback search

### Timeline persistence
- Store full message history (not just scrollback)
- Offline viewing
- Export conversations

### MCP tools
- Agent can request file operations
- Phone approves tool calls
- Permission system (read/write/manage)

### Subagents
- Agent can spawn child agents
- Parent-child relationships
- Cascade archive

### Desktop app
- Electron wrapper
- Auto-manage agent daemon
- System tray icon

### Direct connections
- mDNS/Bonjour discovery
- Tailscale/WireGuard support
- Skip relay for LAN connections
