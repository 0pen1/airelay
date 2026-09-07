# Glossary

Authoritative terminology. UI label wins, no synonyms. One term, one meaning.

## Core concepts

### Host
A machine running the airelay agent daemon. Identified by `host_id` (UUID) and authenticated with `host_secret` (HMAC key).

**Not:** "server", "machine", "node", "device" — always **host**.

### Agent
A configured AI agent type (Claude Code, Codex, Gemini CLI). Defined in `agents.json` with `id`, `command`, `icon`.

**Not:** "provider", "bot", "assistant" — always **agent**.

### Session
A live tmux session running one agent instance. Each session has `session_id` (UUID), `agent_id`, `created_at`, `locked_by`.

**Not:** "conversation", "run", "instance" — always **session**.

### Relay
Optional encrypted router between phone and host. The relay is **zero-knowledge** — it forwards encrypted WebSocket frames and cannot decrypt terminal I/O.

**Not:** "proxy", "bridge", "server" — always **relay**.

## Authentication

### host_secret
64-byte HMAC key used for agent↔relay authentication. Never leaves the host.

### e2e_secret
HMAC-SHA256(host_secret, "airelay-e2e-auth"). Used to sign ECDH public keys during E2E handshake. Shared with the phone via QR code.

**Not:** "e2e key", "encryption key" — always **e2e_secret**.

### JWT
JSON Web Token used for first-time client connection. Short-lived (5 min), single-use (JTI tracked).

### session_token
Opaque 64-byte token issued after JWT validation. Long-lived (7 days), used for reconnects.

**Not:** "refresh token", "access token" — always **session_token**.

### JTI
JWT ID — unique identifier preventing replay. Relay tracks used JTIs in SQLite.

## Encryption

### E2E
End-to-end encryption between phone and host. The relay cannot decrypt.

**Not:** "encryption", "e2ee", "e2e encryption" — in prose use **E2E encryption**; in code use **E2E**.

### E2E handshake
Key exchange: client sends `e2e_hello` (ECDH pubkey + HMAC sig), agent responds `e2e_ack` (own pubkey + sig). Both derive shared AES-256-GCM key via HKDF.

### E2ePayload
Encrypted message body: `{v:1, iv:<base64>, ct:<base64>}` where `ct` = ciphertext + 16-byte GCM tag.

## WebSocket messages

### e2e_hello
Client → Agent. Starts E2E handshake. Contains client's ECDH pubkey + HMAC signature.

### e2e_ack
Agent → Client. Completes E2E handshake. Contains agent's ECDH pubkey + HMAC signature.

### input
Client → Agent. Terminal keyboard input. `data` field encrypted when E2E active.

### output
Agent → Client. Terminal output chunk. `data` field encrypted when E2E active.

### scrollback
Agent → Client. Terminal history sent on attach. Chunked (64KB), `seq` for ordering, `done` marks end.

### attach
Client → Agent. Request to connect to a session (receive live output + scrollback).

### detach
Client → Agent. Disconnect from a session (stop receiving output, release lock).

## UI

### Session card
Card in the sessions list showing one session's icon, name, age, and lock status.

### Agent sheet
Bottom sheet listing available agent types, shown when user taps the FAB (+) to create a new session.

### Host switcher
Page listing all paired hosts, allowing the user to switch which host they're connected to.

## File paths

### `~/.config/airelay/`
Agent daemon home directory.

- `config.json` — host_id, host_secret, relay_url
- `agents.json` — agent type definitions
- `sessions.json` — persisted session metadata

### Relay SQLite
Relay's database (default: `./airelay-relay.db`).

- `hosts` — host_id → host_secret
- `session_tokens` — token → host_id (7-day TTL)
- `jtis` — used JWT IDs (replay prevention)

## Forbidden words

Never use these in UI, docs, or code comments:

- ~~server~~ (when you mean host or relay)
- ~~machine~~ (when you mean host)
- ~~device~~ (when you mean host or client)
- ~~bot~~ (when you mean agent)
- ~~proxy~~ (when you mean relay)
- ~~encryption key~~ (when you mean e2e_secret or session key)
- ~~refresh token~~ (when you mean session_token)
- ~~conversation~~ (when you mean session)
- ~~tab~~ (when you mean session)
