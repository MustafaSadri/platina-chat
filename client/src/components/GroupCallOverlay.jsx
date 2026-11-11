import { useEffect, useRef, useState } from 'react';
import { acceptGroupCall, declineGroupCall, leaveGroupCall, toggleGroupCam, toggleGroupMic, toggleGroupSpeaker, useGroupCall } from '../lib/groupCall.js';
import { canSwitchSpeaker } from '../lib/audioRoute.js';
import { duration } from '../lib/format.js';
import { useStore } from '../lib/store.js';
import { useT } from '../lib/i18n.js';
import Avatar from './Avatar.jsx';
import Icon from './Icons.jsx';

function PeerAudio({ stream }) {
  const ref = useRef();
  useEffect(() => {
    if (!ref.current || !stream) return;
    ref.current.srcObject = stream;
    ref.current.play().catch(() => {});
  }, [stream]);
  return <audio ref={ref} className="call-audio" autoPlay />;
}

function Video({ stream, className }) {
  const ref = useRef();
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  });
  return <video ref={ref} autoPlay playsInline muted className={className} />;
}

function Tile({ user, stream, showVideo, label, waiting }) {
  return (
    <div className="group-tile">
      {showVideo
        ? <Video stream={stream} className="group-video" />
        : <Avatar name={user?.displayName} color={user?.avatarColor} src={user?.avatarUrl} size={72} />}
      <span className="group-tile-name">{label}{waiting ? ' · …' : ''}</span>
    </div>
  );
}

const hasLiveVideo = (stream) => !!stream?.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted);

export default function GroupCallOverlay() {
  const t = useT();
  const call = useGroupCall();
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me);
  const [minimized, setMinimized] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (call.status !== 'active') {
      setMinimized(false);
      return undefined;
    }
    const timer = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [call.status]);

  if (call.status === 'idle') return null;

  if (call.status === 'ringing') {
    return (
      <div className="call-overlay group-ringing">
        <div className="call-top" />
        <div className="call-center">
          <div className="pulse"><Avatar name={call.title} color={call.chatId % 8} size={120} group /></div>
          <div className="call-name">{call.title}</div>
          <div className="call-status">{call.from?.displayName} · {t(call.video ? 'Group video call' : 'Group call')}</div>
        </div>
        <div className="call-controls">
          <div className="call-ctl"><button className="round red" onClick={declineGroupCall} aria-label="Decline"><Icon name="hangup" size={28} /></button><span>{t('Decline')}</span></div>
          <div className="call-ctl"><button className="round green" onClick={acceptGroupCall} aria-label="Accept"><Icon name={call.video ? 'video' : 'phone'} size={28} /></button><span>{t('Accept')}</span></div>
        </div>
      </div>
    );
  }

  const peers = Object.entries(call.peers);
  const count = peers.length + 1;
  const status = call.status === 'joining' ? t('Connecting…')
    : call.startedAt ? duration((Date.now() - call.startedAt) / 1000)
      : t('Waiting for others to join…');
  const camOn = !!call.localStream?.getVideoTracks().length && !call.camOff;

  // Audio stays mounted in one place so minimizing never silences anyone.
  const audio = peers.map(([id, p]) => p.stream && <PeerAudio key={id} stream={p.stream} />);

  if (minimized) {
    return (
      <>
        {audio}
        <button className="call-mini" onClick={() => setMinimized(false)}>
          <Icon name="users" size={18} /> {call.title} · {status}
        </button>
      </>
    );
  }

  return (
    <>
      {audio}
      <div className="call-overlay group-call">
        <div className="group-header">
          <button className="icon-btn light" onClick={() => setMinimized(true)} aria-label="Minimize"><Icon name="back" className="rot-270" /></button>
          <div className="group-header-text">
            <div className="strong ellipsis">{call.title}</div>
            <div className="call-status small">{t('{n} in the call', { n: count })} · {status}</div>
          </div>
        </div>
        <div className={`group-grid count-${Math.min(count, 9)}`}>
          <Tile user={me} stream={call.localStream} showVideo={camOn} label={t('You')} />
          {peers.map(([id, p]) => (
            <Tile key={id} user={users[id]} stream={p.stream} showVideo={hasLiveVideo(p.stream)} label={users[id]?.displayName || '…'} waiting={!p.connected} />
          ))}
        </div>
        <div className="call-controls">
          <div className="call-ctl"><button className={`round ${camOn ? 'on' : ''}`} onClick={toggleGroupCam} disabled={call.status !== 'active'} aria-label="Camera"><Icon name={camOn ? 'video' : 'videoOff'} size={26} /></button><span>{t('Camera')}</span></div>
          {canSwitchSpeaker() && <div className="call-ctl"><button className={`round ${call.speaker ? 'on' : ''}`} onClick={toggleGroupSpeaker} aria-label="Speaker"><Icon name="speaker" size={26} /></button><span>{t(call.speaker ? 'Speaker' : 'Earpiece')}</span></div>}
          <div className="call-ctl"><button className={`round ${call.micOff ? '' : 'on'}`} onClick={toggleGroupMic} aria-label="Microphone"><Icon name={call.micOff ? 'micOff' : 'mic'} size={26} /></button><span>{t(call.micOff ? 'Unmute_mic' : 'Mute_mic')}</span></div>
          <div className="call-ctl"><button className="round red" onClick={leaveGroupCall} aria-label="End call"><Icon name="hangup" size={28} /></button><span>{t('Leave')}</span></div>
        </div>
      </div>
    </>
  );
}
