// Group chats people join with an invitation link (or a QR code of that same link), with an optional
// group video call. The database does the checking (membership, room size, call size); this file only asks.
// Ported from MindCare's own rooms.js, calling ForYou's schema.sql RPCs directly instead of a generic
// data-layer abstraction.
import { supabase, rpc } from './db.js';
import { CONFIG } from '../config.js';
import { baseUrl } from './util.js';

export const MAX_CALL = 8;
export const ROOM_FOLDER = (id) => `room-${id}`;

export const inviteLink = (code) => `${/^https?:$/.test(location.protocol) ? baseUrl() : CONFIG.siteUrl}#/rooms/join/${code}`;
export const whatsappLink = (room, code) => `https://wa.me/?text=${encodeURIComponent(`Join "${room.name}" on ForYou: ${inviteLink(code)}`)}`;

export async function createRoom({ name, topic }, me) {
  const { data, error } = await supabase.from('rooms')
    .insert({ name: String(name || '').trim(), topic: String(topic || '').trim(), owner_id: me.id })
    .select().single();
  if (error) throw new Error(error.message || 'Could not create the room.');
  return data;
}

export const roomPeople = (roomId) => rpc('room_people', { p_room: roomId });
export const joinRoom = (code) => rpc('join_room', { p_code: String(code || '').trim() });
export const invitePreview = async (code) => { const r = await rpc('room_invite_preview', { p_code: String(code || '').trim() }); return (r && r[0]) || null; };
export const resetInvite = (roomId) => rpc('reset_room_invite', { p_room: roomId });
export const myRooms = () => rpc('my_rooms');
export const roomCalls = async () => Object.fromEntries(((await rpc('room_calls')) || []).map((r) => [r.room_id, r.people]));
export const callPeople = async (roomId) => (await rpc('room_call_people', { p_room: roomId })) || [];
export const joinCall = (roomId) => rpc('join_room_call', { p_room: roomId });
export const leaveCall = (roomId) => rpc('leave_room_call', { p_room: roomId });

export async function sendRoomMessage({ room, body, attachment }) {
  const text = String(body || '').trim();
  if (!text && !attachment) return null;
  return rpc('send_room_message', { p_room: room.id, p_body: text, p_attachment: attachment || null });
}

export const markRoomRead = (roomId) => rpc('mark_room_read', { p_room: roomId });
export const leaveRoom = (roomId) => rpc('leave_room', { p_room: roomId });
export const removeMember = (roomId, userId) => rpc('remove_room_member', { p_room: roomId, p_user: userId });
export const deleteRoom = (roomId) => rpc('delete_room', { p_room: roomId });
