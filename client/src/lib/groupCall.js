import { create } from 'zustand';
import * as api from './api.js';
import { clearCallNotifications, getMedia, ring, takePendingAnswer, useCall } from './call.js';
import { useStore } from './store.js';
import { getSocket } from './socket.js';
import { t } from './i18n.js';
import { setSpeaker } from './audioRoute.js';

// Group calls: every participant keeps a direct WebRTC connection to every other one. Each pair uses
// "perfect negotiation", so either side can add its camera at any time without the two colliding.
const idle = {
  status: 'idle', // idle | ringing | joining | active
  callId: null, chatId: null, title: '', from: null, video: false,
  localStream: null, micOff: false, camOff: false, speaker: true, peers: {}, startedAt: null,
};

export const useGroupCall = create(() => ({ ...idle }));

const connections = new Map(); // userId -> { pc, polite, makingOffer, ignoreOffer }
let iceServers = [];
let attempt = 0;

const toast = (...args) => useStore.getState().showToast(...args);
const stopTracks = (stream) => stream?.getTracks().forEach((track) => track.stop());
const send = (userId, data) => getSocket()?.emit('group-call:signal', { callId: useGroupCall.getState().callId, to: userId, data });

function setPeer(userId, patch) {
  if (!connections.has(userId)) return; // late events from a closed connection must not bring them back
  useGroupCall.setState((s) => ({ peers: { ...s.peers, [userId]: { ...s.peers[userId], ...patch } } }));
}

function addLocalTracks(conn) {
  if (conn.tracksAdded) return;
  conn.tracksAdded = true;
  const { localStream } = useGroupCall.getState();
  localStream.getTracks().forEach((track) => conn.pc.addTrack(track, localStream));
}

