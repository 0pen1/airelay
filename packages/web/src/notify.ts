// Foreground notification system.
//
// When the page is not visible (user switched tabs, phone locked, etc.)
// and a session produces new output:
//   1. Flash the page title: "🔵 New output — airelay"
//   2. Send a browser Notification (if permission granted)
//
// When the page regains focus, the title resets. Notification permission is
// requested lazily the first time a notification would fire (to avoid the
// intrusive permission prompt on first visit).
//
// Additionally, if the browser supports Web Push, a push subscription is
// registered with the relay so "agent waiting for input" pings reach the
// phone even when this page (and the WebSocket) are closed.

let unreadCount = 0;
let titleInterval: ReturnType<typeof setInterval> | null = null;
const originalTitle = 'airelay';

function isPageVisible(): boolean {
  return document.visibilityState === 'visible';
}

function startTitleFlash(): void {
  if (titleInterval) return;
  let show = true;
  titleInterval = setInterval(() => {
    document.title = show ? `🔵 (${unreadCount}) New output` : originalTitle;
    show = !show;
  }, 1000);
}

function stopTitleFlash(): void {
  if (titleInterval) {
    clearInterval(titleInterval);
    titleInterval = null;
  }
  document.title = originalTitle;
  unreadCount = 0;
}

function sendBrowserNotification(agentName: string, opts: { waiting: boolean }): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification('airelay', {
      body: opts.waiting
        ? `${agentName} is waiting for your input`
        : `${agentName} has new output`,
      icon: '/favicon.ico',
      tag: opts.waiting ? 'airelay-waiting' : 'airelay-output', // collapse per kind
    });
  } else if (Notification.permission === 'default') {
    // Request permission lazily — only when we actually need to notify.
    Notification.requestPermission();
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Call when a session produces output and the user is NOT viewing that session. */
export function notifyNewOutput(agentName: string = 'Agent'): void {
  unreadCount++;
  if (!isPageVisible()) {
    startTitleFlash();
    sendBrowserNotification(agentName, { waiting: false });
  }
}

/** Call when a session transitions to idle (agent finished / needs input). */
export function notifyWaiting(agentName: string = 'Agent'): void {
  unreadCount++;
  // Title flash even when the page is visible on another session — this is a
  // "come back" signal, not just output noise.
  startTitleFlash();
  sendBrowserNotification(agentName, { waiting: true });
}

/** Call when the user is actively viewing a session (clear unread state). */
export function clearNotifications(): void {
  stopTitleFlash();
}

// ── Web Push subscription ────────────────────────────────────────────────────
// Registered after the WS is authed (needs a valid session token for the
// relay's subscribe endpoint). Best-effort: failures are silent, foreground
// notifications still work.

const PUSH_SUB_KEY = 'airelay_push_subscribed';

function relayOrigin(): string {
  // The relay serves this page, so same-origin covers the API too.
  return location.origin;
}

function sessionToken(): string {
  return localStorage.getItem('airelay_session_token') ?? '';
}

export async function setupPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (typeof Notification === 'undefined') return;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const reg = await navigator.serviceWorker.register('/sw.js');
    const keyRes = await fetch(`${relayOrigin()}/api/push/key`);
    if (!keyRes.ok) return;
    const { publicKey } = (await keyRes.json()) as { publicKey: string };

    // Reuse an existing subscription if we already registered one.
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey),
      });
    }
    const subJson = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
    const res = await fetch(`${relayOrigin()}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken()}` },
      body: JSON.stringify({ subscription: subJson }),
    });
    if (res.ok) localStorage.setItem(PUSH_SUB_KEY, '1');
  } catch {
    // Push is an enhancement — never break the app over it.
  }
}

function urlB64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Auto-clear when the page regains visibility
document.addEventListener('visibilitychange', () => {
  if (isPageVisible()) {
    stopTitleFlash();
  }
});
