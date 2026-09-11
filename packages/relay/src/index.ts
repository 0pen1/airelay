#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { createRelayServer } from './server.js';
import {
  registerHost, listHosts, revokeHost, getDb,
} from './db.js';

const program = new Command();
program.name('airelay-relay').description('airelay relay server').version('0.1.0');

program
  .command('init')
  .description('Initialize relay database and configuration')
  .action(() => {
    getDb(); // triggers schema creation
    console.log('Relay database initialized.');
    console.log('Next steps:');
    console.log('  1. Register your Mac: airelay-relay register <host_id> <host_secret>');
    console.log('  2. Start the relay:   airelay-relay start');
  });

program
  .command('start')
  .description('Start the relay server')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const relay = createRelayServer(port);
    // Record the listening port so sibling CLI commands (revoke-host kick)
    // can find the running server without guessing. Best-effort only.
    try {
      const { writeFileSync } = await import('node:fs');
      const { getDbPath } = await import('./db.js');
      writeFileSync(join(getDbPath(), '..', 'relay.port'), String(port));
    } catch { /* non-fatal */ }

    // Graceful shutdown on SIGTERM (systemd stop) and SIGINT (Ctrl-C):
    // notify peers, close sockets, exit. systemd's default TimeoutStopSec
    // (90s) is far beyond what this needs.
    let shuttingDown = false;
    const stop = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${signal} received — shutting down gracefully…`);
      await relay.shutdown();
      console.log('bye');
      process.exit(0);
    };
    process.on('SIGTERM', () => void stop('SIGTERM'));
    process.on('SIGINT', () => void stop('SIGINT'));
  });

program
  .command('register <hostId> <hostSecret>')
  .description('Register a new host agent')
  .option('-n, --name <name>', 'Human-readable name for this host', '')
  .action((hostId, hostSecret, opts) => {
    registerHost(hostId, hostSecret, opts.name);
    console.log(`Registered host: ${hostId}${opts.name ? ` (${opts.name})` : ''}`);
  });

program
  .command('hosts')
  .description('List all registered host agents')
  .action(() => {
    const hosts = listHosts();
    if (hosts.length === 0) {
      console.log('No hosts registered.');
      return;
    }
    console.log('Registered hosts:');
    console.log('─'.repeat(72));
    for (const h of hosts) {
      const date = new Date(h.created_at * 1000).toISOString();
      console.log(`  ${h.host_id}  ${(h.name || '(unnamed)').padEnd(20)}  ${date}`);
    }
  });

program
  .command('revoke-host <hostId>')
  .description('Revoke a host agent (all its tokens become invalid)')
  .action(async (hostId) => {
    revokeHost(hostId);
    console.log(`Revoked host: ${hostId}`);
    // Tell the running relay (if any) to drop this host's live sockets.
    // Optional: works when AIRELAY_ADMIN_TOKEN matches the server's env.
    // Port: read relay.port (written by `start`), env override, else 3000.
    const adminToken = process.env.AIRELAY_ADMIN_TOKEN;
    if (adminToken) {
      let port = 3000;
      try {
        const { readFileSync } = await import('node:fs');
        const { getDbPath } = await import('./db.js');
        port = parseInt(readFileSync(join(getDbPath(), '..', 'relay.port'), 'utf8').trim(), 10) || 3000;
      } catch { /* fall back to default */ }
      if (process.env.AIRELAY_RELAY_PORT) port = parseInt(process.env.AIRELAY_RELAY_PORT, 10);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/admin/kick-host`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ host_id: hostId }),
        });
        if (res.ok) {
          const { agent_was_connected, clients_kicked } = (await res.json()) as {
            agent_was_connected: boolean; clients_kicked: number;
          };
          console.log(`Live connections dropped (agent was ${agent_was_connected ? 'online — kicked' : 'offline'}, ${clients_kicked} client(s) kicked).`);
        } else {
          console.log(`Note: relay kick failed (HTTP ${res.status}) — live sockets drop on next reconnect.`);
        }
      } catch {
        console.log('Note: relay not reachable for live kick — sockets drop on next reconnect.');
      }
    } else {
      console.log('Note: set AIRELAY_ADMIN_TOKEN (same value on the relay) to drop live connections immediately.');
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
