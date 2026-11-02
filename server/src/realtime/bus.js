import { query } from '../db.js';

// Thin wrapper around the Socket.IO server so services can emit without importing the socket layer.
// With the Redis adapter enabled, room emits and fetchSockets() work across instances.
let io = null;
export const setIo = (server) => { io = server; };
export const getIo = () => io;

export const userRoom = (id) => `user:${id}`;
export const sessionRoom = (id) => `session:${id}`;

export function toUsers(userIds, event, data) {
  if (!io || !userIds.length) return;
  io.to(userIds.map(userRoom)).emit(event, data);
}

export async function chatMemberIds(chatId) {
  const { rows } = await query('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  return rows.map((r) => r.user_id);
}

export async function toChat(chatId, event, data) {
  toUsers(await chatMemberIds(chatId), event, data);
}

export function broadcast(event, data) {
  io?.emit(event, data);
}

export function disconnectUser(userId) {
  io?.in(userRoom(userId)).disconnectSockets(true);
}

export function disconnectSession(sessionId) {
  io?.in(sessionRoom(sessionId)).disconnectSockets(true);
}

export async function isOnline(userId) {
  if (!io) return false;
  return (await io.in(userRoom(userId)).fetchSockets()).length > 0;
}

export async function onlineUserIds() {
  if (!io) return [];
  const sockets = await io.fetchSockets();
  return [...new Set(sockets.map((s) => s.data.userId).filter(Boolean))];
}
