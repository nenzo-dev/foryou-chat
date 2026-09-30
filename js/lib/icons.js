// Small line-art icon set (stroke uses currentColor, so a button's own CSS color/fill controls it) --
// used instead of raw emoji glyphs, which render as colorful OS-native pictures that clash with the
// app's own amber/black theme no matter what CSS is applied to the element around them.
const svg = (body, vb = 24) => `<svg viewBox="0 0 ${vb} ${vb}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
const s = 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

export const ICON = {
  back: svg(`<path d="M15 5 8 12l7 7" ${s} fill="none"/>`),
  close: svg(`<path d="M6 6l12 12M18 6 6 18" ${s}/>`),
  emoji: svg(`<circle cx="12" cy="12" r="8.3" ${s}/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><path d="M8.3 14.2c1 1.4 2.3 2.1 3.7 2.1s2.7-.7 3.7-2.1" ${s}/>`),
  attach: svg(`<path d="M16.5 6.5 8.4 14.6a3 3 0 0 0 4.2 4.2l8-8a5 5 0 0 0-7-7l-8 8a7 7 0 0 0 9.9 9.9" ${s}/>`),
  mic: svg(`<rect x="9" y="3" width="6" height="11" rx="3" ${s}/><path d="M5.5 11a6.5 6.5 0 0 0 13 0" ${s}/><path d="M12 17.5V21M9 21h6" ${s}/>`),
  micOff: svg(`<path d="M15 9.4V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5" ${s}/><path d="M18.5 11a6.4 6.4 0 0 1-1 3.4M5.5 11a6.5 6.5 0 0 0 10.2 5.4" ${s}/><path d="M12 17.5V21M9 21h6M4 4l16 16" ${s}/>`),
  send: svg(`<path d="M4 12 20 4l-6 16-3-7-7-1Z" ${s} stroke-linejoin="round" fill="currentColor" fill-opacity=".08"/>`),
  video: svg(`<rect x="2.5" y="6.5" width="13" height="11" rx="2.5" ${s}/><path d="m21.5 8.3-4.5 3 4.5 3z" ${s} stroke-linejoin="round"/>`),
  videoOff: svg(`<path d="M9 6.5h4a2.5 2.5 0 0 1 2.5 2.5v4M15.5 16a2.5 2.5 0 0 1-2 1.5H5A2.5 2.5 0 0 1 2.5 15V9A2.5 2.5 0 0 1 4.3 6.6" ${s}/><path d="m21.5 8.3-4.5 3 4.5 3zM3 3l18 18" ${s}/>`),
  phoneDown: svg(`<path d="M3.2 14.4c-.6-.6-.6-1.7.1-2.3C5.6 10 8.7 8.8 12 8.8s6.4 1.2 8.7 3.3c.7.6.7 1.7.1 2.3l-1.5 1.5c-.5.5-1.4.6-2 .1l-1.9-1.4c-.4-.3-.6-.8-.5-1.3l.2-1.3a11 11 0 0 0-6.2 0l.2 1.3c.1.5-.1 1-.5 1.3l-1.9 1.4c-.6.5-1.5.4-2-.1Z" fill="currentColor"/>`),
  screen: svg(`<rect x="2.5" y="4" width="19" height="13" rx="2.2" ${s}/><path d="M8 21h8M12 17v4M12 13.5V8M9.5 10.5 12 8l2.5 2.5" ${s}/>`),
  flip: svg(`<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.3-2h5.2l1.3 2h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5Z" ${s}/><path d="M9 11.5a3.2 3.2 0 0 1 5.6-1.4M15 13.5a3.2 3.2 0 0 1-5.6 1.4M14.8 8.6v1.6h-1.6M9.2 16.4v-1.6h1.6" ${s}/>`),
  sparkle: svg(`<path d="M12 3.5c.5 3 1.7 4.6 4.5 5.5-2.8.9-4 2.5-4.5 5.5-.5-3-1.7-4.6-4.5-5.5 2.8-.9 4-2.5 4.5-5.5Z" ${s} stroke-linejoin="round"/><path d="M18.5 15.5c.3 1.6.9 2.4 2.5 2.8-1.6.4-2.2 1.2-2.5 2.8-.3-1.6-.9-2.4-2.5-2.8 1.6-.4 2.2-1.2 2.5-2.8Z" ${s} stroke-linejoin="round"/>`),
  play: svg(`<path d="M6 4.5v15l14-7.5Z" fill="currentColor" stroke="none"/>`),
  pause: svg(`<rect x="5.5" y="4.5" width="4.5" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="4.5" height="15" rx="1.2" fill="currentColor"/>`),
  file: svg(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" ${s}/><path d="M14 3v5h5" ${s}/>`),
  people: svg(`<circle cx="9" cy="8.5" r="3" ${s}/><path d="M3.5 19a5.5 5.5 0 0 1 11 0" ${s}/><circle cx="17" cy="9" r="2.4" ${s}/><path d="M15 12.2c2.6.2 4.5 1.9 5.5 3.9" ${s}/>`),
  stop: svg(`<rect x="5.5" y="5.5" width="13" height="13" rx="3" fill="currentColor"/>`),
  reply: svg(`<path d="M10 6 4 12l6 6" ${s}/><path d="M4.5 12H14a6 6 0 0 1 6 6v1" ${s}/>`),
  copy: svg(`<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5" ${s}/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" ${s}/>`),
  edit: svg(`<path d="M4 20h4L19.3 8.7a2.1 2.1 0 0 0 0-3L18.3 4.7a2.1 2.1 0 0 0-3 0L4 16Z" ${s}/><path d="m13.5 6.5 4 4" ${s}/>`),
  trash: svg(`<path d="M4 7h16M9.5 7V4.8c0-.4.4-.8.8-.8h3.4c.4 0 .8.4.8.8V7M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7" ${s}/><path d="M10 11v6M14 11v6" ${s}/>`),
  check: svg(`<path d="m5 12.5 4.5 4.5L19 7.5" ${s}/>`),
  ban: svg(`<circle cx="12" cy="12" r="8.3" ${s}/><path d="m6.2 6.2 11.6 11.6" ${s}/>`),
  download: svg(`<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" ${s}/>`),
  plus: svg(`<path d="M12 5v14M5 12h14" ${s}/>`),
  link: svg(`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" ${s}/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" ${s}/>`),
  heart: svg(`<path d="M12 20s-7.5-4.4-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.6 12 20 12 20Z" ${s}/>`),
  heartFill: svg(`<path d="M12 20s-7.5-4.4-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.6 12 20 12 20Z" fill="currentColor"/>`),
  eye: svg(`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" ${s}/><circle cx="12" cy="12" r="3" ${s}/>`),
  eyeOff: svg(`<path d="M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.5 3.3M6.6 6.6A16.5 16.5 0 0 0 2.5 12S6 18.5 12 18.5c1.8 0 3.3-.6 4.6-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" ${s}/>`),
  // A blindfold: a band across the eyes with its knot and loose tails on one side.
  blindfold: svg(`<path d="M2.5 9.2c3-1.4 6.2-2.1 9.5-2.1s6.5.7 9.5 2.1v4.9c-3-1.2-6.2-1.8-9.5-1.8s-6.5.6-9.5 1.8Z" ${s}/><path d="M6.2 10.4q1.9 1.4 3.8 0M14 10.4q1.9 1.4 3.8 0" ${s} stroke-width="1.5"/><path d="M19.6 14.2 20.4 18.5M21 13.8l2 3.6" ${s}/>`),
  crown: svg(`<path d="m3.5 8 4.2 3.3L12 5l4.3 6.3L20.5 8l-1.6 10H5.1Z" ${s}/>`),
  lock: svg(`<rect x="5" y="10.5" width="14" height="10" rx="2.5" ${s}/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" ${s}/>`),
  globe: svg(`<circle cx="12" cy="12" r="8.5" ${s}/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5Z" ${s}/>`),
  signal: svg(`<rect x="4" y="14" width="3" height="6" rx="1" fill="currentColor"/><rect x="10.5" y="10" width="3" height="10" rx="1" fill="currentColor"/><rect x="17" y="5" width="3" height="15" rx="1" fill="currentColor"/>`),
  more: svg(`<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>`),
  share: svg(`<circle cx="18" cy="5.5" r="2.5" ${s}/><circle cx="6" cy="12" r="2.5" ${s}/><circle cx="18" cy="18.5" r="2.5" ${s}/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1" ${s}/>`),
  chevronUp: svg(`<path d="m6 15 6-6 6 6" ${s}/>`),
  gear: svg(`<circle cx="12" cy="12" r="3" ${s}/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" ${s}/>`),
};
