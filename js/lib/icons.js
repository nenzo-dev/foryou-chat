// Small line-art icon set (stroke uses currentColor, so a button's own CSS color/fill controls it) --
// used instead of raw emoji glyphs, which render as colorful OS-native pictures that clash with the
// app's own amber/black theme no matter what CSS is applied to the element around them.
const svg = (body, vb = 24) => `<svg viewBox="0 0 ${vb} ${vb}" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
const s = 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

export const ICON = {
  back: svg(`<path d="M15 5 8 12l7 7" ${s} fill="none"/>`),
  emoji: svg(`<circle cx="12" cy="12" r="8.3" ${s}/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><path d="M8.3 14.2c1 1.4 2.3 2.1 3.7 2.1s2.7-.7 3.7-2.1" ${s}/>`),
  attach: svg(`<path d="M16.5 6.5 8.4 14.6a3 3 0 0 0 4.2 4.2l8-8a5 5 0 0 0-7-7l-8 8a7 7 0 0 0 9.9 9.9" ${s}/>`),
  mic: svg(`<rect x="9" y="3" width="6" height="11" rx="3" ${s}/><path d="M5.5 11a6.5 6.5 0 0 0 13 0" ${s}/><path d="M12 17.5V21M9 21h6" ${s}/>`),
  send: svg(`<path d="M4 12 20 4l-6 16-3-7-7-1Z" ${s} stroke-linejoin="round" fill="currentColor" fill-opacity=".08"/>`),
  video: svg(`<rect x="2.5" y="6.5" width="13" height="11" rx="2.5" ${s}/><path d="m21.5 8.3-4.5 3 4.5 3z" ${s} stroke-linejoin="round"/>`),
  sparkle: svg(`<path d="M12 3.5c.5 3 1.7 4.6 4.5 5.5-2.8.9-4 2.5-4.5 5.5-.5-3-1.7-4.6-4.5-5.5 2.8-.9 4-2.5 4.5-5.5Z" ${s} stroke-linejoin="round"/><path d="M18.5 15.5c.3 1.6.9 2.4 2.5 2.8-1.6.4-2.2 1.2-2.5 2.8-.3-1.6-.9-2.4-2.5-2.8 1.6-.4 2.2-1.2 2.5-2.8Z" ${s} stroke-linejoin="round"/>`),
  play: svg(`<path d="M6 4.5v15l14-7.5Z" fill="currentColor" stroke="none"/>`),
  pause: svg(`<rect x="5.5" y="4.5" width="4.5" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="4.5" height="15" rx="1.2" fill="currentColor"/>`),
  file: svg(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" ${s}/><path d="M14 3v5h5" ${s}/>`),
  people: svg(`<circle cx="9" cy="8.5" r="3" ${s}/><path d="M3.5 19a5.5 5.5 0 0 1 11 0" ${s}/><circle cx="17" cy="9" r="2.4" ${s}/><path d="M15 12.2c2.6.2 4.5 1.9 5.5 3.9" ${s}/>`),
  stop: svg(`<rect x="5.5" y="5.5" width="13" height="13" rx="3" fill="currentColor"/>`),
};
