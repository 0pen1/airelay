# Protocol

WebSocket message schemas for airelay. All communication uses JSON text frames.

## Envelope

All messages are JSON objects with a `type` field:

```typescript
interface Message {
  type: string;
  // ... type-specific fields
}
```

## Authentication

### Agent → Relay

Agents authenticate via HTTP header when opening the WebSocket:

```
Authorization: HMAC host_id=<uuid>, ts=<unix_seconds>, sig=<hex>
```

**Signature:**
```
sig = HMAC-SHA256(
  key: host_secret,
  message: `${host_id}:${ts}`
)
```

**Relay verification:**
1. Look up `host_secret` by `host_id`
2. Recompute HMAC, compare with `sig` (timing-safe)
3. Check `ts` within ±60 seconds of now

**Failure:** WebSocket closed with code `4001`.

### Client → Relay

Clients authenticate with the first WebSocket message:

```typescript
{type:'auth', token:string}
```

**Token types (relay tries in order):**

1. **session_token** — opaque 64-char hex, stored in `session_tokens` table
2. **JWT** — signed with host_secret, single-use (JTI tracked), 5-min expiry

**JWT flow (first connection):**

1. Relay verifies JWT signature + expiry + JTI unused
2. Marks JTI used
3. Issues new `session_token`:
   ```typescript
   {type:'session_token_issued', session_token:string}
   ```
4. Client stores it (replaces JWT)

**Success:**

```typescript
{type:'authed'}
```

**Failure:**

```typescript
{type:'error', code:'AUTH_FAILED', message:string}
// then WebSocket closed with code 4001
```

## E2E Handshake

After `{type:'authed'}`, client initiates E2E handshake (if `e2e_secret` is set).

### Client → Agent

```typescript
{
  type: 'e2e_hello',
  pub: string,   // base64, ECDH P-256 public key (65 bytes, uncompressed point)
  sig: string,   // hex, HMAC-SHA256(e2e_secret, pub)
}
```

### Agent → Client

```typescript
{
  type: 'e2e_ack',
  pub: string,   // base64, agent's ECDH P-256 public key
  sig: string,   // hex, HMAC-SHA256(e2e_secret, pub)
}
```

### Key derivation (both sides)

```
shared_secret = ECDH(my_privkey, their_pubkey)   // 32 bytes
session_key   = HKDF-SHA256(
  ikm: shared_secret,
  salt: "airelay-e2e-v1",
  info: my_pubkey || their_pubkey,
  length: 32
)
```

`my_pubkey || their_pubkey` — sorted lexicographically, so both sides derive the same `info`.

### Failure

Signature verification failure → handshake aborted, no E2E. Messages fall back to plaintext `data` field.

## Terminal I/O

### Client → Agent: input

```typescript
{
  type: 'input',
  session_id: string,
  // E2E mode:
  e2e?: {v:1, iv:string, ct:string},
  // Plaintext mode (no E2E):
  data?: string,
}
```

Exactly one of `e2e`/`data` must be present.

### Agent → Client: output

```typescript
{
  type: 'output',
  session_id: string,
  e2e?: {v:1, iv:string, ct:string},
  data?: string,
}
```

### Agent → Client: scrollback

Sent on `attach`, in 64KB chunks:

```typescript
{
  type: 'scrollback',
  session_id: string,
  seq: number,        // 0-based chunk index
  done: boolean,      // true on last chunk
  e2e?: {v:1, iv:string, ct:string},
  data?: string,
}
```

Client accumulates chunks by `seq`, writes all in order when `done:true` arrives.

## Session Management

### Client → Agent: list_sessions

```typescript
{type:'list_sessions'}
```

### Agent → Client: sessions_list

```typescript
{
  type: 'sessions_list',
  sessions: Array<{
    session_id: string,
    agent_id: string,
    agent_name: string,
    icon: string,
    created_at: number,      // unix seconds
    locked_by: string | null,
  }>
}
```

### Client → Agent: new_session

```typescript
{
  type: 'new_session',
  agent_id: string,   // must match agents.json entry
}
```

### Agent → Client: session_created

```typescript
{
  type: 'session_created',
  session_id: string,   // new UUID
  agent_id: string,
}
```

Client should navigate to `#/hosts/<hostId>/terminal/<session_id>`.

### Client → Agent: attach

```typescript
{
  type: 'attach',
  session_id: string,
}
```

### Agent → Client: attached

```typescript
{
  type: 'attached',
  session_id: string,
}
```

Followed by scrollback chunks.

### Client → Agent: detach

```typescript
{
  type: 'detach',
  session_id: string,
}
```

Releases the session lock. Agent stops sending output.

### Agent → Client: session_exited

```typescript
{
  type: 'session_exited',
  session_id: string,
  code: number,   // process exit code
}
```

Session is removed from registry.

## Agent Discovery

### Client → Agent: list_agent_types

```typescript
{type:'list_agent_types'}
```

### Agent → Client: agent_types

```typescript
{
  type: 'agent_types',
  agents: Array<{
    id: string,
    name: string,
    icon: string,
    available: boolean,   // `which <command>` succeeded
  }>
}
```

## Errors

```typescript
{
  type: 'error',
  code: 'AUTH_FAILED' | 'SESSION_NOT_FOUND' | 'SESSION_OCCUPIED' | 'AGENT_NOT_FOUND' | 'AGENT_UNAVAILABLE',
  message: string,
}
```

| Code                | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `AUTH_FAILED`       | Invalid/expired token                         |
| `SESSION_NOT_FOUND` | `session_id` doesn't exist                    |
| `SESSION_OCCUPIED`  | Another client holds the lock                 |
| `AGENT_NOT_FOUND`   | `agent_id` not in agents.json                 |
| `AGENT_UNAVAILABLE` | Agent command not installed or failed to start |

## E2E Payload Format

```typescript
interface E2ePayload {
  v: 1;        // version
  iv: string;  // base64, 12-byte AES-GCM nonce
  ct: string;  // base64, ciphertext + 16-byte GCM auth tag
}
```

**Encryption:**
```
plaintext → AES-256-GCM encrypt(key, iv, plaintext)
          → ciphertext || auth_tag (16 bytes)
          → base64 → ct
```

**Decryption:**
```
ct → base64 decode
  → split: ciphertext (n-16 bytes) || tag (16 bytes)
  → AES-256-GCM decrypt(key, iv, ciphertext, tag)
  → plaintext
```

## Backward Compatibility

### Legacy (no E2E)

Old clients without `e2e_secret`:

```typescript
// input with plaintext
{type:'input', session_id, data:'hello'}

// output with plaintext
{type:'output', session_id, data:'...'}
```

Agent detects absence of `e2e` field, treats `data` as plaintext.

### Modern (E2E)

```typescript
// input encrypted
{type:'input', session_id, e2e:{v:1, iv:'...', ct:'...'}}

// output encrypted
{type:'output', session_id, e2e:{v:1, iv:'...', ct:'...'}}
```

Agent detects `e2e` field, decrypts before processing.

## Message Ordering

- WebSocket guarantees in-order delivery per connection
- Scrollback chunks arrive in `seq` order
- `output` messages arrive in real-time order (no seq)
- Client should buffer `output` until scrollback `done:true` arrives (optional optimization)

## Frame Size

- Max message size: 1 MB (JSON)
- Scrollback chunk: 64 KB plaintext (before encryption)
- Encrypted chunk: ~87 KB (64KB * 4/3 base64 + overhead)

## Rate Limiting

Not implemented yet. Future:
- Max 100 messages/second per connection
- Max 10 concurrent sessions per host
- Max 1 MB/s output per session
