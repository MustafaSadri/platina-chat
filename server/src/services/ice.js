import { config } from '../config.js';

let cached = null;

/** Cloudflare returns either one server object or an array depending on the endpoint version. */
const asList = (iceServers) => (Array.isArray(iceServers) ? iceServers : iceServers ? [iceServers] : []);

/** ICE servers for WebRTC. Cloudflare TURN credentials are short-lived and fetched on demand. */
export async function getIceServers() {
  const servers = [{ urls: config.turn.stunUrls }];
  const t = config.turn;
  if (t.cloudflareKeyId && t.cloudflareApiToken) {
    if (cached && cached.expires > Date.now() + 3600_000) return [...servers, ...cached.servers];
    try {
      const request = (path) => fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${t.cloudflareKeyId}/credentials/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t.cloudflareApiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      let res = await request('generate-ice-servers');
      if (res.status === 404) res = await request('generate');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = asList((await res.json()).iceServers).filter((s) => s.username && s.credential);
      if (!list.length) throw new Error('response contained no TURN servers');
      cached = { servers: list, expires: Date.now() + 86400_000 };
      return [...servers, ...list];
    } catch (err) {
      console.error('[ice] Cloudflare TURN credential request failed:', err.message);
    }
  }
  if (t.urls.length) servers.push({ urls: t.urls, username: t.username, credential: t.credential });
  return servers;
}

export const turnConfigured = () => Boolean((config.turn.cloudflareKeyId && config.turn.cloudflareApiToken) || config.turn.urls.length);
