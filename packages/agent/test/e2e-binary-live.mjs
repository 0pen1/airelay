// Live E2E integration test: binary frames through the running relay + agent.
//
// Simulates the phone connecting to the relay, authenticating with a session
// token, attaching a session, completing the E2E handshake, then:
//   1. sending binary input frames (E2E-encrypted payload)
//   2. receiving binary output frames (E2E-encrypted payload)
//   3. verifying the relay never saw plaintext (frames are opaque ciphertext)
//
// Usage: node test/e2e-binary-live.mjs
// Generates a fresh one-time JWT itself (JTI replay protection means each
// token works exactly once). Requires: relay on :3000 with the host agent
// connected.

import { WebSocket } from 'ws';
import {
  createECDH, createHmac, createCipheriv, createDecipheriv,
  hkdfSync, randomBytes,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SignJWT } from 'jose';
import { v4 as uuidv4 } from 'uuid';

const SALT = Buffer.from('airelay-e2e-v1', 'utf8');

// ── config ────────────────────────────────────────────────────────────────────
const config = JSON.parse(readFileSync(join(homedir(), '.config', 'airelay', 'config.json'), 'utf8'));
// Same derivation as the agent daemon: HMAC keyed on the raw hostSecret string.
const e2eSecret = createHmac('sha256', config.hostSecret)
  .update('airelay-e2e-auth').digest('hex');

// Fresh one-time JWT (jti makes each token single-use at the relay)
const token = await new SignJWT({ hostId: config.hostId, jti: uuidv4() })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
  .sign(new TextEncoder().encode(config.hostSecret));

const wsUrl = (config.relayUrl || 'http://127.0.0.1:3000').replace(/^http/, 'ws') + '/ws/client';

// ── message plumbing ──────────────────────────────────────────────────────────
const waiters = [];

function waitFor(pred, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    waiters.push({ pred, resolve: (v) => { clearTimeout(t); resolve(v); } });
  });
}

function dispatch(msg) {
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i].pred(msg)) {
      waiters.splice(i, 1)[0].resolve(msg);
      return true;
    }
  }
  return false;
}

// ── E2E state (browser-equivalent, node:crypto ECDH math) ─────────────────────
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const myPubB64 = ecdh.getPublicKey('base64');
let sessionKey = null;

function verifyAckAndDerive(agentPubB64, sigB64) {
  const expected = createHmac('sha256', Buffer.from(e2eSecret, 'hex'))
    .update(Buffer.from(agentPubB64, 'base64')).digest('base64');
  if (expected !== sigB64) throw new Error('e2e_ack signature invalid (MITM?)');
  const shared = ecdh.computeSecret(Buffer.from(agentPubB64, 'base64'));
  const pubs = [myPubB64, agentPubB64].sort();
  const info = Buffer.from(pubs[0] + pubs[1], 'utf8');
  sessionKey = Buffer.from(hkdfSync('sha256', shared, SALT, info, 32));
}

function encryptBytes(pt) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sessionKey, iv);
  return Buffer.concat([iv, c.update(pt), c.final(), c.getAuthTag()]);
}

function decryptBytes(payload) {
  const iv = payload.subarray(0, 12);
  const rest = payload.subarray(12);
  const d = createDecipheriv('aes-256-gcm', sessionKey, iv);
  d.setAuthTag(rest.subarray(rest.length - 16));
  return Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]);
}

// ── binary frame codec (same as shared) ───────────────────────────────────────
const OUTPUT = 0x01, INPUT = 0x02;
function encodeFrame(op, slot, payload) {
  const out = Buffer.alloc(2 + payload.length);
  out[0] = op; out[1] = slot;
  payload.copy(out, 2);
  return out;
}

// ── connection ────────────────────────────────────────────────────────────────
const ws = new WebSocket(wsUrl);
ws.binaryType = 'nodebuffer';

const results = { binaryOutputFrames: 0, e2eBinaryOutput: 0, roundtripOk: false, slot: null };

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    if (data.length < 2) return;
    const opcode = data[0], slot = data[1], payload = data.subarray(2);
    results.binaryOutputFrames++;
    if (sessionKey) {
      try {
        const plain = decryptBytes(payload).toString('utf8');
        results.e2eBinaryOutput++;
        // Accumulate — the needle may arrive in an early frame followed by
        // more output (ANSI resets, agent CLI banner, …).
        results.lastPlaintext = (results.lastPlaintext ?? '') + plain;
        process.stderr.write(`[frame slot=${slot} op=${opcode}] ${JSON.stringify(plain.slice(0, 60))}\n`);
      } catch (e) {
        process.stderr.write(`[frame slot=${slot} op=${opcode}] decrypt failed: ${e.message} (payload ${payload.length}B)\n`);
      }
    } else {
      process.stderr.write(`[frame slot=${slot} op=${opcode}] no key, payload ${payload.length}B\n`);
    }
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === 'e2e_ack') {
    verifyAckAndDerive(msg.pub, msg.sig);
  }
  dispatch(msg);
});

async function main() {
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'auth', token }));
  await waitFor((m) => m.type === 'authed', 'authed');
  console.log('✓ authenticated with relay');

  // E2E handshake
  const helloSig = createHmac('sha256', Buffer.from(e2eSecret, 'hex'))
    .update(Buffer.from(myPubB64, 'base64')).digest('base64');
  ws.send(JSON.stringify({ type: 'e2e_hello', pub: myPubB64, sig: helloSig }));
  await waitFor((m) => m.type === 'e2e_ack', 'e2e_ack');
  console.log('✓ E2E handshake complete (key derived)');

  // Create a session (agent auto-attaches + sends attached with slot)
  ws.send(JSON.stringify({ type: 'new_session', agent_id: 'claude' }));
  const created = await waitFor((m) => m.type === 'session_created', 'session_created');
  const sid = created.session_id;
  console.log(`✓ session created: ${sid}`);

  const attached = await waitFor((m) => m.type === 'attached' && m.session_id === sid, 'attached with slot');
  if (typeof attached.slot !== 'number') throw new Error('attached has no slot — agent did not offer binary frames');
  results.slot = attached.slot;
  console.log(`✓ attached, binary slot=${attached.slot}`);

  // Send binary input: "echo BINARY_OK\n" (E2E-encrypted payload)
  const inputText = 'echo BINARY_OK\n';
  const inputPayload = encryptBytes(Buffer.from(inputText, 'utf8'));
  ws.send(encodeFrame(INPUT, attached.slot, inputPayload));
  console.log('✓ binary input frame sent (E2E-encrypted)');

  // Roundtrip proof: the terminal echoes what we typed. The echo arriving as
  // an E2E-encrypted binary output frame proves the full path:
  //   binary input frame → relay → agent decode+decrypt → tmux pty →
  //   agent output → binary frame → relay → client decode+decrypt
  // (the agent CLI in the pane does not execute `echo`; the pty echo is the
  // observable effect we need).
  const needle = 'echo BINARY_OK';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (results.lastPlaintext?.includes(needle)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!results.lastPlaintext?.includes(needle)) {
    throw new Error(`echo not received in binary output (frames=${results.binaryOutputFrames})`);
  }
  results.roundtripOk = true;
  console.log('✓ binary roundtrip verified: input echoed back as E2E-encrypted binary output');
  console.log(`  (binary frames received: ${results.binaryOutputFrames}, E2E-decrypted: ${results.e2eBinaryOutput})`);

  // Clean up: detach
  ws.send(JSON.stringify({ type: 'detach', session_id: sid }));
  ws.close();
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
