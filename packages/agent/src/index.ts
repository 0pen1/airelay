#!/usr/bin/env node
import { Command } from 'commander';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { v4 as uuidv4 } from 'uuid';
import { signJwt } from '@airelay/shared';
import { startDaemon } from './daemon.js';
import { install, uninstall, isRunning } from './launchd.js';
import { execSync } from 'node:child_process';
import * as qrcode from 'qrcode-terminal';

const CONFIG_DIR = join(homedir(), '.config', 'airelay');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const AGENTS_FILE = join(CONFIG_DIR, 'agents.json');

interface Config {
  relayUrl: string;
  hostId: string;
  hostSecret: string;
}

function loadConfig(): Config {
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const program = new Command();
program.name('airelay').description('airelay — remote AI agent control').version('0.1.0');

// ── setup ────────────────────────────────────────────────────────────────────
program
  .command('setup')
  .description('Interactive first-time setup')
  .action(async () => {
    const relayUrl = await prompt('Relay URL (e.g. https://your-vps.example.com): ');
    const hostId = uuidv4();
    const hostSecret = randomBytes(32).toString('hex');

    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ relayUrl, hostId, hostSecret }, null, 2));

    // Default agents.json
    if (!existsSync(AGENTS_FILE)) {
      const agents = [
        { id: 'claude', name: 'Claude Code', type: 'pty', command: 'claude', args: [], icon: '🤖' },
        { id: 'codex', name: 'OpenAI Codex', type: 'pty', command: 'codex', args: [], icon: '⚡' },
        { id: 'gemini', name: 'Gemini CLI', type: 'pty', command: 'gemini', args: [], icon: '💎' },
        { id: 'pi', name: 'Pi', type: 'browser', url: 'https://pi.ai', icon: '🌀' },
      ];
      writeFileSync(AGENTS_FILE, JSON.stringify({ agents }, null, 2));
    }

    console.log('\nSetup complete.');
    console.log(`Host ID: ${hostId}`);
    console.log('\nRun this on your VPS to register this machine:');
    console.log(`  airelay-relay register ${hostId} ${hostSecret}`);
    console.log('\nThen start the local daemon:');
    console.log('  airelay agent start');
  });

// ── agent ────────────────────────────────────────────────────────────────────
const agent = program.command('agent').description('Manage the local daemon');

agent
  .command('start')
  .description('Install and start the launchd daemon')
  .action(() => {
    const execPath = process.execPath;
    install(execPath);
  });

agent
  .command('stop')
  .description('Stop and uninstall the launchd daemon')
  .action(() => {
    uninstall();
  });

agent
  .command('status')
  .description('Show daemon status')
  .action(() => {
    const running = isRunning();
    console.log(`Daemon: ${running ? '✅ running' : '❌ stopped'}`);
  });

agent
  .command('reload')
  .description('Reload agents.json config (no restart needed)')
  .action(() => {
    // Find the running daemon process and send it SIGHUP, which triggers an
    // in-place driver re-sync (see daemon.ts). The daemon matches `agent _run`
    // in its command line; this pattern excludes the `reload` process itself.
    let pids: string[] = [];
    try {
      const out = execSync("pgrep -f 'agent _run'", { encoding: 'utf8' });
      pids = out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      // pgrep exits non-zero when nothing matches → no daemon running
    }

    if (pids.length === 0) {
      console.log('No running agent daemon found.');
      console.log('Start it with: airelay agent start');
      return;
    }

    let signaled = 0;
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGHUP');
        signaled++;
      } catch {
        // process may have exited between pgrep and kill — skip it
      }
    }
    console.log(`Reload signal sent to ${signaled} daemon process(es).`);
    console.log('agents.json changes (added/removed agents) are now live.');
  });

// Internal command invoked by launchd plist
agent
  .command('_run')
  .description('Start daemon process (used by launchd)')
  .action(() => {
    startDaemon();
  });

// ── devices ──────────────────────────────────────────────────────────────────
// Manage paired devices (session tokens) via the relay's management API.
// Authenticated with the same HMAC header the daemon uses for its WS.

interface DeviceInfo {
  id: string;
  device_name: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  expired: boolean;
  status: string;
}

async function relayApi(pathname: string, init?: RequestInit): Promise<Response> {
  const config = loadConfig();
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', config.hostSecret).update(`${config.hostId}:${ts}`).digest('hex');
  return fetch(`${config.relayUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `HMAC host_id=${config.hostId}, ts=${ts}, sig=${sig}`,
      ...(init?.headers ?? {}),
    },
  });
}

function formatUnix(ts: number): string {
  return ts > 0 ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) : '—';
}

const devices = program.command('devices').description('Manage paired devices');

devices
  .command('list')
  .description('List devices (session tokens) registered at the relay')
  .action(async () => {
    const res = await relayApi('/api/devices');
    if (!res.ok) {
      console.error(`Relay returned ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const { devices: list } = (await res.json()) as { devices: DeviceInfo[] };
    if (list.length === 0) {
      console.log('No devices. Scan the QR code from `airelay gen-token` to pair one.');
      return;
    }
    console.log('Devices (token prefix — name — status — last used):');
    console.log('─'.repeat(64));
    for (const d of list) {
      const status = d.status === 'revoked' ? 'revoked' : d.expired ? 'expired' : 'active';
      console.log(`  ${d.id}  ${d.device_name.padEnd(20)}  ${status.padEnd(8)}  ${formatUnix(d.last_used_at)}`);
    }
  });

