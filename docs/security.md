# Security

Threat model, E2E encryption details, and security boundaries for airelay.

## Trust Model

### Trusted
- **Host machine** — you control it, has access to code
- **Phone/client device** — you control it, stores `e2e_secret`

### Untrusted
- **Relay server** — may be compromised, operated by third party
- **Network** — eavesdropping, packet injection, MITM possible

### Assumptions
- Attacker does NOT have access to host machine or phone
- Attacker CAN compromise the relay
- Attacker CAN intercept/modify network traffic

## Threat Scenarios

### 1. Relay reads terminal I/O

**Attack:** Relay operator logs all WebSocket messages to read terminal sessions.

**Mitigation:** End-to-end encryption (ECDH + AES-GCM). All `input`, `output`, `scrollback` messages have encrypted `e2e` payload. Relay only sees ciphertext.

**Evidence:**
```json
// Relay sees this (cannot decrypt `ct`):
{
  "type": "output",
  "session_id": "3e29ea37-...",
  "e2e": {
    "v": 1,
    "iv": "Rz8pL3V2Nw==",
    "ct": "m8vK3Lp9...4jF2qA=="
  }
}
```

### 2. Relay impersonates host

**Attack:** Relay sends fake messages pretending to be the agent daemon.

**Mitigation:** Agent authenticates with HMAC signature only the real host knows:
```
Authorization: HMAC host_id=<uuid>, ts=<timestamp>, sig=HMAC-SHA256(host_secret, "host_id:timestamp")
```

Relay cannot forge `sig` without `host_secret`. Relay verifies signature before accepting agent connection.

### 3. MITM replaces agent's public key

**Attack:** Attacker intercepts `e2e_hello` and replaces client's ECDH public key with their own, establishing separate E2E sessions with client and agent.

**Mitigation:** HMAC signature over public keys using pre-shared `e2e_secret`:
```
sig = HMAC-SHA256(e2e_secret, pubkey)
```

Client and agent both verify signatures. Attacker doesn't know `e2e_secret`, cannot forge valid signature.

### 4. Replay old messages

**Attack a: Replay JWT**

Relay records a JWT, replays it later to impersonate client.

**Mitigation:** JTI (JWT ID) tracking. Relay stores used JTIs in SQLite. Second use rejected.

**Attack b: Replay HMAC signature**

Attacker records agent's `Authorization` header, replays it.

**Mitigation:** Timestamp in HMAC message. Relay rejects signatures older than ±30 seconds.

**Attack c: Replay encrypted terminal input**

Relay captures a legitimate encrypted input (e.g. a `y\n` sent to confirm a
permission prompt) and replays it verbatim later, hoping to re-confirm the
same prompt while the user is away.

**Mitigation:** Every E2E-encrypted input carries a per-connection sequence
number bound into the GCM AAD. The agent tracks the counter and rejects any
input whose seq is not strictly greater than the last accepted one — and
mutating the seq to pass that check breaks the GCM tag. (JSON path: `seq`
field on the `e2e` payload. Binary path: first 4 bytes of the payload,
big-endian.)

### 5. Tamper with encrypted messages

**Attack:** Modify ciphertext in `e2e.ct` to change terminal output.

**Mitigation:** AES-GCM includes 16-byte authentication tag. Decryption fails if ciphertext was modified.

### 6. Steal future session keys

**Attack:** Attacker compromises one E2E session key, uses it to decrypt future sessions.

**Mitigation:** Forward secrecy. New ECDH keypair generated for every connection. Old session keys cannot decrypt new sessions.

### 7. Relay suppresses the E2E handshake (downgrade)

**Attack:** Instead of breaking the crypto, the relay simply drops
`e2e_hello`/`e2e_ack` frames so the session stays in plaintext mode.

**Mitigation (defense in depth):**
- Agent: once a client attaches, an E2E handshake is expected within a
  10 s window; after that, plaintext output is suppressed and plaintext
  input is always rejected once E2E is active (a relay cannot mix raw and
  encrypted keystrokes).
- Client: a watchdog warns the user if the handshake has not completed
  shortly after auth.

### 8. Relay injects content into the web client

**Attack:** The relay forges forwarded protocol frames (e.g. a
`sessions_list` with a hostile `agent_name`) to inject HTML/JS into the
phone's web app, which holds every host's session tokens and e2e secrets in
localStorage.

**Mitigation:** All relay-forwarded metadata rendered by the web client is
HTML-escaped before insertion, and the app ships a Content-Security-Policy
(`script-src 'self'`) so injected markup cannot execute.

## Cryptographic Primitives

### HMAC-SHA256

Used for:
- Agent authentication (`Authorization` header)
- Public key signatures in E2E handshake

**Properties:**
- Secure PRF (pseudorandom function)
- Resistant to length extension attacks
- Standard: FIPS 198-1

### ECDH (Elliptic Curve Diffie-Hellman)

Curve: **P-256** (prime256v1, secp256r1)

