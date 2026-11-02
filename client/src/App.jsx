import { useEffect, useState } from 'react';
import * as api from './lib/api.js';
import { useStore } from './lib/store.js';
import { connectSocket, disconnectSocket } from './lib/socket.js';
import { refreshPushSubscription } from './lib/notify.js';
import { Login, ChangePassword } from './components/Auth.jsx';
import Messenger from './components/Messenger.jsx';

function useThemeClass() {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#17212b' : '#517da2');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

export default function App() {
  useThemeClass();
  const me = useStore((s) => s.me);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api.setUnauthorizedHandler(() => {
      disconnectSocket();
      useStore.setState({ me: null, booted: false, chats: {}, messages: {}, activeChatId: null });
    });
    api.get('/auth/me')
      .then(({ user }) => useStore.getState().setMe(user))
      .catch(() => {})
      .finally(() => setChecking(false));
    const onMeUpdated = () => api.get('/auth/me').then(({ user }) => useStore.getState().setMe(user)).catch(() => {});
    window.addEventListener('me-updated', onMeUpdated);
    return () => window.removeEventListener('me-updated', onMeUpdated);
  }, []);

  const ready = me && !me.mustChangePassword;
  useEffect(() => {
    if (!ready) return;
    const s = useStore.getState();
    s.loadAll()
      .then(() => {
        const chatId = Number(new URLSearchParams(window.location.search).get('chat'));
        if (chatId && useStore.getState().chats[chatId]) useStore.getState().openChat(chatId);
      })
      .catch((err) => s.showToast(err.message, 'error'));
    connectSocket();
    refreshPushSubscription();
    const onSwMessage = (e) => e.data?.type === 'open-chat' && e.data.chatId && useStore.getState().openChat(e.data.chatId);
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onSwMessage);
  }, [ready]);

  if (checking) return <div className="splash"><div className="spinner" /></div>;
  if (!me) return <Login />;
  if (me.mustChangePassword) return <ChangePassword forced />;
  return <Messenger />;
}
