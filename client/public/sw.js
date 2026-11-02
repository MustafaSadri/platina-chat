// Service worker: Web Push notifications and notification clicks.
// API responses are never cached (chat data is private and must stay fresh).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'TeamChat', body: event.data?.text() }; }
  event.waitUntil((async () => {
    // Skip if the app is focused; the page shows its own in-app notification.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'TeamChat', {
      body: data.body || '',
      tag: data.tag,
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { chatId: data.chatId },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatId = event.notification.data?.chatId;
  const url = chatId ? `/?chat=${chatId}` : '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        w.postMessage({ type: 'open-chat', chatId });
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
