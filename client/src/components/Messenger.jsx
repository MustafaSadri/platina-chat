import { useEffect } from 'react';
import { useStore } from '../lib/store.js';
import Sidebar from './Sidebar.jsx';
import ChatView from './ChatView.jsx';
import ChatInfo from './ChatInfo.jsx';
import CallOverlay from './CallOverlay.jsx';
import Modals from './Modals.jsx';
import Icon from './Icons.jsx';
import { useT } from '../lib/i18n.js';

export default function Messenger() {
  const t = useT();
  const activeChatId = useStore((s) => s.activeChatId);
  const infoOpen = useStore((s) => s.infoOpen);
  const toast = useStore((s) => s.toast);
  const connected = useStore((s) => s.connected);
  const booted = useStore((s) => s.booted);

  // Mobile back button / Escape closes the open chat.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const s = useStore.getState();
      if (s.modal) s.closeModal();
      else if (s.infoOpen) useStore.setState({ infoOpen: false });
      else if (s.replyTo || s.editing) useStore.setState({ replyTo: null, editing: null });
      else if (s.activeChatId) s.openChat(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`layout ${activeChatId ? 'has-chat' : ''} ${infoOpen && activeChatId ? 'has-info' : ''}`}>
      <Sidebar />
      <main className="chat-pane">
        {activeChatId ? <ChatView key={activeChatId} chatId={activeChatId} /> : (
          <div className="empty-chat">
            <span className="pill">{t(booted ? 'Select a chat to start messaging' : 'Loading…')}</span>
          </div>
        )}
      </main>
      {infoOpen && activeChatId && <ChatInfo chatId={activeChatId} />}
      {!connected && booted && <div className="conn-banner"><span className="spinner small" /> {t('Connecting…')}</div>}
      <CallOverlay />
      <Modals />
      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.kind === 'error' && <Icon name="alert" size={18} />} {toast.text}
        </div>
      )}
    </div>
  );
}
