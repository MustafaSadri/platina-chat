import { useEffect, useRef, useState } from 'react';
import { acceptCall, declineCall, hangUp, toggleCam, toggleMic, useCall } from '../lib/call.js';
import { duration } from '../lib/format.js';
import Avatar from './Avatar.jsx';
import Icon from './Icons.jsx';
import { useT } from '../lib/i18n.js';

function Video({ stream, muted, className }) {
  const ref = useRef();
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null;
  });
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

export default function CallOverlay() {
  const t = useT();
  const call = useCall();
  const [, tick] = useState(0);
  const [minimized, setMinimized] = useState(false);
  const remoteAudio = useRef();

  useEffect(() => {
    if (call.status !== 'active') return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [call.status]);

  useEffect(() => {
    if (remoteAudio.current && call.remoteStream) {
      remoteAudio.current.srcObject = call.remoteStream;
      remoteAudio.current.play().catch(() => {});
    }
  }, [call.remoteStream]);

  useEffect(() => { if (call.status === 'idle') setMinimized(false); }, [call.status]);

  if (call.status === 'idle') return null;
  const peer = call.peer || {};
  const remoteHasVideo = call.remoteStream?.getVideoTracks().some((t) => t.readyState === 'live');
  const statusText = {
    outgoing: t('Ringing…'),
    incoming: t(call.video ? 'Incoming video call' : 'Incoming call'),
    connecting: t('Connecting…'),
    active: call.startedAt ? duration((Date.now() - call.startedAt) / 1000) : '',
  }[call.status];

  // The audio element stays mounted in one place: a new element would have no stream and go silent.
  const audio = <audio ref={remoteAudio} className="call-audio" autoPlay />;

  if (minimized) {
    return (
      <>
        {audio}
        <button className="call-mini" onClick={() => setMinimized(false)}>
          <Icon name="phone" size={18} /> {peer.displayName} · {statusText}
        </button>
      </>
    );
  }

  return (
    <>
    {audio}
    <div className={`call-overlay ${call.video || remoteHasVideo ? 'video' : ''}`}>
      {remoteHasVideo && <Video stream={call.remoteStream} muted className="remote-video" />}
      {call.video && call.localStream && !call.camOff && <Video stream={call.localStream} muted className="local-video" />}
      <div className="call-top">
        {call.status !== 'incoming' && (
          <button className="icon-btn light" onClick={() => setMinimized(true)} aria-label="Minimize"><Icon name="back" className="rot-270" /></button>
        )}
      </div>
      {!remoteHasVideo && (
        <div className="call-center">
          <div className={call.status === 'incoming' || call.status === 'outgoing' ? 'pulse' : ''}>
            <Avatar name={peer.displayName} color={peer.avatarColor} size={120} />
          </div>
          <div className="call-name">{peer.displayName}</div>
          <div className="call-status">{statusText}</div>
        </div>
      )}
      {remoteHasVideo && <div className="call-caption"><b>{peer.displayName}</b> · {statusText}</div>}
      <div className="call-controls">
        {call.status === 'incoming' ? (
          <>
            <div className="call-ctl"><button className="round red" onClick={declineCall} aria-label="Decline"><Icon name="hangup" size={28} /></button><span>{t('Decline')}</span></div>
            <div className="call-ctl"><button className="round green" onClick={acceptCall} aria-label="Accept"><Icon name={call.video ? 'video' : 'phone'} size={28} /></button><span>{t('Accept')}</span></div>
          </>
        ) : (
          <>
            <div className="call-ctl"><button className={`round ${call.camOff || !call.video ? '' : 'on'}`} onClick={toggleCam} disabled={call.status !== 'active'} aria-label="Camera"><Icon name={call.video && !call.camOff ? 'video' : 'videoOff'} size={26} /></button><span>{t('Camera')}</span></div>
            <div className="call-ctl"><button className={`round ${call.micOff ? '' : 'on'}`} onClick={toggleMic} aria-label="Microphone"><Icon name={call.micOff ? 'micOff' : 'mic'} size={26} /></button><span>{t(call.micOff ? 'Unmute_mic' : 'Mute_mic')}</span></div>
            <div className="call-ctl"><button className="round red" onClick={hangUp} aria-label="End call"><Icon name="hangup" size={28} /></button><span>{t('End')}</span></div>
          </>
        )}
      </div>
    </div>
    </>
  );
}
