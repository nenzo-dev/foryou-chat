// The message box at the bottom of a DM or a group: text, emoji, photos and files, voice notes, "shorten
// with AI", and the two modes that change what Send does -- replying to a message, and editing one of
// your own. chat.js and room.js each create one and only say how a message is sent or saved.
import { supabase } from './db.js';
import { uid } from './util.js';
import { EMOJI_GROUPS, recentEmoji, pushRecent } from './emoji.js';
import { VoiceRecorder, MIN_VOICE_SECONDS, extensionFor } from './voice.js';
import { explainMediaError } from './rtc.js';
import { previewText } from './msgui.js';
import { toast, friendlyError } from './ui.js';
import { ICON } from './icons.js';

const MAX_FILE = 15 * 1024 * 1024;
async function imageSize(file) {
  try {
    const bmp = await createImageBitmap(file);
    const dims = { w: bmp.width, h: bmp.height };
    if (bmp.close) bmp.close();
    return dims;
  } catch { return null; }
}

const safeName = (name) => String(name || 'file').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(-80);

/*
  slot      element to render into
  folder    storage folder for uploads (the conversation id, or room-<id>)
  send      async ({ body, attachment, replyTo }) => void
  edit      async (message, body) => void
  nameFor   (userId) => name shown in "Replying to …"
  me        the signed-in person's id
*/
export function createComposer(slot, { folder, send, edit, nameFor, me }) {
  slot.classList.add('composer-wrap');
  slot.innerHTML = `
    <div class="compose-context">
      <span class="cc-icon"></span>
      <div class="cc-body"><span class="cc-title"></span><span class="cc-text"></span></div>
      <button class="cc-close" type="button" aria-label="Cancel">${ICON.close}</button>
    </div>
    <div class="emoji-panel hidden"></div>
    <div class="composer">
      <button class="btn-icon c-emoji" type="button" aria-label="Emoji">${ICON.emoji}</button>
      <input type="file" class="hidden c-file" accept="image/*,application/pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.zip">
      <button class="btn-icon c-attach" type="button" aria-label="Attach a photo or file">${ICON.attach}</button>
      <div class="composer-input-wrap">
        <textarea class="c-input" rows="1" placeholder="Message" enterkeyhint="send"></textarea>
        <button class="ai-compose-btn c-ai" type="button" title="Shorten with AI" aria-label="Shorten with AI">${ICON.sparkle}</button>
      </div>
      <button class="btn-icon c-mic" type="button" aria-label="Record a voice message">${ICON.mic}</button>
      <button class="btn-icon send-btn c-send" type="button" aria-label="Send">${ICON.send}</button>
      <div class="record-bar hidden">
        <span class="rec-dot"></span><span class="rec-time">0:00</span>
        <span class="rec-level"><i></i><i></i><i></i><i></i><i></i></span>
        <button class="btn btn-plain btn-sm rec-cancel" type="button">Cancel</button>
        <button class="btn-icon send-btn rec-send" type="button" aria-label="Send voice message">${ICON.send}</button>
      </div>
    </div>`;

  const $ = (sel) => slot.querySelector(sel);
  const input = $('.c-input'), sendBtn = $('.c-send'), micBtn = $('.c-mic'), ctx = $('.compose-context');
  const emojiPanel = $('.emoji-panel'), fileInput = $('.c-file'), aiBtn = $('.c-ai'), recordBar = $('.record-bar');
  let replyingTo = null, editing = null, busy = false;

  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
  const syncButtons = () => {
    slot.classList.toggle('has-text', !!input.value.trim() || !!editing);
    slot.classList.toggle('editing', !!editing);
    sendBtn.innerHTML = editing ? ICON.check : ICON.send;
    sendBtn.setAttribute('aria-label', editing ? 'Save changes' : 'Send');
  };

  function showContext(mode, message) {
    ctx.dataset.mode = mode;
    $('.cc-icon').innerHTML = mode === 'edit' ? ICON.edit : ICON.reply;
    $('.cc-title').textContent = mode === 'edit' ? 'Edit message' : `Replying to ${message.sender_id === me ? 'yourself' : nameFor(message.sender_id)}`;
    $('.cc-text').textContent = previewText(message);
    ctx.classList.add('show');
  }

  function replyTo(message) {
    if (editing) cancel();
    replyingTo = message;
    showContext('reply', message);
    input.focus();
  }

  function startEdit(message) {
    replyingTo = null;
    editing = message;
    showContext('edit', message);
    input.value = message.body || '';
    autosize(); syncButtons();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function cancel() {
    if (editing) { input.value = ''; autosize(); }
    replyingTo = null; editing = null;
    ctx.classList.remove('show');
    syncButtons();
  }

  $('.cc-close').addEventListener('click', cancel);
  input.addEventListener('input', () => { autosize(); syncButtons(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape' && (editing || replyingTo)) { e.preventDefault(); cancel(); }
  });
  sendBtn.addEventListener('click', submit);

  async function submit() {
    if (busy) return;
    const text = input.value.trim();
    emojiPanel.classList.add('hidden');
    if (editing) {
      const msg = editing;
      if (text === (msg.body || '').trim()) { cancel(); return; }
      if (!text && !msg.attachment) { toast('Type something, or delete the message instead.'); return; }
      busy = true;
      try { await edit(msg, text); cancel(); }
      catch (e) { toast(friendlyError(e)); }
      finally { busy = false; }
      return;
    }
    if (!text) return;
    const replyId = replyingTo ? replyingTo.id : null;
    input.value = ''; autosize(); syncButtons();
    const hadReply = replyingTo;
    cancel();
    try { await send({ body: text, replyTo: replyId }); }
    catch (e) {
      // Put the words back so nothing typed is lost.
      if (!input.value) { input.value = text; autosize(); syncButtons(); }
      if (hadReply) replyTo(hadReply);
      toast(friendlyError(e));
    }
  }

  aiBtn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) { toast('Type something first.'); return; }
    aiBtn.disabled = true; aiBtn.classList.add('working');
    try {
      const { data, error } = await supabase.functions.invoke('ai-compose', { body: { text } });
      if (error) throw error;
      if (data && data.error) { toast(data.error); return; }
      if (data && data.text) { input.value = data.text; autosize(); syncButtons(); }
    } catch (e) { toast(friendlyError(e)); }
    finally { aiBtn.disabled = false; aiBtn.classList.remove('working'); }
  });

  $('.c-emoji').addEventListener('click', () => {
    if (emojiPanel.classList.contains('hidden')) { paintEmoji(); emojiPanel.classList.remove('hidden'); } else emojiPanel.classList.add('hidden');
  });
  function paintEmoji() {
    const recent = recentEmoji();
    const groups = recent.length ? [{ id: 'recent', label: 'Recent', list: recent }, ...EMOJI_GROUPS] : EMOJI_GROUPS;
    emojiPanel.innerHTML = groups.map((g) => `<div class="grp-label">${g.label}</div><div class="emoji-grid">${g.list.map((e) => `<button type="button">${e}</button>`).join('')}</div>`).join('');
    emojiPanel.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + b.textContent + input.value.slice(input.selectionEnd ?? at);
      input.focus(); autosize(); syncButtons(); pushRecent(b.textContent);
    }));
  }

  $('.c-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_FILE) { toast('That file is larger than 15 MB.'); return; }
    const path = `${folder}/${uid()}-${safeName(file.name)}`;
    const replyId = replyingTo ? replyingTo.id : null;
    slot.classList.add('uploading');
    try {
      // A photo's shape is saved with it, so the thread can reserve the right space before it loads.
      const dims = (file.type || '').startsWith('image/') ? await imageSize(file) : null;
      const { error } = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream' });
      if (error) throw error;
      await send({ body: '', attachment: { type: file.type || 'application/octet-stream', path, name: file.name, size: file.size, ...(dims || {}) }, replyTo: replyId });
      if (!editing) cancel();
    } catch (e) { toast(friendlyError(e)); }
    finally { slot.classList.remove('uploading'); }
  });

  // Voice notes: tap the mic to start, then send or cancel from the recording bar.
  let recorder = null, recTimer = null;
  micBtn.addEventListener('click', async () => {
    if (recorder) return;
    try { recorder = new VoiceRecorder(); await recorder.start(); }
    catch (e) { toast(explainMediaError(e)); recorder = null; return; }
    recorder.onLimit = () => finishRecording();
    recordBar.classList.remove('hidden');
    const levels = [...recordBar.querySelectorAll('.rec-level i')];
    const paint = () => {
      if (!recorder) return;
      const s = Math.floor(recorder.seconds());
      recordBar.querySelector('.rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      levels.forEach((b, i) => { b.style.transform = `scaleY(${Math.max(0.15, Math.min(1, recorder.level * (1.4 - Math.abs(i - 2) * 0.25)))})`; });
    };
    paint();
    recTimer = setInterval(paint, 100);
  });
  recordBar.querySelector('.rec-cancel').addEventListener('click', () => {
    if (recorder) recorder.cancel();
    recorder = null; clearInterval(recTimer); recordBar.classList.add('hidden');
  });
  recordBar.querySelector('.rec-send').addEventListener('click', () => finishRecording());

  async function finishRecording() {
    if (!recorder) return;
    clearInterval(recTimer);
    recordBar.classList.add('hidden');
    const r = recorder; recorder = null;
    let result;
    try { result = await r.stop(); } catch { return; }
    if (result.duration < MIN_VOICE_SECONDS) { toast('That was too short to send.'); return; }
    const path = `${folder}/${uid()}.${extensionFor(result.mime)}`;
    const replyId = replyingTo ? replyingTo.id : null;
    slot.classList.add('uploading');
    try {
      const { error } = await supabase.storage.from('attachments').upload(path, result.blob, { contentType: result.mime });
      if (error) throw error;
      await send({ body: '', attachment: { type: result.mime, path, name: 'Voice message', duration: result.duration, peaks: result.peaks }, replyTo: replyId });
      if (!editing) cancel();
    } catch (e) { toast(friendlyError(e)); }
    finally { slot.classList.remove('uploading'); }
  }

  syncButtons();
  return {
    replyTo, startEdit, cancel,
    get editingId() { return editing ? editing.id : null; },
    focus: () => input.focus(),
    destroy() { if (recorder) recorder.cancel(); recorder = null; clearInterval(recTimer); },
  };
}
