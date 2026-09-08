// All message types for the airelay protocol.
// Messages flow over WebSocket as JSON text frames.
// The relay transparently forwards them between agent and client.

// ── Client → Agent ────────────────────────────────────────────────────────────

export interface ListAgentTypesMsg {
  type: 'list_agent_types';
}

export interface ListSessionsMsg {
  type: 'list_sessions';
}

export interface NewSessionMsg {
  type: 'new_session';
  agent_id: string;
}

export interface AttachMsg {
  type: 'attach';
  session_id: string;
}

export interface InputMsg {
  type: 'input';
  session_id: string;
  data: string;
}

export interface ResizeMsg {
  type: 'resize';
  session_id: string;
  cols: number;
  rows: number;
}

export interface DetachMsg {
  type: 'detach';
  session_id: string;
}

export type ClientToAgentMsg =
  | ListAgentTypesMsg
  | ListSessionsMsg
  | NewSessionMsg
  | AttachMsg
  | InputMsg
  | ResizeMsg
  | DetachMsg;

// ── Agent → Client ────────────────────────────────────────────────────────────

export interface AgentTypeInfo {
  id: string;
  name: string;
  icon: string;
  available: boolean;
}

export interface AgentTypesMsg {
  type: 'agent_types';
  agents: AgentTypeInfo[];
}

export interface SessionInfo {
  session_id: string;
  agent_id: string;
  agent_name: string;
  icon: string;
  created_at: number;
  locked_by: string | null;
}

export interface SessionsListMsg {
  type: 'sessions_list';
  sessions: SessionInfo[];
}

/** Session activity status — broadcast by the agent whenever a session's
 *  output activity state changes (throttled), and pushed for all sessions
 *  when the client requests the list or attaches. */
export interface SessionStatusMsg {
  type: 'session_status';
  session_id: string;
  running: boolean;        // true = output activity in the last IDLE_THRESHOLD
  last_activity: number;   // unix seconds of last output activity
}

export interface SessionCreatedMsg {
  type: 'session_created';
  session_id: string;
  agent_id: string;
}

export interface AttachedMsg {
  type: 'attached';
  session_id: string;
  /** Binary-frame slot for this session. Omitted = agent is binary-legacy
   *  (all I/O stays on JSON). Present = client may use binary frames. */
  slot?: number;
}

export interface ScrollbackMsg {
  type: 'scrollback';
  session_id: string;
  data: string;
  seq: number;
  done: boolean;
}

export interface OutputMsg {
  type: 'output';
  session_id: string;
  data: string;
}

export interface SessionExitedMsg {
  type: 'session_exited';
  session_id: string;
  code: number;
}

export enum ErrorCode {
  SESSION_OCCUPIED = 'SESSION_OCCUPIED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  AGENT_UNAVAILABLE = 'AGENT_UNAVAILABLE',
  // Relay-side: the client's access token (session_token or JWT) was rejected
  // (expired / invalid / revoked). The relay closes the WS with 4001 right
  // after sending this; the web client keys off the 4001 close code to stop
  // its reconnect loop and prompt a re-scan.
  AUTH_FAILED = 'AUTH_FAILED',
}

export interface ErrorMsg {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type AgentToClientMsg =
  | AgentTypesMsg
  | SessionsListMsg
  | SessionStatusMsg
  | SessionCreatedMsg
  | AttachedMsg
  | ScrollbackMsg
  | OutputMsg
  | SessionExitedMsg
  | ErrorMsg;

// ── Relay control (Agent ↔ Relay, not forwarded to client) ────────────────────

export interface AgentHelloMsg {
  type: 'agent_hello';
  host_id: string;
  version: string;
}

export interface ClientDisconnectedMsg {
  type: 'client_disconnected';
  session_id: string;
}

export interface SessionTokenIssuedMsg {
  type: 'session_token_issued';
  session_token: string;
}

// ── E2E encryption ──────────────────────────────────────────────────────────

/** Encrypted payload (replaces the `data` field when E2E is active). */
export interface E2ePayload {
  v: 1;
  iv: string;   // base64, 12-byte AES-GCM nonce
  ct: string;   // base64, ciphertext || 16-byte GCM auth tag
}

/** Client → Agent: initiate ECDH key exchange. */
export interface E2eHelloMsg {
  type: 'e2e_hello';
  pub: string;  // base64, raw P-256 public key (65 bytes uncompressed)
  sig: string;  // base64, HMAC-SHA256(e2e_secret, pub) — prevents relay MITM
}

/** Agent → Client: complete ECDH key exchange. */
export interface E2eAckMsg {
  type: 'e2e_ack';
  pub: string;
  sig: string;
}

// ── Agent driver config (agents.json) ─────────────────────────────────────────

export interface PtyDriverConfig {
  id: string;
  name: string;
  type: 'pty';
  command: string;
  args: string[];
  icon: string;
}

export interface BrowserDriverConfig {
  id: string;
  name: string;
  type: 'browser';
  url: string;
  icon: string;
}

export type AgentDriverConfig = PtyDriverConfig | BrowserDriverConfig;

export interface AgentsConfig {
  agents: AgentDriverConfig[];
}

// ── Binary frames (terminal I/O hot path) ───────────────────────────────────
//
// Terminal output/input travels as binary WebSocket frames instead of JSON
// text. A frame is: [0]=opcode, [1]=slot, [2..]=payload. The slot maps to a
// session via the `slot` field the agent puts on the `attached` message.
// Payload is raw UTF-8 terminal bytes, or — when E2E is active —
// [iv(12) || ciphertext||tag(16)] exactly like E2ePayload but in binary.

/** Binary frame opcodes for terminal I/O. */
export const BinaryOpcode = {
  OUTPUT: 0x01, // agent → client
  INPUT: 0x02,  // client → agent
} as const;

export interface BinaryFrame {
  opcode: number;
  slot: number;
  payload: Uint8Array;
}

/** Encode a terminal binary frame (2-byte header + payload). */
export function encodeBinaryFrame(opcode: number, slot: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + payload.length);
  out[0] = opcode;
  out[1] = slot;
  out.set(payload, 2);
  return out;
}

/** Decode a terminal binary frame. Returns null if malformed (too short). */
export function decodeBinaryFrame(data: Uint8Array): BinaryFrame | null {
  if (data.length < 2) return null;
  return {
    opcode: data[0],
    slot: data[1],
    payload: data.slice(2),
  };
}
