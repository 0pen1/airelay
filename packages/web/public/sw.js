// airelay service worker: Web Push display + offline shell.
//
// Push payloads are metadata only (relay is zero-knowledge about terminal
// content): { title, body }. Showing them verbatim leaks nothing.

self.addEventListener('install', (_event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'airelay', body: 'Your agent has an update' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch { /* malformed payload — show the generic message */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon.ico',
      tag: 'airelay-push',
      data: { url: '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(event.notification.data?.url ?? '/');
    }),
  );
});