Used for: Key exchange in E2E handshake

**Why P-256:**
- NIST standard, widely supported
- Native in WebCrypto API (browser) and Node.js `crypto`
- 128-bit security level

**Alternative considered:** X25519 (Curve25519)
- Higher performance, newer design
- Not in WebCrypto standard (requires external library)

### HKDF-SHA256

Used for: Deriving AES key from ECDH shared secret

```
session_key = HKDF-SHA256(
  ikm: shared_secret,        // 32 bytes from ECDH
  salt: "airelay-e2e-v1",    // domain separation
  info: pubkey_a || pubkey_b, // binds to this handshake
  length: 32                 // AES-256 key
)
```

**Why HKDF:**
- Extract uniform randomness from ECDH output
- Bind key to specific context (salt + info)
- Standard: RFC 5869

### AES-256-GCM

Used for: Encrypting terminal I/O

**Mode:** Galois/Counter Mode
**Key size:** 256 bits
**Nonce size:** 12 bytes (96 bits)
**Tag size:** 16 bytes (128 bits)

**Properties:**
- Authenticated encryption (confidentiality + integrity)
- Nonce must never repeat for same key
- Standard: NIST SP 800-38D

**Nonce generation:**
- Random 12 bytes per message (`crypto.randomBytes(12)`)
- Safe: P(collision) < 2^-32 for 2^32 messages

## Key Derivation Chain

```
                 host_secret (64 bytes, random)
                       |
                       ├─ HMAC key for agent↔relay auth
                       |
                       └─ HMAC-SHA256(host_secret, "airelay-e2e-auth")
                               → e2e_secret (32 bytes)
                                     |
                                     ├─ Sign ECDH public keys
                                     |
                  (shared via QR code to phone)
                                     ↓
         Client generates ECDH keypair      Agent generates ECDH keypair
                pubkey_c, privkey_c              pubkey_a, privkey_a
                       |                                |
                       |                                |
         Client → Agent: {pub: pubkey_c, sig: HMAC(e2e_secret, pubkey_c)}
                       |                                |
                       └────────────────────────────────┤
                                                        ↓
                            Agent verifies sig, computes:
                            shared_secret = ECDH(privkey_a, pubkey_c)
                                                        ↓
         Agent → Client: {pub: pubkey_a, sig: HMAC(e2e_secret, pubkey_a)}
                       ↓                                |
         Client verifies sig, computes:                |
         shared_secret = ECDH(privkey_c, pubkey_a) ←───┘
                       |
                       └─ HKDF-SHA256(shared_secret, ...)
                               → session_key (32 bytes, AES-256)
                                     |
                   ┌─────────────────┴─────────────────┐
                   ↓                                   ↓
         Encrypt terminal input           Encrypt terminal output
         AES-256-GCM(session_key, ...)    AES-256-GCM(session_key, ...)
```

## Authentication Flow Security

### Agent → Relay

```
1. Agent computes: sig = HMAC-SHA256(host_secret, `${host_id}:${ts}`)
2. Agent sends: Authorization: HMAC host_id=..., ts=..., sig=...
3. Relay looks up host_secret by host_id
4. Relay recomputes HMAC, compares in constant time
5. Relay checks: now - 60 < ts < now + 60
6. Accept or reject (4001)
```

**Security properties:**
- Replay window: 120 seconds
- No host_secret transmitted
- Timing-safe comparison (prevents timing attacks)

### Client → Relay (first time)

```
1. Agent generates JWT:
   {hostId, jti:<random-uuid>, iat:<now>, exp:<now+TTL>}
   Signed with host_secret (HMAC-SHA256)

2. Client sends: {type:'auth', token:<jwt>}

3. Relay verifies:
   - JWT signature (using host_secret from database)
   - exp > now (not expired)
   - jti not in `jtis` table (not replayed)

4. Relay marks jti used

5. Relay generates session_token:
   - 64 random bytes → hex
   - Stores in session_tokens table (expires in 7 days)

6. Relay sends: {type:'session_token_issued', session_token}

7. Client stores session_token, discards JWT
```

**Security properties:**
- JWT valid for a short TTL (default 24h via `airelay gen-token`, configurable with `--ttl`; keep it short — the JWT is single-use)
- Single-use (JTI prevents replay)
- Session token valid for 7 days
- Session token is opaque (unpredictable, cannot be forged)

### Client → Relay (reconnect)

```
1. Client sends: {type:'auth', token:<session_token>}

2. Relay looks up session_token in database

3. Relay checks: expires_at > now

4. Accept or reject
```

**Security properties:**
- No JWT needed (avoid re-scanning QR)
- Token rotation on first connect (JWT → session_token)
- Automatic expiry (7 days)

## E2E Handshake Security

