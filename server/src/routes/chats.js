import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { translateMessage, translateText } from '../services/translate.js';
import { query } from '../db.js';
import { asyncH, parse, HttpError } from '../middleware.js';
import * as chats from '../services/chats.js';
import { toUsers } from '../realtime/bus.js';

const router = Router();
const id = z.coerce.number().int().positive();
const idParam = (req, name = 'id') => parse(id, req.params[name]);

router.get('/', asyncH(async (req, res) => {
  res.json({ chats: await chats.getChatSummaries(req.user.id) });
}));

router.post('/direct', asyncH(async (req, res) => {
  const { userId } = parse(z.object({ userId: id }), req.body);
  const { chatId, created } = await chats.getOrCreateDirect(req.user, userId);
  if (created) await chats.pushChatSummaries(chatId);
  const [chat] = await chats.getChatSummaries(req.user.id, [chatId]);
  res.json({ chat });
}));

const groupSchema = z.object({
  title: z.string().trim().min(1).max(128),
  description: z.string().trim().max(1000).optional(),
  memberIds: z.array(id).max(1000).default([]),
  onlyAdminsPost: z.boolean().optional(),
  membersCanAdd: z.boolean().optional(),
});

router.post('/group', asyncH(async (req, res) => {
  const data = parse(groupSchema, req.body);
  const chatId = await chats.createGroup(req.user, data);
  const [chat] = await chats.getChatSummaries(req.user.id, [chatId]);
  res.status(201).json({ chat });
}));

router.get('/:id', asyncH(async (req, res) => {
  res.json({ chat: await chats.getChatDetails(idParam(req), req.user.id) });
}));

router.patch('/:id', asyncH(async (req, res) => {
  const patch = parse(groupSchema.omit({ memberIds: true }).partial(), req.body);
  await chats.updateGroup(idParam(req), req.user, patch);
  res.json({ ok: true });
}));

/** Per-user chat preferences. */
router.patch('/:id/settings', asyncH(async (req, res) => {
  const chatId = idParam(req);
  const s = parse(z.object({
    muted: z.boolean(), pinned: z.boolean(), archived: z.boolean(), autoTranslate: z.enum(['en', 'ru']).nullable(),
  }).partial(), req.body);
  await chats.requireMember(chatId, req.user.id);
  await query(
    `UPDATE chat_members SET muted = coalesce($3, muted), pinned = coalesce($4, pinned), archived = coalesce($5, archived),
            auto_translate = CASE WHEN $6 THEN $7 ELSE auto_translate END
      WHERE chat_id = $1 AND user_id = $2`,
    [chatId, req.user.id, s.muted ?? null, s.pinned ?? null, s.archived ?? null, s.autoTranslate !== undefined, s.autoTranslate ?? null],
  );
  await chats.pushChatSummaries(chatId, [req.user.id]);
  res.json({ ok: true });
}));

/** Clears history for the current user only. */
router.post('/:id/clear', asyncH(async (req, res) => {
  const chatId = idParam(req);
  await chats.requireMember(chatId, req.user.id);
  await query(
    `UPDATE chat_members SET cleared_before_id = (SELECT coalesce(max(id), 0) FROM messages WHERE chat_id = $1)
      WHERE chat_id = $1 AND user_id = $2`,
    [chatId, req.user.id],
  );
  await chats.pushChatSummaries(chatId, [req.user.id]);
  toUsers([req.user.id], 'chat:pins', { chatId });
  res.json({ ok: true });
}));

router.post('/:id/members', asyncH(async (req, res) => {
  const { userIds } = parse(z.object({ userIds: z.array(id).min(1).max(500) }), req.body);
  res.json({ added: await chats.addGroupMembers(idParam(req), req.user, userIds) });
}));

router.delete('/:id/members/:userId', asyncH(async (req, res) => {
  await chats.removeGroupMember(idParam(req), req.user, idParam(req, 'userId'));
  res.json({ ok: true });
}));

router.patch('/:id/members/:userId', asyncH(async (req, res) => {
  const { role } = parse(z.object({ role: z.enum(['admin', 'member']) }), req.body);
  await chats.setMemberRole(idParam(req), req.user, idParam(req, 'userId'), role);
  res.json({ ok: true });
}));

