#!/usr/bin/env bash
# Runs inside the Android emulator on GitHub Actions (.github/workflows/android.yml).
#
#  1. The release build installs and opens the live ForYou site.
#  2. The debug build (same code, plus a test page) is sent to the background and asked, through the
#     same bridge the site uses, for a message notification and an incoming call. The call must ring
#     with a full-screen alert, and stop when the page ends it. The background inbox check must be
#     scheduled and must run without crashing.
#
# Screenshots, logs and results.txt go to ci-results/.
set -u
APKS="${1:-apks}"
OUT=ci-results
PKG=com.foryou.chat
DBG=com.foryou.chat.debug
mkdir -p "$OUT"
: > "$OUT/results.txt"
FAILED=0

pass() { echo "PASS: $1" | tee -a "$OUT/results.txt"; }
fail() { echo "FAIL: $1" | tee -a "$OUT/results.txt"; echo "::error::$1"; FAILED=1; }
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
notifications() { adb shell dumpsys notification --noredact; }
wait_for() {
  local end=$((SECONDS + $1)); shift
  while [ "$SECONDS" -lt "$end" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
has_notification() { notifications | grep -qF "$1"; }
no_notification() { ! has_notification "$1"; }

adb wait-for-device
adb shell settings put system screen_off_timeout 1800000
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
adb logcat -c

# ---------------------------------------------------------------- 1. release build opens the site
RELEASE=$(ls "$APKS"/release/*.apk 2>/dev/null | head -1)
if [ -n "$RELEASE" ] && adb install -r "$RELEASE"; then pass "release APK installs"; else fail "release APK did not install"; fi
for p in POST_NOTIFICATIONS CAMERA RECORD_AUDIO; do adb shell pm grant "$PKG" android.permission.$p; done
adb shell am start -W -n "$PKG/.MainActivity"
sleep 25
shot 01-release-home
if adb shell dumpsys window | grep -E "mCurrentFocus" | grep -q "$PKG/"; then pass "app opens and stays open"; else fail "app did not stay open"; fi
adb logcat -d -s ForYou:V > "$OUT/release-log.txt"
if grep -qF "Loaded https://foryou-chat.pages.dev/" "$OUT/release-log.txt" && ! grep -qF "offline page" "$OUT/release-log.txt"; then
  pass "ForYou shows inside the app"
else
  fail "ForYou did not show inside the app"
fi
adb shell input keyevent KEYCODE_HOME

# ---------------------------------------------------------------- 2. notifications and ringing through the bridge
DEBUG=$(ls "$APKS"/debug/*.apk 2>/dev/null | head -1)
if [ -n "$DEBUG" ] && adb install -r "$DEBUG"; then pass "debug APK installs"; else fail "debug APK did not install"; fi
adb shell pm grant "$DBG" android.permission.POST_NOTIFICATIONS
adb shell appops set "$DBG" USE_FULL_SCREEN_INTENT allow
adb logcat -c
adb shell am start -W -n "$DBG/com.foryou.chat.MainActivity" --es testUrl file:///android_asset/test/bridge-test.html
sleep 3
shot 02-bridge-test
# Out of sight, as when a message or call arrives while you're in another app.
adb shell input keyevent KEYCODE_HOME

if wait_for 30 has_notification "Hello from the bridge test"; then pass "message notification shows"; else fail "message notification did not show"; fi
if wait_for 20 has_notification "Test Caller"; then pass "incoming call rings"; else fail "incoming call did not ring"; fi
notifications > "$OUT/notifications-call.txt"
adb shell cmd statusbar expand-notifications
sleep 2
shot 03-notifications
adb shell cmd statusbar collapse
if grep -qE "fullscreenIntent=PendingIntent" "$OUT/notifications-call.txt"; then pass "call uses a full-screen alert"; else fail "call has no full-screen alert"; fi
if grep -qE "category=call|mId='calls'" "$OUT/notifications-call.txt"; then pass "call uses the Calls channel"; else fail "call is not on the Calls channel"; fi

adb shell dumpsys jobscheduler > "$OUT/jobs.txt"
if grep -qF "$DBG/com.foryou.chat.InboxJob" "$OUT/jobs.txt"; then pass "background inbox check is scheduled"; else fail "background inbox check is not scheduled"; fi
adb shell cmd jobscheduler run -f "$DBG" 4242 >/dev/null 2>&1
sleep 8
adb logcat -d -s ForYou:V > "$OUT/debug-log.txt"
if grep -qE "Inbox check (failed|scheduled)|Inbox checked" "$OUT/debug-log.txt"; then pass "background inbox check runs"; else fail "background inbox check did not run"; fi

if wait_for 40 no_notification "Test Caller"; then pass "ringing stops when the call ends"; else fail "ringing did not stop"; fi
shot 04-after-call

adb logcat -d -b crash > "$OUT/crashes.txt" 2>/dev/null
if grep -qF "com.foryou.chat" "$OUT/crashes.txt"; then fail "the app crashed (see crashes.txt)"; else pass "no crashes"; fi
adb logcat -d | grep -iE "foryou|AndroidRuntime" | tail -400 > "$OUT/logcat.txt"

echo
cat "$OUT/results.txt"
exit $FAILED
