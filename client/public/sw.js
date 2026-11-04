// Service worker: Web Push notifications and notification clicks.
// API responses are never cached (chat data is private and must stay fresh).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'TeamChat', body: event.data?.text() }; }
  event.waitUntil((async () => {
    // Always show something: the server already skips devices with the app on screen, and iPhones
    // cancel the subscription of an app that receives a push without displaying it.
    if (data.clearCalls) {
      const shown = await self.registration.getNotifications();
      shown.filter((n) => n.tag.startsWith('call-')).forEach((n) => n.close());
    }
    const tag = data.tag || `teamchat-${Date.now()}`;
    await self.registration.showNotification(data.title || 'TeamChat', {
      body: data.body || '',
      tag,
      renotify: true,
      requireInteraction: tag.startsWith('call-'),
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
