// Earpiece or loudspeaker during calls. The web gives very little control here: only iPhones
// (Safari 16.4 and later) expose navigator.audioSession, where "play-and-record" is the
// phone-call style session (earpiece) and "auto" is the default (loudspeaker during calls).
// Elsewhere the button stays hidden. Not verified on a real iPhone yet.
export const canSwitchSpeaker = () => typeof navigator !== 'undefined' && 'audioSession' in navigator;

export function setSpeaker(on) {
  if (!canSwitchSpeaker()) return;
  try { navigator.audioSession.type = on ? 'auto' : 'play-and-record'; } catch { /* unsupported value */ }
}
