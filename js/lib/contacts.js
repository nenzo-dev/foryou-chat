// Names you give the people you talk to, like saving a contact in your phone. Only you see them
// (public.contact_names, supabase/migrations/12). They're loaded once after sign-in and kept here, so
// every screen can show your name for someone in place of the one they chose. A "foryoucontacts"
// event goes out whenever they change, so open screens can repaint.
import { supabase } from './db.js';
import { escapeHtml } from './util.js';
import { openModal, closeModal, toast, friendlyError } from './ui.js';
import { state } from '../state.js';

let saved = new Map();

const changed = () => window.dispatchEvent(new Event('foryoucontacts'));

export async function loadContactNames() {
  try {
    const { data, error } = await supabase.from('contact_names').select('contact_id, name');
    if (error) return;
    saved = new Map((data || []).map((r) => [r.contact_id, r.name]));
    changed();
  } catch { /* everyone keeps the name they chose */ }
}

export function forgetContactNames() { saved = new Map(); }

// Your saved name for someone, or '' when you haven't saved one.
export const savedName = (id) => (id && saved.get(id)) || '';

// What to call someone: your saved name, else the name they gave.
export const nameOf = (id, ownName) => savedName(id) || ownName || 'Someone';

export async function saveContactName(id, name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) return clearContactName(id);
  const { error } = await supabase.from('contact_names').upsert(
    { owner_id: state.user.id, contact_id: id, name: clean, updated_at: new Date().toISOString() },
    { onConflict: 'owner_id,contact_id' });
  if (error) throw new Error(error.message);
  saved.set(id, clean);
  changed();
}

export async function clearContactName(id) {
  const { error } = await supabase.from('contact_names').delete().eq('owner_id', state.user.id).eq('contact_id', id);
  if (error) throw new Error(error.message);
  saved.delete(id);
  changed();
}

// The "Edit contact" form. `person` needs id and full_name (the name they chose).
export function openEditContact(person) {
  const own = person.full_name || person.username || 'Someone';
  const mine = savedName(person.id);
  const modal = openModal(`
    <h3>Edit contact</h3>
    <p class="muted small">Only you see this name. ${escapeHtml(own)} won't know you changed it.</p>
    <label for="ec-name">Name</label>
    <input id="ec-name" maxlength="60" value="${escapeHtml(mine || own)}" autocomplete="off">
    <button class="btn btn-gold btn-block" style="margin-top:14px" id="ec-save">Save</button>
    ${mine ? `<button class="btn btn-plain btn-block" style="margin-top:6px" id="ec-reset">Use their name (${escapeHtml(own)})</button>` : ''}
    <div id="ec-msg" class="form-msg"></div>`);
  const input = modal.querySelector('#ec-name');
  const msg = modal.querySelector('#ec-msg');
  input.focus();
  input.select();
  const save = async () => {
    const name = input.value.trim();
    if (!name) { msg.className = 'form-msg err'; msg.textContent = 'Enter a name.'; return; }
    try {
      if (name === own && !mine) { closeModal(); return; }
      if (name === own) await clearContactName(person.id); else await saveContactName(person.id, name);
      closeModal();
      toast('Contact saved.');
    } catch (e) { msg.className = 'form-msg err'; msg.textContent = friendlyError(e); }
  };
  modal.querySelector('#ec-save').addEventListener('click', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const reset = modal.querySelector('#ec-reset');
  if (reset) reset.addEventListener('click', async () => {
    try { await clearContactName(person.id); closeModal(); toast('Contact saved.'); }
    catch (e) { msg.className = 'form-msg err'; msg.textContent = friendlyError(e); }
  });
}
