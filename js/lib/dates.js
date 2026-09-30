// UNILUS blind dates: the calls to the database (supabase/migrations/07). The database decides who
// holds which seat, when the blindfold is open, and hides one dater's name and photo from the other
// until then -- this file only asks.
import { rpc } from './db.js';
import { baseUrl } from './util.js';
import { CONFIG } from '../config.js';

export const dateLink = (id) => `${/^https?:$/.test(location.protocol) ? baseUrl() : CONFIG.siteUrl}#/date/${id}`;

export const dateLobby = async () => (await rpc('blind_date_lobby')) || [];
export const dateInfo = (id) => rpc('blind_date_info', { p_date: id });
export const createDate = ({ title, role, isPublic }) => rpc('create_blind_date', { p_title: title || '', p_role: role, p_public: isPublic !== false });
export const joinDate = (id, role) => rpc('join_blind_date', { p_date: id, p_role: role || null });
export const dateBeat = (id) => rpc('blind_date_beat', { p_date: id });
export const revealDate = (id) => rpc('reveal_blind_date', { p_date: id });
export const endDate = (id) => rpc('end_blind_date', { p_date: id });
export const leaveDate = (id) => rpc('leave_blind_date', { p_date: id });
