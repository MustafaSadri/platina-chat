import { create } from 'zustand';
import * as api from './api.js';
import { getSocket } from './socket.js';
import { useStore } from './store.js';
import { t } from './i18n.js';

// 1:1 WebRTC calls. Signaling goes through Socket.IO; media flows peer-to-peer (or via TURN).
const idle = {
  status: 'idle', // idle | outgoing | incoming | connecting | active
  callId: null, chatId: null, peer: null, video: false,
  localStream: null, remoteStream: null, micOff: false, camOff: false, startedAt: null, error: null,
};

export const useCall = create(() => ({ ...idle }));

let pc = null;
let pendingCandidates = [];
let ringTimer = null;
let ringCtx = null;

function ring(on) {
  clearInterval(ringTimer);
  ringTimer = null;
  if (!on) return;
  const beep = () => {
    try {
      ringCtx = ringCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = ringCtx.currentTime;
      const o = ringCtx.createOscillator();
      const g = ringCtx.createGain();
      o.frequency.value = 440;
      g.gain.setValueAtTime(0.08, t);
      g.gain.setValueAtTime(0, t + 0.8);
      o.connect(g).connect(ringCtx.destination);
      o.start(t);
      o.stop(t + 0.9);
    } catch { /* ignore */ }
  };
  beep();
  ringTimer = setInterval(beep, 2500);
}

async function getMedia(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need a secure (HTTPS) connection and a browser with camera/microphone support.');
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
  });
}

const CONNECT_TIMEOUT_MS = 25_000;
let connectTimer = null;
// Bumped whenever a call starts or is torn down, so slow steps (the microphone prompt, network
// requests) can tell the call they belong to was cancelled while they were waiting.
let attempt = 0;
const stopTracks = (stream) => stream?.getTracks().forEach((track) => track.stop());

function clearCallNotifications() {
  navigator.serviceWorker?.getRegistration()
    .then((reg) => reg?.getNotifications())
    .then((list) => list?.filter((n) => n.tag?.startsWith('call-')).forEach((n) => n.close()))
    .catch(() => {});
}

function failConnection(turn) {
  useStore.getState().showToast(t(turn
    ? 'Call connection failed. Check your internet connection and try again.'
    : 'Call connection failed. A TURN server may be required on this network.'), 'error');
  hangUp();
}

async function createPeer(callId, stream) {
  const mine = attempt;
  const { iceServers, turn } = await api.get('/calls/ice');
  if (mine !== attempt) return null;
  pc = new RTCPeerConnection({ iceServers });
  // Give up instead of showing "Connecting…" forever when no network path is found.
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (pc && pc.connectionState !== 'connected') failConnection(turn);
  }, CONNECT_TIMEOUT_MS);
  pendingCandidates = [];
  const remote = new MediaStream();
  useCall.setState({ remoteStream: remote });
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  pc.ontrack = (e) => {
    e.streams[0]?.getTracks().forEach((t) => { if (!remote.getTracks().includes(t)) remote.addTrack(t); });
    useCall.setState({ remoteStream: remote });
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) getSocket()?.emit('call:signal', { callId, data: { candidate: e.candidate.toJSON() } });
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(connectTimer);
      useCall.setState({ status: 'active', startedAt: useCall.getState().startedAt || Date.now() });
    }
    if (pc.connectionState === 'failed') failConnection(turn);
  };
  return pc;
}

function cleanup() {
  attempt += 1;
  clearCallNotifications();
  ring(false);
  clearTimeout(connectTimer);
  const { localStream } = useCall.getState();
  localStream?.getTracks().forEach((t) => t.stop());
  try { pc?.close(); } catch { /* ignore */ }
  pc = null;
  pendingCandidates = [];
  useCall.setState({ ...idle });
}

export async function startCall(chat, video) {
  if (useCall.getState().status !== 'idle') return;
  const peer = chat.peer;
  attempt += 1;
  const mine = attempt;
  useCall.setState({ ...idle, status: 'outgoing', chatId: chat.id, peer, video });
  let stream;
  try {
    stream = await getMedia(video);
  } catch (err) {
    if (mine !== attempt) return;
    cleanup();
    useStore.getState().showToast(t('Could not access microphone/camera.'), 'error');
    return;
  }
  if (mine !== attempt) { // cancelled during the permission prompt
    stopTracks(stream);
    return;
  }
  useCall.setState({ localStream: stream });
  const res = await getSocket()?.timeout(10_000).emitWithAck('call:invite', { chatId: chat.id, video }).catch(() => ({ error: 'Server did not respond.' }));
  if (mine !== attempt) { // cancelled while the invite was on its way
    if (res?.callId) getSocket()?.emit('call:end', { callId: res.callId });
    return;
  }
  if (!res || res.error) {
    cleanup();
    useStore.getState().showToast(res?.error === 'busy' ? t('{name} is on another call.', { name: peer.displayName }) : res?.error || t('Call failed.'), 'error');
    return;
  }
  useCall.setState({ callId: res.callId });
}

