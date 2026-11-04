import { useStore } from './store.js';
import { messagePreview } from './format.js';
import * as api from './api.js';
import { t } from './i18n.js';

let audioCtx = null;

/** Short two-tone chime generated with WebAudio (no asset needed). */
export function playChime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.3);
    });
  } catch { /* audio unavailable */ }
}

export function notifyMessage(m) {
  const s = useStore.getState();
  const chat = s.chats[m.chatId];
  if (!chat || chat.muted || m.type === 'system') return;
  const viewing = s.activeChatId === m.chatId && document.visibilityState === 'visible' && document.hasFocus();
  if (viewing) return;
  playChime();
  // With Web Push on, the server notifies hidden devices; showing one here too would double up.
  if (s.config.vapidPublicKey || turnedOff()) return;
  if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
  const sender = s.users[m.senderId]?.displayName || t('New message');
  const title = chat.type === 'group' ? chat.title : sender;
  const body = chat.type === 'group' ? `${sender}: ${messagePreview(m, s.users)}` : messagePreview(m, s.users);
  navigator.serviceWorker?.getRegistration().then((reg) => {
    const opts = { body, tag: `chat-${m.chatId}`, icon: '/icon-192.png', data: { chatId: m.chatId }, renotify: true };
    if (reg) reg.showNotification(title, opts);
    else new Notification(title, opts).onclick = () => { window.focus(); s.openChat(m.chatId); };
  }).catch(() => {});
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export const notificationsSupported = () => 'Notification' in window && 'serviceWorker' in navigator;

export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Remembers an explicit "off" on this device, which would otherwise be undone on the next app start.
const OFF_KEY = 'notifications-off';
function turnedOff() {
  try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; }
}
function setTurnedOff(off) {
  try { if (off) localStorage.setItem(OFF_KEY, '1'); else localStorage.removeItem(OFF_KEY); } catch { /* private mode */ }
}

/** on | local (only while the app is open) | off | blocked | install (iPhone, not on Home Screen) | unsupported */
export async function notificationStatus() {
  if (isIos() && !isInstalled()) return 'install';
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted' || turnedOff()) return 'off';
  const key = useStore.getState().config.vapidPublicKey;
  if (!key || !('PushManager' in window)) return 'local';
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
}

/** Asks permission and registers a Web Push subscription when the server has VAPID keys. */
export async function enableNotifications() {
  if (!notificationsSupported()) throw new Error(t('Notifications are not supported in this browser. On iPhone, add the app to the Home Screen first.'));
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(t('Notification permission was not granted.'));
  setTurnedOff(false);
  const key = useStore.getState().config.vapidPublicKey;
  if (!key || !('PushManager' in window)) return 'local';
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  await api.post('/push/subscribe', sub.toJSON());
  return 'push';
}

export async function refreshPushSubscription() {
  if (!notificationsSupported() || Notification.permission !== 'granted' || turnedOff()) return;
  try { await enableNotifications(); } catch { /* ignore */ }
}

export async function disableNotifications() {
  setTurnedOff(true);
  await unsubscribePush();
}

export async function unsubscribePush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* ignore */ }
}
