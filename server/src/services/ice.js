import { config } from '../config.js';

let cached = null;

/** ICE servers for WebRTC. Cloudflare TURN credentials are short-lived and fetched on demand. */
export async function getIceServers() {
  const servers = [{ urls: config.turn.stunUrls }];
  const t = config.turn;
  if (t.cloudflareKeyId && t.cloudflareApiToken) {
    if (cached && cached.expires > Date.now() + 3600_000) return [...servers, cached.server];
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${t.cloudflareKeyId}/credentials/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t.cloudflareApiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      cached = { server: data.iceServers, expires: Date.now() + 86400_000 };
      return [...servers, data.iceServers];
    } catch (err) {
      console.error('[ice] Cloudflare TURN credential request failed:', err.message);
    }
  }
  if (t.urls.length) servers.push({ urls: t.urls, username: t.username, credential: t.credential });
  return servers;
}

export const turnConfigured = () => Boolean((config.turn.cloudflareKeyId && config.turn.cloudflareApiToken) || config.turn.urls.length);
