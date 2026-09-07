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

function sendBrowserNotification(agentName: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification('airelay', {
      body: `${agentName} has new output`,
      icon: '/favicon.ico',
      tag: 'airelay-output', // collapse multiple notifications
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
    sendBrowserNotification(agentName);
  }
}

/** Call when the user is actively viewing a session (clear unread state). */
export function clearNotifications(): void {
  stopTitleFlash();
}

// Auto-clear when the page regains visibility
document.addEventListener('visibilitychange', () => {
  if (isPageVisible()) {
    stopTitleFlash();
  }
});
