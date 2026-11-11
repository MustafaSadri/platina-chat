import { locale, t } from './i18n.js';

export const AVATAR_COLORS = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774', '#5d9fd8'];

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const timeOf = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

export function listTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return timeOf(iso);
  const diffDays = (now - d) / 86400_000;
  if (diffDays < 6) return d.toLocaleDateString(locale(), { weekday: 'short' });
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: '2-digit' } : {}) });
}

export function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return t('Today');
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return t('Yesterday');
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export const isSameDay = (a, b) => sameDay(new Date(a), new Date(b));

export function lastSeen(user, online) {
  if (online) return t('online');
  if (!user?.lastSeenAt) return t('last seen a long time ago');
  const d = new Date(user.lastSeenAt);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return t('last seen just now');
  if (mins < 60) return t('last seen {n} minutes ago', { n: mins });
  if (sameDay(d, new Date())) return t('last seen at {time}', { time: timeOf(user.lastSeenAt) });
  return t('last seen {date} at {time}', { date: listTime(user.lastSeenAt), time: timeOf(user.lastSeenAt) });
}

export function fileSize(bytes) {
  const ru = locale() === 'ru-RU';
  const u = ru ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB'];
  if (bytes < 1024) return `${bytes} ${u[0]}`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} ${u[1]}`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} ${u[2]}`;
  return `${(bytes / 1024 ** 3).toFixed(2)} ${u[3]}`;
}

export function duration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function messagePreview(m, users = {}) {
  if (!m) return '';
  if (m.type === 'system') return systemText(m, users);
  if (m.type === 'call') return callText(m.meta);
  if (m.type === 'voice') return `🎤 ${t('Voice message')}`;
  if (m.file) {
    const kind = { image: ['🖼', 'Photo'], video: ['🎬', 'Video'], audio: ['🎵', 'Audio'] }[m.file.kind];
    if (m.body) return `${kind ? kind[0] : '📎'} ${m.body}`;
    return kind ? `${kind[0]} ${t(kind[1])}` : `📎 ${m.file.name}`;
  }
  return m.body;
}

export function callText(meta = {}) {
  const v = meta.video;
  if (meta.group) {
    const name = t(v ? 'Group video call' : 'Group call');
    return meta.status === 'completed' ? `${v ? '📹' : '📞'} ${name} (${duration(meta.durationSec)})` : `📵 ${t('Missed {call}', { call: name })}`;
  }
  if (meta.status === 'completed') return `${v ? '📹' : '📞'} ${t(v ? 'Video call' : 'Call')} (${duration(meta.durationSec)})`;
  const label = { missed: 'Missed', declined: 'Declined' }[meta.status] || 'Cancelled';
  return `📵 ${t(`${label} ${v ? 'video call' : 'call'}`)}`;
}

const nameOf = (users, id) => users[id]?.displayName || t('Someone');

export function systemText(m, users = {}) {
  const meta = m.meta || {};
  const actor = nameOf(users, m.senderId);
  switch (meta.event) {
    case 'group_created': return t('{actor} created the group “{title}”', { actor, title: meta.title });
    case 'group_renamed': return t('{actor} renamed the group to “{title}”', { actor, title: meta.title });
    case 'members_added': return t('{actor} added {names}', { actor, names: (meta.userIds || []).map((id) => nameOf(users, id)).join(', ') });
    case 'member_removed': return t('{actor} removed {name}', { actor, name: nameOf(users, meta.userId) });
    case 'member_left': return t('{name} left the group', { name: nameOf(users, meta.userId) });
    case 'message_pinned': return t('{actor} pinned “{text}”', { actor, text: meta.preview || t('a message') });
    default: return t('Service message');
  }
}

/** Center-crops a picture to a square JPEG, so profile photos stay small and any format works. */
export async function cropToJpeg(file, size = 512) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(t('That picture could not be read.')));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Splits text into plain strings and safe http(s) links for rendering. */
export function linkify(text) {
  const parts = [];
  const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ href: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
