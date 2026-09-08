// VAPID Web Push: deliver "your agent needs you" notifications to the phone
// even when the browser (and thus the WebSocket) is closed.
//
// Zero-knowledge posture: push payloads carry host/device metadata only —
// never terminal content. The subscription endpoint URLs (which the browser
// push service requires) are stored server-side and are useless without the
// per-subscription encryption keys, which also live here (standard web-push).
//
// VAPID keys are generated once per relay and stored next to the DB.

import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

let vapidKeys: { publicKey: string; privateKey: string } | null = null;
let configured = false;

function keysPath(): string {
  // Same directory as the relay DB (mirror of db.ts getDbPath).
  const isRoot = process.getuid?.() === 0;
  const dir = isRoot ? '/etc/airelay' : join(process.env.HOME ?? '', '.config', 'airelay');
  return join(dir, 'vapid-keys.json');
}

/** Load (or create) the relay's VAPID keypair. Safe to call repeatedly. */
function ensureKeys(): { publicKey: string; privateKey: string } {
  if (vapidKeys) return vapidKeys;
  const p = keysPath();
  if (existsSync(p)) {
    vapidKeys = JSON.parse(readFileSync(p, 'utf8'));
    return vapidKeys!;
  }
  vapidKeys = webpush.generateVAPIDKeys();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(vapidKeys, null, 2));
  return vapidKeys;
}

/** Initialize web-push with the relay's VAPID identity. */
export function initPush(): void {
  if (configured) return;
  const keys = ensureKeys();
  webpush.setVapidDetails('mailto:relay@airelay.local', keys.publicKey, keys.privateKey);
  configured = true;
}

export function getVapidPublicKey(): string {
  return ensureKeys().publicKey;
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Send a notification. Throws on delivery failure (caller decides whether
 *  to drop the subscription, e.g. on 404/410 from the push service). */
export async function sendPush(
  sub: PushSubscription,
  payload: { title: string; body: string },
): Promise<void> {
  initPush();
  await webpush.sendNotification(sub, JSON.stringify(payload), {
    // Short TTL: a stale "agent is waiting" ping is worthless.
    TTL: 60,
  });
}
