# Deployment

Production deployment guide for airelay. The typical topology:

```
Phone (any browser) ──WSS──► VPS: relay ──WSS──► Home Mac: agent daemon ──► tmux ──► CLI agents
```

- **Relay** runs on a public VPS (Debian/Ubuntu assumed). It is zero-knowledge:
  it forwards ciphertext and never holds decryption keys.
- **Agent** runs on the machine with your dev environment (macOS via launchd,
  Linux via systemd — both covered below).

Other docs: [architecture](architecture.md) · [security](security.md) ·
[development](development.md)

## Table of contents

- [1. Relay on a VPS](#1-relay-on-a-vps)
- [2. TLS reverse proxy (WSS)](#2-tls-reverse-proxy-wss)
- [3. Firewall](#3-firewall)
- [4. systemd units](#4-systemd-units)
- [5. Production hardening checklist](#5-production-hardening-checklist)
- [6. Upgrades and backups](#6-upgrades-and-backups)
- [7. macOS agent via launchd](#7-macos-agent-via-launchd)

---

## 1. Relay on a VPS

### Prerequisites

- Node.js **22.5+** (`node:sqlite` requirement). On Debian/Ubuntu:

  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

- A non-root user for the service (examples use `airelay`).

### Build and install

```bash
git clone https://github.com/0pen1/airelay.git /opt/airelay
cd /opt/airelay
npm install -g pnpm@9
pnpm install --frozen-lockfile
pnpm build
```

### Initialize

```bash
sudo -u airelay airelay-relay init                       # creates the SQLite DB
sudo -u airelay airelay-relay register <host_id> <host_secret> home-mac
```

`host_id` / `host_secret` come from the agent machine's
`airelay setup` output (or `~/.config/airelay/config.json`).

### Run manually (smoke test)

```bash
sudo -u airelay node /opt/airelay/packages/relay/dist/index.js start --port 3000
curl -s http://127.0.0.1:3000/health
# {"ok":true,"agents":0,"clients":0}
```

> The relay binds `127.0.0.1` only. Public traffic goes through the TLS
> proxy (next section) — never expose port 3000 directly.

## 2. TLS reverse proxy (WSS)

Browsers require `wss://` (TLS). Any proxy that forwards WebSocket upgrades
works. Pick one:

### Caddy (recommended — automatic certificates)

```caddy
# /etc/caddy/Caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

That's it — Caddy handles ACME, HTTP→HTTPS redirect, and WebSocket
upgrade pass-through automatically.

### nginx

```nginx
# /etc/nginx/sites-available/airelay
server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket upgrade
        proxy_set_header Connection "upgrade";        # ← required for WS
        proxy_set_header Host $host;
        proxy_read_timeout 300s;                      # idle WS connections
        proxy_send_timeout 300s;
    }
}
```

Certificates via certbot:

```bash
sudo certbot --nginx -d relay.example.com
```

> **Idle timeouts**: keep `proxy_read_timeout` well above the agent's
> 30s heartbeat interval (agent pings the relay every 30s), or the proxy
> will kill idle connections.

## 3. Firewall

Only 80/443 (proxy) and SSH should be reachable:

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Port 3000 stays loopback-only (the relay binds `127.0.0.1` anyway).

## 4. systemd units

### Relay (`/etc/systemd/system/airelay-relay.service`)

```ini
[Unit]
Description=airelay relay (zero-knowledge WebSocket router)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=airelay
WorkingDirectory=/opt/airelay/packages/relay
ExecStart=/usr/bin/node dist/index.js start --port 3000
Restart=on-failure
RestartSec=3

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/airelay/.config/airelay
Environment=NODE_ENV=production

# Graceful shutdown: notify peers, close sockets (see server.ts shutdown()).
# Well under systemd's default TimeoutStopSec=90s.
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

### Agent on a Linux box (`/etc/systemd/system/airelay-agent.service`)

(If your dev machine is a Mac, skip to [launchd](#7-macos-agent-via-launchd).)

```ini
[Unit]
Description=airelay agent daemon (session manager)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOURUSER
WorkingDirectory=/opt/airelay/packages/agent
ExecStart=/usr/bin/node dist/index.js agent _run
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
# tmux must be on PATH for the agent's pty driver:
Environment=PATH=/usr/local/bin:/usr/bin:/bin

KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` + `RestartSec=3` is the crash-recovery story: the
agent daemon exits non-zero on crash, systemd restarts it, and
`restore()` re-attaches to surviving tmux sessions automatically.

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now airelay-relay
systemctl status airelay-relay
journalctl -u airelay-relay -f          # live logs (incl. [AUDIT] lines)
```

## 5. Production hardening checklist

- [ ] **Metrics token**: set `AIRELAY_METRICS_TOKEN=<random-hex>` in the
      relay's environment (systemd `Environment=` line or an
      `EnvironmentFile=`). Without it, `/metrics` is loopback-only — which
      the nginx/Caddy proxy bypasses, so on a public deployment **always
      set the token**:

      ```bash
      curl -s -H "Authorization: Bearer $TOKEN" https://relay.example.com/metrics
      ```

- [ ] **Rate limiting** is built in (auth per-IP 30/min with failure
      penalty; 200 msg/s per connection) — no proxy configuration needed.
- [ ] **TLS**: HSTS recommended once certs are stable
      (`header Strict-Transport-Security "max-age=31536000"`).
- [ ] **DB backups** (see below) — the DB holds host secrets and device
      tokens; back it up like a credential store.
- [ ] **JTI/grace sweeps** run hourly in-process; no cron needed.
- [ ] Rotate `host_secret` by re-registering the host if a machine is
      decommissioned: `airelay-relay revoke-host <host_id>`.

## 6. Upgrades and backups

### Backup

Everything that matters lives in one directory (default
`~/.config/airelay/` on both relay and agent — override with
`AIRELAY_CONFIG_DIR`):

```
relay.db            # hosts, device tokens, push subscriptions, jti
vapid-keys.json     # Web Push identity — losing it breaks existing subscriptions
```

```bash
# relay, from cron or a systemd timer:
sqlite3 ~/.config/airelay/relay.db ".backup '/var/backups/airelay/relay-$(date +%F).db'"
```

### Upgrade

```bash
cd /opt/airelay
sudo -u airelay git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart airelay-relay      # graceful: notifies connected clients
```

The agent side is even simpler — tmux sessions survive daemon restarts by
design:

```bash
sudo systemctl restart airelay-agent      # or: brew services / launchd kickstart on macOS
```

After a relay restart, agents reconnect automatically (exponential backoff,
1s → 60s) and clients' session tokens keep working.

## 7. macOS agent via launchd

`airelay agent start` installs a launchd plist with KeepAlive:

```bash
airelay agent start      # install + boot-start
airelay agent status     # running?
airelay agent reload     # SIGHUP → re-read agents.json without restart
airelay agent stop       # uninstall
```

Logs land in `~/.config/airelay/airelay.log` / `agent.err.log` (the daemon
writes timestamped stderr lines; terminal I/O never appears — E2E stays
intact).
