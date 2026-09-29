// Emoji for the message boxes: the picker's lists, the ones used lately, and small text helpers.
// Ported unchanged from MindCare's own emoji.js.

export const EMOJI_GROUPS = [
  { id: 'smileys', icon: '😀', label: 'Smileys', list: '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🫢 🤫 🫡 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠' },
  { id: 'hands', icon: '👍', label: 'Hands', list: '👍 👎 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 🫶 👐 🤲 🙏 ✍️ 💪 🫵 🤝 👀 🧠 🫂' },
  { id: 'hearts', icon: '❤️', label: 'Hearts and signs', list: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 💕 💞 💓 💗 💖 💘 💝 ✨ 🌟 ⭐ 🔥 💯 ✅ ❌ ❗ ❓ 💤 💬 🎉 🎊 🎁 🏆 🕊️ ☮️' },
  { id: 'nature', icon: '🌿', label: 'Nature', list: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦆 🦉 🐝 🦋 🐢 🐍 🐙 🐬 🐳 🌸 🌼 🌻 🌹 🌿 🍀 🌳 🌍 🌈 ☀️ 🌙 ☁️ ⛈️ ❄️' },
  { id: 'food', icon: '🍎', label: 'Food and drink', list: '🍎 🍌 🍉 🍇 🍓 🍒 🍍 🥭 🥑 🍅 🥕 🌽 🍞 🧀 🍗 🍖 🍔 🍟 🍕 🌮 🍝 🍚 🍜 🥗 🍰 🎂 🍫 🍿 ☕ 🍵 🥤 🍺' },
  { id: 'things', icon: '⚽', label: 'Activities and things', list: '⚽ 🏀 🏈 🎾 🎮 🎧 🎤 🎸 🎬 📱 💻 🖥️ ⌨️ 📷 💡 🔑 🔒 📌 📎 📚 ✏️ 📝 💼 🕒 ⏰ 🚀 ✈️ 🚗 🏠 💊 🩺' },
].map((g) => ({ ...g, list: g.list.split(' ') }));

const RECENT_KEY = 'fy_emoji_recent';

export function recentEmoji() {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 24) : []; } catch { return []; }
}

export function pushRecent(emoji) {
  const next = [emoji, ...recentEmoji().filter((x) => x !== emoji)].slice(0, 24);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

// One to three emoji and nothing else: shown large, without a bubble.
const ONLY = /^(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*\s*){1,3}$/u;
export const isEmojiOnly = (text) => ONLY.test(String(text || '').trim());

// Puts `insert` in place of the selection (start..end) of `text`; caret is where the cursor goes afterwards.
export function insertAtCaret(text, start, end, insert) {
  const a = Math.max(0, Math.min(start ?? text.length, text.length));
  const b = Math.max(a, Math.min(end ?? a, text.length));
  return { text: text.slice(0, a) + insert + text.slice(b), caret: a + insert.length };
}
