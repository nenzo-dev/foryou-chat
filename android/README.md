# ForYou for Android

The Android app shows https://foryou-chat.pages.dev and adds what a phone app needs:

- camera and microphone for video calls and blind dates
- message notifications, and a full-screen ringing screen for incoming calls
- a check for new messages about every 15 minutes while the app is closed (`InboxJob`, using the
  device code from `supabase/migrations/08`)
- the screen stays on during calls

The web app talks to it through `window.ForYouAndroid` (see `js/lib/android.js`).

## Builds

There's no local Android setup. `.github/workflows/android.yml` builds the app on every push that
changes this folder, tests it on an Android 14 emulator (`ci/emulator-test.sh`), and, when it's
signed with ForYou's release key, publishes it to the website as `app/foryou.apk`. Test screenshots
and logs go to the `android-ci` release on GitHub.

The release key is kept outside the repository and reaches the build through the `ANDROID_SIGNING`
secret. To release a new version, raise `versionCode` and `versionName` in `app/build.gradle`.
