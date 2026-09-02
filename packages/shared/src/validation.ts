/** UUID v4 regex check — used to validate session_id in all incoming messages */
export function validateSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/** agent_id: alphanumeric + hyphen, 1-32 chars */
export function validateAgentId(id: string): boolean {
  return /^[a-zA-Z0-9-]{1,32}$/.test(id);
}
