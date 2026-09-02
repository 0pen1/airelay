#!/usr/bin/env node
import { Command } from 'commander';
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
  .action((opts) => {
    const port = parseInt(opts.port, 10);
    createRelayServer(port);
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
  .action((hostId) => {
    revokeHost(hostId);
    console.log(`Revoked host: ${hostId}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
