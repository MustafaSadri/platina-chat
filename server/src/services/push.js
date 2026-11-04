import webpush from 'web-push';
import { config } from '../config.js';
import { query } from '../db.js';
import { isForeground } from '../realtime/bus.js';

export const pushEnabled = Boolean(config.push.publicKey && config.push.privateKey);
if (pushEnabled) webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);

function preview(message) {
  if (message.type === 'voice') return '🎤 Voice message';
  if (message.type === 'call') return '📞 Call';
  if (message.file) {
    const icon = { image: '🖼', video: '🎬', audio: '🎵' }[message.file.kind] || '📎';
    return `${icon} ${message.body || message.file.name}`;
  }
  return message.body.slice(0, 140);
}

/** Web Push for members who don't have the app on screen and haven't muted the chat. */
export async function notifyNewMessage(chat, sender, message) {
  if (!pushEnabled || message.type === 'system') return;
  const { rows } = await query(
    `SELECT cm.user_id FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = $1 AND cm.user_id <> $2 AND NOT cm.muted AND u.status = 'active'`,
    [chat.id, sender.id],
  );
  const title = chat.type === 'group' ? chat.title : sender.display_name;
  const body = chat.type === 'group' ? `${sender.display_name}: ${preview(message)}` : preview(message);
  for (const { user_id: uid } of rows) {
    if (await isForeground(uid)) continue;
    // A tag per message: on iPhone, reusing a tag replaces the banner without alerting again.
    await sendToUser(uid, { title, body, chatId: chat.id, messageId: message.id, tag: `msg-${message.id}` });
  }
}

/** Sends to every device of a user. "high" urgency asks Apple/Google to deliver right away. */
export async function sendToUser(userId, payload, { ttl = 3600, urgency = 'high' } = {}) {
  const result = { sent: 0, failed: 0 };
  if (!pushEnabled) return result;
  const subs = await query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  await Promise.all(
    subs.rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: ttl, urgency });
        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        if (err.statusCode === 404 || err.statusCode === 410) await query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        else console.error('[push] send failed', err.statusCode || err.message);
      }
    }),
  );
  return result;
}
