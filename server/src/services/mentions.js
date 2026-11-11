// @mentions: "@username" in a message. Usernames never change, so a mention keeps pointing at the
// same person even after they rename themselves.
const MENTION = /(^|[^\w@])@([a-zA-Z0-9._-]{3,32})/g;

/** Lower-cased usernames mentioned in a text (trailing dots and dashes are punctuation, not name). */
export function mentionedUsernames(text = '') {
  const names = new Set();
  for (const m of String(text).matchAll(MENTION)) names.add(m[2].replace(/[.-]+$/, '').toLowerCase());
  return [...names].filter((n) => n.length >= 3);
}
