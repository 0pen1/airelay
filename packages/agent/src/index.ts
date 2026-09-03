#!/usr/bin/env node
import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
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

    const payload = Buffer.from(
      JSON.stringify({ url: config.relayUrl, host_id: config.hostId, token }),
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
