import webpush from 'web-push';
import { config } from '../config.js';
import { query } from '../db.js';
import { isOnline } from '../realtime/bus.js';

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

/** Web Push for members who are offline and haven't muted the chat. */
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
    if (await isOnline(uid)) continue;
    await sendToUser(uid, { title, body, chatId: chat.id, messageId: message.id, tag: `chat-${chat.id}` });
  }
}

export async function sendToUser(userId, payload) {
  if (!pushEnabled) return;
  const subs = await query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  await Promise.all(
    subs.rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        else console.error('[push] send failed', err.statusCode || err.message);
      }
    }),
  );
}
