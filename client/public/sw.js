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
      // Shown on Android and desktop. iPhones don't support notification buttons, so a tap there
      // opens the app on its Accept / Decline screen instead.
      actions: data.type === 'call' ? [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }] : [],
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { chatId: data.chatId, callId: data.callId },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { chatId, callId } = event.notification.data || {};
  if (event.action === 'decline' && callId) {
    event.waitUntil(fetch(`/api/calls/${encodeURIComponent(callId)}/decline`, { method: 'POST', credentials: 'same-origin' }).catch(() => {}));
    return;
  }
  const answerCallId = event.action === 'answer' ? callId : null;
  const url = `/?${new URLSearchParams({ ...(chatId && { chat: chatId }), ...(answerCallId && { answer: answerCallId }) })}`;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        w.postMessage({ type: 'open-chat', chatId, answerCallId });
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