devices
  .command('revoke <id>')
  .description('Revoke a device by its token prefix (see devices list)')
  .action(async (id: string) => {
    const res = await relayApi('/api/devices/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      console.error(`Relay returned ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const { revoked } = (await res.json()) as { revoked: number };
    console.log(revoked > 0 ? `Revoked ${revoked} token(s) with prefix ${id}.` : `No live token matched ${id}.`);
  });

// ── terminal commands (CLI client) ───────────────────────────────────────────
// Talk to sessions on this host (or any host whose config you copy) through
// the relay, with E2E encryption — same protocol as the phone.

const term = program.command('term').description('Interact with agent sessions from the terminal');

term
  .command('ls')
  .description('List sessions')
  .action(async () => {
    const { CliClient } = await import('./cli-client.js');
    const client = new CliClient(loadConfig());
    try {
      await client.connect();
      const sessions = await client.listSessions();
      if (sessions.length === 0) {
        console.log('No sessions. Start one with `airelay term new <agent>`.');
        return;
      }
      console.log('Sessions:');
      console.log('─'.repeat(64));
      for (const s of sessions) {
        const lock = s.locked_by ? ' (in use)' : '';
        const age = Math.max(1, Math.floor((Date.now() / 1000 - s.created_at) / 60));
        console.log(`  ${s.icon} ${s.session_id}  ${s.agent_name}${lock}  ${age}m ago`);
      }
    } finally {
      client.close();
    }
  });

term
  .command('logs <sessionId>')
  .description('Print a session\'s scrollback')
  .action(async (sessionId: string) => {
    const { CliClient } = await import('./cli-client.js');
    const client = new CliClient(loadConfig());
    try {
      await client.connect();
      process.stdout.write(await client.attachWithScrollback(sessionId));
      client.detach(sessionId);
    } finally {
      client.close();
    }
  });

term
  .command('send <sessionId> <text...>')
  .description('Send input to a session (appends Enter unless --no-enter)')
  .option('--no-enter', 'Do not append a newline to the input')
  .action(async (sessionId: string, text: string[], opts: { enter: boolean }) => {
    const { CliClient } = await import('./cli-client.js');
    const client = new CliClient(loadConfig());
    try {
      await client.connect();
      const data = text.join(' ') + (opts.enter ? '\n' : '');
      client.sendInput(sessionId, data);
      // Give the input a moment to flush before closing the socket.
      await new Promise((r) => setTimeout(r, 300));
      console.log('sent.');
    } finally {
      client.close();
    }
  });

term
  .command('follow <sessionId>')
  .description('Stream a session\'s output live (Ctrl-C to stop)')
  .action(async (sessionId: string) => {
    const { CliClient } = await import('./cli-client.js');
    const client = new CliClient(loadConfig());
    try {
      await client.connect();
      // Print existing scrollback first, then follow live output.
      process.stdout.write(await client.attachWithScrollback(sessionId));
      const follow = setInterval(() => {
        const out = client.drainOutput(sessionId);
        if (out) process.stdout.write(out);
      }, 100);
      // Poll the socket; relay output arrives via the message handler.
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => { clearInterval(follow); resolve(); });
      });
      client.detach(sessionId);
      process.stdout.write('\n[detached]\n');
    } finally {
      client.close();
    }
  });

// ── gen-token ─────────────────────────────────────────────────────────────────
program
  .command('gen-token')
  .description('Generate an access token and display QR code')
  .option('--ttl <duration>', 'Token TTL in hours', '24')
  .action(async (opts) => {
    const config = loadConfig();
    const ttlHours = parseFloat(opts.ttl);
    const now = Math.floor(Date.now() / 1000);
    const exp = now + Math.round(ttlHours * 3600);
    const jti = uuidv4();

    const token = await signJwt(config.hostSecret, {
      hostId: config.hostId,
      jti,
      exp,
    });

    // Derive a separate E2E secret from the host secret — used by the phone
    // and agent to authenticate ECDH public keys and prevent relay MITM. We
    // don't give the phone the raw hostSecret (that's the agent↔relay HMAC
    // credential); instead we derive a purpose-specific key.
    const e2eSecret = createHmac('sha256', config.hostSecret)
      .update('airelay-e2e-auth')
      .digest('hex');

    const payload = Buffer.from(
      JSON.stringify({ url: config.relayUrl, host_id: config.hostId, token, e2e_secret: e2eSecret }),
    ).toString('base64url');

    const url = `${config.relayUrl}/#${payload}`;

    console.log(`\nToken valid for ${ttlHours}h (jti: ${jti})\n`);
    qrcode.generate(url, { small: true });
    console.log(`\nOr open: ${url}\n`);
  });

// ── token ─────────────────────────────────────────────────────────────────────
const token = program.command('token').description('Manage access tokens');

token
  .command('list')
  .description('List active tokens (requires relay API)')
  .action(() => {
    console.log('Token listing requires a relay API call. Coming in a future release.');
    console.log('To manage tokens, use the relay host management commands.');
  });

token
  .command('revoke <jti>')
  .description('Revoke a token (requires relay API)')
  .action((_jti) => {
    console.log('Token revocation via CLI requires a relay API call. Coming in a future release.');
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