function connect(userId) {
  if (connections.has(userId)) return connections.get(userId);
  const me = useStore.getState().me.id;
  const pc = new RTCPeerConnection({ iceServers });
  // pendingCandidates: network addresses that arrive before this side has the other's description.
  const conn = { pc, polite: me > userId, makingOffer: false, ignoreOffer: false, pendingCandidates: [] };
  connections.set(userId, conn);
  useStore.getState().ensureUser(userId);
  setPeer(userId, { stream: null, connected: false, updated: Date.now() });

  // Only one side of each pair starts the connection (the lower user id), so two phones never
  // offer at the same moment. The other side adds its microphone/camera when it answers.
  if (me < userId) addLocalTracks(conn);

  pc.onnegotiationneeded = async () => {
    try {
      conn.makingOffer = true;
      await pc.setLocalDescription();
      send(userId, { sdp: pc.localDescription.toJSON() });
    } catch (err) {
      console.error('group call offer failed', err);
    } finally {
      conn.makingOffer = false;
    }
  };
  pc.onicecandidate = (e) => { if (e.candidate) send(userId, { candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    const refresh = () => setPeer(userId, { updated: Date.now() });
    e.track.onunmute = refresh;
    e.track.onmute = refresh;
    e.track.onended = refresh;
    setPeer(userId, { stream: e.streams[0], updated: Date.now() });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setPeer(userId, { connected: true });
      useGroupCall.setState((s) => ({ startedAt: s.startedAt || Date.now() }));
    }
    if (pc.connectionState === 'failed') pc.restartIce();
  };
  return conn;
}

function dropPeer(userId) {
  try { connections.get(userId)?.pc.close(); } catch { /* ignore */ }
  connections.delete(userId);
  useGroupCall.setState((s) => {
    const peers = { ...s.peers };
    delete peers[userId];
    return { peers };
  });
}

function reset() {
  attempt += 1;
  setSpeaker(true);
  ring(false);
  clearCallNotifications();
  stopTracks(useGroupCall.getState().localStream);
  [...connections.keys()].forEach(dropPeer);
  useGroupCall.setState({ ...idle });
}

async function onSignal({ callId, from, data }) {
  if (callId !== useGroupCall.getState().callId || !useGroupCall.getState().localStream) return;
  const conn = connect(from);
  const { pc } = conn;
  if (data.sdp) {
    const collision = data.sdp.type === 'offer' && (conn.makingOffer || pc.signalingState !== 'stable');
    conn.ignoreOffer = !conn.polite && collision;
    if (conn.ignoreOffer) return;
    await pc.setRemoteDescription(data.sdp);
    for (const candidate of conn.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    if (data.sdp.type === 'offer') {
      addLocalTracks(conn); // the answering side joins in with its own microphone/camera here
      await pc.setLocalDescription();
      send(from, { sdp: pc.localDescription.toJSON() });
    }
  } else if (data.candidate) {
    // When both sides offered at once, the losing side's addresses arrive before its answer.
    // They are still valid for the connection, so keep them instead of dropping them.
    if (!pc.remoteDescription) {
      conn.pendingCandidates.push(data.candidate);
      return;
    }
    await pc.addIceCandidate(data.candidate).catch((err) => { if (!conn.ignoreOffer) throw err; });
  }
}

/** Shared by starting and joining: get the mic/camera, then enter the call on the server. */
async function enter(event, payload, wantVideo) {
  attempt += 1;
  const mine = attempt;
  ring(false);
  clearCallNotifications();
  useGroupCall.setState({ status: 'joining', video: wantVideo });
  let stream;
  try {
    stream = await getMedia(wantVideo).catch((err) => {
      if (wantVideo) return getMedia(false); // no camera: join with sound only
      throw err;
    });
  } catch {
    if (mine === attempt) {
      reset();
      toast(t('Could not access microphone/camera.'), 'error');
    }
    return;
  }
  if (mine !== attempt) {
    stopTracks(stream);
    return;
  }
  useGroupCall.setState({ localStream: stream, video: stream.getVideoTracks().length > 0 });
  try {
    ({ iceServers } = await api.get('/calls/ice'));
  } catch {
    iceServers = [];
  }
  const res = await getSocket()?.timeout(10_000).emitWithAck(event, payload).catch(() => ({ error: t('Call failed.') }));
  if (mine !== attempt) {
    if (res?.callId) getSocket()?.emit('group-call:leave', { callId: res.callId });
    return;
  }
  if (!res || res.error) {
    reset();
    toast(res?.error === 'full' ? t('This call is full.') : res?.error || t('Call failed.'), 'error');
    return;
  }
  useGroupCall.setState({ status: 'active', callId: res.callId, chatId: res.chatId, title: res.title, from: res.from });
  res.peers.forEach(connect);
}

export function startGroupCall(chat, video) {
  if (useGroupCall.getState().status !== 'idle' || useCall.getState().status !== 'idle') return;
  useGroupCall.setState({ ...idle, status: 'joining', chatId: chat.id, title: chat.title, video });
  return enter('group-call:start', { chatId: chat.id, video }, video);
}

/** Joins a call that is already running, from the bar in the chat. */
export function joinGroupCall(call) {
  if (useGroupCall.getState().status !== 'idle' || useCall.getState().status !== 'idle') return;
  useGroupCall.setState({ ...idle, status: 'joining', callId: call.callId, chatId: call.chatId, title: call.title, from: call.from, video: call.video });
  return enter('group-call:join', { callId: call.callId }, call.video);
}

export function acceptGroupCall() {
  const st = useGroupCall.getState();
  if (st.status !== 'ringing') return;
  const { callId, video } = st;
  // Keep the call id while joining: others who join at the same moment connect to us before our
  // own join is confirmed, and their requests must not be mistaken for another call's.
  return enter('group-call:join', { callId }, video);
}

export function declineGroupCall() {
  const { callId } = useGroupCall.getState();
  if (callId) getSocket()?.emit('group-call:decline', { callId });
  reset();
}

export function leaveGroupCall() {
  const { callId } = useGroupCall.getState();
  if (callId) getSocket()?.emit('group-call:leave', { callId });
  reset();
}

export function toggleGroupSpeaker() {
  const speaker = !useGroupCall.getState().speaker;
  setSpeaker(speaker);
  useGroupCall.setState({ speaker });
}

export function toggleGroupMic() {
  const { localStream, micOff } = useGroupCall.getState();
  localStream?.getAudioTracks().forEach((track) => { track.enabled = micOff; });
  useGroupCall.setState({ micOff: !micOff });
}

export async function toggleGroupCam() {
  const { localStream, camOff } = useGroupCall.getState();
  if (localStream?.getVideoTracks().length) {
    localStream.getVideoTracks().forEach((track) => { track.enabled = camOff; });
    useGroupCall.setState({ camOff: !camOff });
    return;
  }
  try {
    const cam = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    const track = cam.getVideoTracks()[0];
    localStream.addTrack(track);
    // Renegotiates. Connections that haven't answered yet pick the camera up from localStream then.
    for (const conn of connections.values()) if (conn.tracksAdded) conn.pc.addTrack(track, localStream);
    useGroupCall.setState({ video: true, camOff: false, localStream });
  } catch {
    toast(t('Could not start the camera.'), 'error');
  }
}

/** The notification's Answer button, when this call is already on screen. */
export function answerGroupIfRinging(callId) {
  const st = useGroupCall.getState();
  if (st.status === 'ringing' && st.callId === callId && takePendingAnswer(callId)) acceptGroupCall();
}

/** After the socket reconnects: reattach to the running call, or leave if it's over. */
export async function rejoinGroupCall() {
  const { callId, status } = useGroupCall.getState();
  if (!callId || status !== 'active') return;
  const res = await getSocket()?.timeout(5000).emitWithAck('group-call:rejoin', { callId }).catch(() => null);
  if (res?.error) reset();
}

window.addEventListener('pagehide', (e) => {
  if (!e.persisted && useGroupCall.getState().status === 'active') leaveGroupCall();
});

export async function handleGroupCallEvent(event, data) {
  const st = useGroupCall.getState();
  const store = useStore.getState();
  if (event === 'group-call:update') {
    store.setGroupCall(data);
    if (st.status === 'ringing' && st.callId === data.callId && !data.ringing) reset();
  } else if (event === 'group-call:ringing') {
    store.setGroupCall(data);
    if (st.status !== 'idle' || useCall.getState().status !== 'idle' || store.chats[data.chatId]?.muted) return;
    useGroupCall.setState({ ...idle, status: 'ringing', callId: data.callId, chatId: data.chatId, title: data.title, from: data.from, video: data.video });
    ring(true);
    if (takePendingAnswer(data.callId)) acceptGroupCall();
  } else if (event === 'group-call:peer-joined') {
    if (data.callId !== st.callId) return;
    store.mergeUsers([data.user]);
    connect(data.user.id);
  } else if (event === 'group-call:peer-left') {
    if (data.callId === st.callId) dropPeer(data.userId);
  } else if (event === 'group-call:signal') {
    await onSignal(data).catch((err) => console.error('group call signal error', err));
  } else if (event === 'group-call:ended') {
    store.removeGroupCall(data.chatId);
    if (data.callId === st.callId) reset();
  }
}
