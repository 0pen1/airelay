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

export interface SessionCreatedMsg {
  type: 'session_created';
  session_id: string;
  agent_id: string;
}

export interface AttachedMsg {
  type: 'attached';
  session_id: string;
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
}

export interface ErrorMsg {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type AgentToClientMsg =
  | AgentTypesMsg
  | SessionsListMsg
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