export async function acceptCall() {
  const st = useCall.getState();
  if (st.status !== 'incoming') return;
  ring(false);
  clearCallNotifications();
  const mine = attempt;
  useCall.setState({ status: 'connecting' });
  let stream;
  try {
    stream = await getMedia(st.video);
  } catch (err) {
    if (mine !== attempt) return;
    getSocket()?.emit('call:reject', { callId: st.callId });
    cleanup();
    useStore.getState().showToast(t('Could not access microphone/camera.'), 'error');
    return;
  }
  if (mine !== attempt) { // the call ended during the permission prompt
    stopTracks(stream);
    return;
  }
  useCall.setState({ localStream: stream });
  if (!(await createPeer(st.callId, stream))) return;
  const res = await getSocket()?.emitWithAck('call:accept', { callId: st.callId });
  if (res?.error) {
    cleanup();
    useStore.getState().showToast(res.error, 'error');
  }
}

export function declineCall() {
  const { callId } = useCall.getState();
  getSocket()?.emit('call:reject', { callId });
  cleanup();
}

export function hangUp() {
  const { callId } = useCall.getState();
  if (callId) getSocket()?.emit('call:end', { callId });
  cleanup();
}

export function toggleMic() {
  const { localStream, micOff } = useCall.getState();
  localStream?.getAudioTracks().forEach((t) => { t.enabled = micOff; });
  useCall.setState({ micOff: !micOff });
}

export async function toggleCam() {
  const { localStream, camOff, callId } = useCall.getState();
  if (!localStream?.getVideoTracks().length) {
    // No camera in this call yet: add one (renegotiates). The other side can do the same.
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      const track = cam.getVideoTracks()[0];
      localStream.addTrack(track);
      pc?.addTrack(track, localStream);
      useCall.setState({ video: true, camOff: false, localStream });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      getSocket()?.emit('call:signal', { callId, data: { sdp: pc.localDescription.toJSON() } });
    } catch {
      useStore.getState().showToast(t('Could not start the camera.'), 'error');
    }
    return;
  }
  localStream?.getVideoTracks().forEach((t) => { t.enabled = camOff; });
  useCall.setState({ camOff: !camOff });
}

async function onSignal({ callId, data }) {
  if (!pc || callId !== useCall.getState().callId) return;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    for (const c of pendingCandidates) await pc.addIceCandidate(c).catch(() => {});
    pendingCandidates = [];
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      getSocket()?.emit('call:signal', { callId, data: { sdp: pc.localDescription.toJSON() } });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else pendingCandidates.push(data.candidate);
  }
}

/** After the socket reconnects: reattach to the running call, or close it if it's over. */
export async function rejoinCall() {
  const { callId, status } = useCall.getState();
  if (!callId || status === 'incoming') return;
  const res = await getSocket()?.timeout(5000).emitWithAck('call:rejoin', { callId }).catch(() => null);
  if (res?.error) cleanup();
}

// Closing the app ends the call at once; the reconnect grace period is only for dropped connections.
window.addEventListener('pagehide', (e) => {
  const { callId, status } = useCall.getState();
  if (!e.persisted && callId && status !== 'incoming') hangUp();
});

export async function handleCallEvent(event, data) {
  const st = useCall.getState();
  if (event === 'call:incoming') {
    if (st.status !== 'idle') return; // already on this or another call; ignore repeats
    useCall.setState({ ...idle, status: 'incoming', callId: data.callId, chatId: data.chatId, peer: data.from, video: data.video });
    ring(true);
    // With Web Push the server notifies hidden devices; this covers servers without it.
    if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted' && !useStore.getState().config.vapidPublicKey) {
      navigator.serviceWorker?.getRegistration().then((reg) => reg?.showNotification(data.from.displayName, {
        body: data.video ? `📹 ${t('Incoming video call')}` : `📞 ${t('Incoming call')}`, tag: `call-${data.callId}`, data: { chatId: data.chatId },
      }));
    }
  } else if (event === 'call:accepted') {
    if (data.callId !== st.callId || st.status !== 'outgoing') return;
    useCall.setState({ status: 'connecting' });
    if (!(await createPeer(st.callId, st.localStream))) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    getSocket()?.emit('call:signal', { callId: st.callId, data: { sdp: pc.localDescription.toJSON() } });
  } else if (event === 'call:signal') {
    await onSignal(data).catch((err) => console.error('signal error', err));
  } else if (event === 'call:ended') {
    if (data.callId !== st.callId) return;
    const msg = { declined: t('Call declined.'), 'no-answer': t('No answer.'), 'answered-elsewhere': null }[data.reason];
    if (msg && st.status === 'outgoing') useStore.getState().showToast(msg);
    cleanup();
  }
}