const listSchema = z.object({
  before: id.optional(),
  after: id.optional(),
  around: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get('/:id/messages', asyncH(async (req, res) => {
  const opts = parse(listSchema, req.query);
  res.json({ messages: await chats.listMessages(idParam(req), req.user.id, opts) });
}));

const sendSchema = z.object({
  body: z.string().max(10_000).default(''),
  fileId: id.nullish(),
  replyToId: id.nullish(),
  clientId: z.string().min(8).max(64).nullish(),
  type: z.enum(['voice']).nullish(),
});

router.post('/:id/messages', asyncH(async (req, res) => {
  const data = parse(sendSchema, req.body);
  const { message, duplicate } = await chats.sendMessage(req.user, idParam(req), data);
  res.status(duplicate ? 200 : 201).json({ message });
}));

router.post('/:id/read', asyncH(async (req, res) => {
  const chatId = idParam(req);
  const { messageId } = parse(z.object({ messageId: id }), req.body);
  await chats.requireMember(chatId, req.user.id);
  res.json({ receipt: await chats.markReceipt(req.user.id, chatId, { readId: messageId }) });
}));

router.get('/:id/pins', asyncH(async (req, res) => {
  res.json({ messages: await chats.listPins(idParam(req), req.user.id) });
}));

router.get('/:id/media', asyncH(async (req, res) => {
  const chatId = idParam(req);
  await chats.requireMember(chatId, req.user.id);
  const { rows } = await query(
    `${chats.MESSAGE_SELECT} JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
      WHERE m.chat_id = $1 AND ${chats.VISIBLE} AND f.id IS NOT NULL
      ORDER BY m.id DESC LIMIT 200`,
    [chatId, req.user.id],
  );
  res.json({ messages: rows.map(chats.serializeMessage) });
}));

export const messagesRouter = Router();

messagesRouter.post('/forward', asyncH(async (req, res) => {
  const { messageIds, toChatIds } = parse(
    z.object({ messageIds: z.array(id).min(1).max(100), toChatIds: z.array(id).min(1).max(20) }),
    req.body,
  );
  res.json({ messages: await chats.forwardMessages(req.user, messageIds, toChatIds) });
}));

messagesRouter.patch('/:id', asyncH(async (req, res) => {
  const { body } = parse(z.object({ body: z.string().max(10_000) }), req.body);
  res.json({ message: await chats.editMessage(req.user, idParam(req), body) });
}));

messagesRouter.delete('/:id', asyncH(async (req, res) => {
  const forEveryone = req.query.forEveryone === '1' || req.query.forEveryone === 'true';
  await chats.deleteMessage(req.user, idParam(req), forEveryone);
  res.json({ ok: true });
}));

messagesRouter.post('/:id/reactions', asyncH(async (req, res) => {
  const { emoji } = parse(z.object({ emoji: z.string().min(1).max(16) }), req.body);
  if (/[<>]/.test(emoji)) throw new HttpError(400, 'Invalid reaction.', 'VALIDATION');
  res.json({ reactions: await chats.toggleReaction(req.user, idParam(req), emoji) });
}));

const translateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (req) => `t${req.user.id}`,
  message: { error: 'Too many translation requests. Please wait a moment.', code: 'RATE_LIMITED' },
  validate: { keyGeneratorIpFallback: false },
});

/** Translates a visible text message EN<->RU. target 'auto' picks the other language of the pair. */
messagesRouter.post('/:id/translate', translateLimiter, asyncH(async (req, res) => {
  const { target } = parse(z.object({ target: z.enum(['en', 'ru', 'auto']).default('auto') }), req.body);
  const m = await chats.assertVisibleMessage(idParam(req), req.user.id);
  if (!m.body.trim()) throw new HttpError(400, 'This message has no text to translate.', 'VALIDATION');
  res.json({ translation: await translateMessage(m.id, m.body, target) });
}));

/** Translates a draft before sending, so people can write in their own language. */
export const translateRouter = Router();
translateRouter.post('/', translateLimiter, asyncH(async (req, res) => {
  const { text, target } = parse(z.object({ text: z.string().trim().min(1).max(5000), target: z.enum(['en', 'ru', 'auto']).default('auto') }), req.body);
  res.json({ translation: await translateText(text, target) });
}));

messagesRouter.post('/:id/pin', asyncH(async (req, res) => {
  await chats.setPinned(req.user, idParam(req), true);
  res.json({ ok: true });
}));

messagesRouter.delete('/:id/pin', asyncH(async (req, res) => {
  await chats.setPinned(req.user, idParam(req), false);
  res.json({ ok: true });
}));

export default router;
