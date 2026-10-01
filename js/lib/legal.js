// ForYou's Terms of use, Privacy policy and Disclaimer, and a small renderer for them. The text is
// written in a tiny subset of Markdown: "# " and "## " headings, "- " list items, **bold**, and
// paragraphs separated by a blank line.
import { escapeHtml } from './util.js';

export const LEGAL_UPDATED = '1 October 2026';

export const LEGAL = {
  terms: {
    title: 'Terms of use',
    text: `# Terms of use

Last updated: ${LEGAL_UPDATED}

By creating an account or using ForYou, you agree to these terms.

## Who can use ForYou

- You must be at least 16 to use ForYou, and at least 18 to use Blind Dates.
- One account per person. Use your real name, and keep your password to yourself.

## Using ForYou

Don't use ForYou to:

- harass, threaten, bully or pretend to be someone else
- share sexual content of anyone under 18, or of anyone who hasn't agreed to it
- share anything illegal or hateful, or someone else's private information without their permission
- send spam or scams, or try to break, overload or get into parts of the service that aren't yours

Don't record or screenshot a call or a blind date without the permission of everyone in it.

## Blind dates

- Be respectful. The daters and the host can leave at any time, and nobody has to explain why.
- The host must not record, screenshot or share the daters' video.
- Meeting someone in person is your own decision. If you do, meet in a public place and tell a friend where you're going.

## AI replies

- "Reply for me" is off until you turn it on. While it's on, AI may answer messages for you when you're away, and every one of those replies is labelled as written by AI.
- You're responsible for what's sent from your account, including AI replies. Read them and follow up when you're back.
- AI can get things wrong. Don't rely on an AI reply for anything important.

## Your content

You own what you send. You allow ForYou to store and deliver it so the service works. Only send things you have the right to share.

## Suspension and deletion

We may suspend or delete accounts that break these terms. If your account is suspended, you can appeal from inside the app. A deleted account can't be brought back.

## The Android app

- Only install the app from foryou-chat.pages.dev. A copy from anywhere else may not be genuine.
- Keep the app updated when a new version is offered.
- These terms apply to the app too.

## Liability

ForYou is provided as it is. We work to keep it running, but we can't promise it will always be available or free of errors, and we aren't responsible for what other people send or do. Nothing in these terms takes away rights you have under Zambian law.

## Changes

We may update these terms. If you keep using ForYou after a change, the new terms apply. The date at the top shows when they last changed.`,
  },

  privacy: {
    title: 'Privacy policy',
    text: `# Privacy policy

Last updated: ${LEGAL_UPDATED}

This page explains what ForYou collects, why, and what happens to it.

## What we collect

- **Your account:** your email address, name, username, and the bio and photo you add. Your password is handled by our sign-in provider and stored only in a scrambled form that can't be turned back into the password. We never see it.
- **Messages and files:** the messages, photos, files and voice notes you send, your reactions, and when messages were read.
- **Groups:** the groups you create or join, and who is in them.
- **When you're online:** when you were last active, unless you turn off "Show when I'm online" in Settings.
- **Calls:** calls go straight between the people on the call, or through an encrypted relay when a direct connection isn't possible. We don't record calls. For a group call we keep who is on it only while it's going.
- **Blind dates:** the rooms you open or join, your seat, and when the blindfold was opened. Your name and photo are hidden from the other dater until then.
- **AI features:** if you turn on "Reply for me", the messages sent to you and some of your earlier messages are sent to our AI provider to write a reply in your style, and only while you're away. "Shorten with AI" sends the text you're writing. Nothing goes to the AI unless you use these features.
- **On your device:** the app keeps you signed in and remembers a few settings, such as your recent emoji.

## How we use it

- To deliver your messages and calls
- To show your profile to the people you talk to
- To run the features you turn on, such as AI replies and blind dates
- To keep ForYou safe, including suspending accounts that break the Terms of use

We don't sell your information and we don't show ads.

## Who can see it

- The people you chat with see your messages and your profile. Anyone signed in can see names, usernames and profile photos, so people can find each other.
- Group members see the group's messages.
- The ForYou administrator can see account details (name, username and email) to deal with suspensions, appeals and deleting accounts.
- The people who run ForYou can reach the database to keep it working. They don't read private messages unless they must, for example to deal with a report or a legal request.
- Our service providers handle data for us only to run ForYou: Supabase (database, sign-in and file storage), Cloudflare (hosting the app and relaying calls), Google Firebase (delivering notifications to the Android app) and Anthropic (AI replies and shortening, only when you use them).

## How long we keep it

- Messages stay until they're deleted. When you delete a message for everyone, its text and any attached file are removed straight away.
- Blind date rooms are removed once everyone has left, or soon after they go quiet.
- To have your account and everything in it deleted, contact us (see below). Deleting an account removes its profile, chats, messages, photos and files. Groups it made pass to another member.

## The Android app

The app shows the same ForYou service, so everything on this page applies to it. On top of that:

- It asks for your camera and microphone for calls, and for permission to show notifications.
- When someone calls or messages you, ForYou sends your phone a notification through Google Firebase Cloud Messaging, so it can ring or tell you even when the app is closed. The notification carries the caller's or sender's name and a short preview of the message.
- While you're signed in, the app also checks for new messages about every 15 minutes when it's closed, using a private code made for your phone. Signing out deletes that code and stops notifications to that phone.
- It keeps your screen on during a call.
- About once an hour it checks foryou-chat.pages.dev for a newer version of the app and tells you when one is ready. Updates only install when you tap Update and confirm on Android's own screen.

Uninstalling the app deletes everything it stored on your phone.

## Your rights

Under Zambia's Data Protection Act, 2021, you can ask to see the information we hold about you, ask us to correct it, or ask us to delete it.

## Contact

In the app, go to Settings and tap "Contact ForYou" to send us a message.

## Changes

If we change this policy, we'll update the date at the top of this page.`,
  },

  disclaimer: {
    title: 'Disclaimer',
    text: `# Disclaimer

Last updated: ${LEGAL_UPDATED}

## AI replies

Messages marked "AI auto-reply" were written by AI for someone while they were away. They can be wrong, and they aren't a promise from that person. The person will follow up themselves when they're back.

## Blind dates

ForYou doesn't check who people are. Names, photos and what people say about themselves may not be true. Take care when sharing personal details or meeting someone in person.

## Calls and messages

Calls and messages depend on your internet connection and your device, so they may sometimes be delayed or fail. Don't rely on ForYou in an emergency.

## Other people's content

Messages, photos and files come from the people who send them, not from ForYou.

## Links

Links shared in chats can take you to other websites, which have their own terms and privacy policies.`,
  },
};

const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

export function renderLegal(text) {
  return text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines[0].startsWith('# ')) return `<h1>${inline(lines[0].slice(2))}</h1>`;
    if (lines[0].startsWith('## ')) return `<h2>${inline(lines[0].slice(3))}</h2>`;
    if (lines.every((l) => l.startsWith('- '))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
    return `<p>${inline(lines.join(' '))}</p>`;
  }).join('');
}