```
1. Client: ephemeral ECDH keypair (pubkey_c, privkey_c)
   sig_c = HMAC-SHA256(e2e_secret, pubkey_c)

2. Client → Agent: {type:'e2e_hello', pub:pubkey_c, sig:sig_c}

3. Agent: verify sig_c == HMAC-SHA256(e2e_secret, pubkey_c)
   - If invalid → abort, no E2E
   - If valid → continue

4. Agent: ephemeral ECDH keypair (pubkey_a, privkey_a)
   sig_a = HMAC-SHA256(e2e_secret, pubkey_a)
   shared_secret = ECDH(privkey_a, pubkey_c)

5. Agent → Client: {type:'e2e_ack', pub:pubkey_a, sig:sig_a}

6. Client: verify sig_a == HMAC-SHA256(e2e_secret, pubkey_a)
   - If invalid → abort, no E2E
   - If valid → continue

7. Client: shared_secret = ECDH(privkey_c, pubkey_a)

8. Both: session_key = HKDF-SHA256(shared_secret, salt, info)
```

**Security properties:**
- Mutual authentication (both sides verify signatures)
- MITM protection (attacker cannot forge signatures without e2e_secret)
- Forward secrecy (ephemeral keys, destroyed after handshake)
- Binding (HKDF info includes both public keys)

## Attack Surface

### Host compromise

**Impact:** Attacker gains access to `host_secret` and `e2e_secret`. Can decrypt all future E2E sessions.

**Mitigation:** Keep host machine secure. Standard system hardening applies.

**Out of scope:** airelay cannot protect against host compromise.

### Phone compromise

**Impact:** Attacker gains access to `e2e_secret` and `session_token`. Can decrypt E2E sessions and impersonate client.

**Mitigation:** Phone lock screen, biometric auth, remote wipe.

**Out of scope:** airelay cannot protect against phone compromise.

### Relay compromise

**Impact:** Attacker controls relay server.

**Cannot do:**
- Read terminal I/O (encrypted E2E)
- Impersonate host (no host_secret)
- Forge E2E handshake (no e2e_secret)

**Can do:**
- Deny service (refuse connections)
- Log metadata (host_id, session_id, message timestamps, sizes)
- Traffic analysis (message frequency, payload sizes)

**Mitigation:** E2E encryption. Metadata leakage unavoidable in relay architecture.

### Network compromise

**Impact:** Attacker intercepts/modifies WebSocket traffic.

**Cannot do:**
- Read terminal I/O (encrypted E2E)
- Tamper with messages (AES-GCM tag)
- Replay messages (timestamp/JTI)
- MITM handshake (signature verification)

**Can do:**
- Drop messages (DoS)
- Traffic analysis (same as relay)

**Mitigation:** TLS (WSS) for transport. E2E for payload. Signature for handshake.

## Compliance

### GDPR / Privacy

- **No telemetry:** airelay does not phone home
- **No accounts:** no email, no password, no user database
- **Local-first:** terminal data never leaves host in plaintext
- **Relay is zero-knowledge:** cannot read content

### Encryption Standards

| Primitive      | Standard            | Status     |
| -------------- | ------------------- | ---------- |
| HMAC-SHA256    | FIPS 198-1          | Approved   |
| ECDH P-256     | NIST SP 800-56A     | Approved   |
| HKDF-SHA256    | RFC 5869            | Published  |
| AES-256-GCM    | NIST SP 800-38D     | Approved   |

All primitives are NIST-approved or RFC-standard.

## Threat Summary

| Threat                       | Mitigation                      | Residual Risk |
| ---------------------------- | ------------------------------- | ------------- |
| Relay reads I/O              | E2E encryption                  | None          |
| Relay impersonates host      | HMAC signature                  | None          |
| MITM handshake               | HMAC signature                  | None          |
| Replay JWT                   | JTI tracking                    | None          |
| Replay HMAC                  | Timestamp                       | None          |
| Tamper messages              | AES-GCM tag                     | None          |
| Steal future keys            | Forward secrecy                 | None          |
| Metadata leakage             | (unavoidable)                   | Traffic analysis |
| Host compromise              | (out of scope)                  | Total compromise |
| Phone compromise             | (out of scope)                  | Total compromise |
| Relay DoS                    | (out of scope)                  | Availability   |

## Future Work

### Principal + Credential separation

Current: `session_token` is tied to one device.

Future: Separate `Principal` (durable identity) from `Credential` (device token). Allows:
- Multiple devices per host
- Device revocation
- Credential rotation

### Fine-grained permissions

Current: Authenticated = full access.

Future: Permission levels:
- `read` — view sessions, scrollback
- `write` — send input, create sessions
- `manage` — modify config, revoke devices

### Audit log

Current: No persistent log of security events.

Future: Append-only log:
- New device paired
- Session created/attached
- Failed auth attempts
- Device revoked

### Rate limiting

Current: No rate limits.

Future: Per-connection limits:
- Max 100 msg/sec
- Max 1 MB/sec output
- Max 10 concurrent sessions

### Direct connections

Current: All traffic through relay.

Future: Optional LAN/Tailscale direct connection:
- Skip relay entirely
- Lower latency
- No metadata leakage to relay
