import webpush from 'web-push';
import { config } from '../config.js';
import { query } from '../db.js';
import { isForeground } from '../realtime/bus.js';
import { mentionedUsernames } from './mentions.js';

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

/**
 * Who gets a push for a new message: active members other than the sender who haven't muted the
 * chat, plus anyone @mentioned in it, even if they muted the chat.
 */
export async function pushRecipients(chat, sender, message) {
  if (message.type === 'system') return [];
  const mentioned = chat.type === 'group' ? mentionedUsernames(message.body) : [];
  const { rows } = await query(
    `SELECT cm.user_id, lower(u.username) = ANY($3::text[]) AS mentioned
       FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = $1 AND cm.user_id <> $2 AND u.status = 'active'
        AND (NOT cm.muted OR lower(u.username) = ANY($3::text[]))`,
    [chat.id, sender.id, mentioned],
  );
  return rows.map((r) => ({ userId: r.user_id, mentioned: r.mentioned }));
}

/** Web Push for recipients who don't have the app on screen. */
export async function notifyNewMessage(chat, sender, message) {
  if (!pushEnabled) return;
  const recipients = await pushRecipients(chat, sender, message);
  const title = chat.type === 'group' ? chat.title : sender.display_name;
  for (const { userId, mentioned } of recipients) {
    if (await isForeground(userId)) continue;
    const body = chat.type !== 'group' ? preview(message)
      : mentioned ? `${sender.display_name} mentioned you: ${preview(message)}`
        : `${sender.display_name}: ${preview(message)}`;
    // A tag per message: on iPhone, reusing a tag replaces the banner without alerting again.
    await sendToUser(userId, { title, body, chatId: chat.id, messageId: message.id, tag: `msg-${message.id}` });
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
