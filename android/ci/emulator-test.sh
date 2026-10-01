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
ui_dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb shell cat /sdcard/ui.xml; }
tap_text() {
  local bounds
  bounds=$(ui_dump | tr '>' '\n' | grep -F "text=\"$1\"" | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1)
  [ -n "$bounds" ] || return 1
  local x1 y1 x2 y2
  read -r x1 y1 x2 y2 <<<"$(echo "$bounds" | grep -oE '[0-9]+' | tr '\n' ' ')"
  adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
}
no_notification() { ! has_notification "$1"; }
# The ringing call itself (tag "call", id 1). A missed-call note can still name the caller.
ringing() { notifications | grep -qE "\|$DBG\|1\|call\||pkg=$DBG user=[^ ]+ id=1 tag=call "; }
not_ringing() { ! ringing; }
page_log() { adb logcat -d -s ForYou:V | grep -qF "$1"; }

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

# Out of sight, Android soon pauses the page (that's why calls also come by push). Back on screen it
# carries on and ends the call, and the ringing must stop.
adb shell am start -n "$DBG/com.foryou.chat.MainActivity" >/dev/null
if wait_for 40 page_log "page: call ended" && wait_for 10 not_ringing; then pass "ringing stops when the call ends"; else fail "ringing did not stop"; fi
shot 04-after-call

# ---------------------------------------------------------------- 3. pushes with the app closed
# A Firebase push starts the app's process by itself; the debug build's test receiver does the same
# with an adb broadcast, and hands the push to the same code.
# adb shell runs one command line on the phone, so each value is quoted again for the phone's shell
# (none of them contain a single quote).
push() {
  local a line="am broadcast -a com.foryou.chat.TEST_PUSH -n $DBG/com.foryou.chat.DebugPushReceiver"
  for a in "$@"; do line="$line '$a'"; done
  adb shell "$line" >/dev/null
}
close_app() {
  adb shell input keyevent KEYCODE_HOME
  sleep 2
  local pid
  pid=$(adb shell pidof "$DBG" | tr -d '\r' | awk '{print $1}')
  [ -n "$pid" ] && { adb shell run-as "$DBG" kill -9 "$pid" 2>/dev/null || adb shell kill -9 "$pid" 2>/dev/null; }
  sleep 1
  [ -z "$(adb shell pidof "$DBG" | tr -d '\r')" ]
}
KEY=fedcba9876543210fedcba9876543210
if close_app; then pass "app is closed"; else fail "could not close the app"; fi
push --es type call --es roomKey "$KEY" --es from 00000000-0000-0000-0000-0000000000aa --es fromName "Push Caller"
if wait_for 20 has_notification "Push Caller"; then pass "call push rings with the app closed"; else fail "call push did not ring"; fi
notifications > "$OUT/notifications-push-call.txt"
grep -qE "fullscreenIntent=PendingIntent" "$OUT/notifications-push-call.txt" && pass "pushed call uses a full-screen alert" || fail "pushed call has no full-screen alert"
adb shell cmd statusbar expand-notifications
sleep 2
shot 05-push-call
adb shell cmd statusbar collapse
push --es type cancel --es roomKey "$KEY" --es fromName "Push Caller"
if wait_for 20 not_ringing; then pass "cancelled call stops ringing"; else fail "cancelled call kept ringing"; fi
if wait_for 10 has_notification "Missed video call"; then pass "missed call is shown"; else fail "missed call not shown"; fi

if close_app; then :; fi
push --es type message --es tag foryou-dm-pushtest --es title "Push Ann" --es body "Instant hello from a push" --es hash "#/chat/pushtest"
if wait_for 20 has_notification "Instant hello from a push"; then pass "message push shows with the app closed"; else fail "message push did not show"; fi

# Answer on the ringing screen opens the app.
if close_app; then :; fi
push --es type call --es roomKey "$KEY" --es from 00000000-0000-0000-0000-0000000000aa --es fromName "Push Caller"
wait_for 20 has_notification "Push Caller" >/dev/null
adb shell cmd statusbar expand-notifications
sleep 2
if tap_text "Answer" || tap_text "ANSWER"; then
  sleep 5
  if adb shell dumpsys window | grep -E "mCurrentFocus" | grep -q "$DBG/"; then pass "Answer opens the app"; else fail "Answer did not open the app"; fi
  # The page picks up the answered call (in ForYou itself, it then joins it).
  if wait_for 20 page_log '"action":"accept"'; then pass "the page gets the answered call"; else fail "the page did not get the answered call"; fi
  if not_ringing; then pass "ringing stops after Answer"; else fail "still ringing after Answer"; fi
else
  fail "could not find the Answer button"
fi
shot 06-after-answer
adb logcat -d -s ForYou:V > "$OUT/push-log.txt"

# ---------------------------------------------------------------- 4. the app updates itself
# A local server stands in for the website: it offers "version 9.9.9" (really this same debug build).
# The app must find it, download it, check its SHA-256, and hand it to Android's installer, whose
# "Update" button then replaces the installed app.
UPD=$(mktemp -d)
mkdir -p "$UPD/app"
cp "$DEBUG" "$UPD/app/foryou.apk"
printf '{"versionName":"9.9.9","versionCode":99,"size":%s,"sha256":"%s"}\n' \
  "$(stat -c %s "$UPD/app/foryou.apk")" "$(sha256sum "$UPD/app/foryou.apk" | cut -d' ' -f1)" > "$UPD/app/android.json"
python3 -m http.server 8000 --directory "$UPD" >/dev/null 2>&1 &
SERVER=$!
sleep 2
adb shell appops set "$DBG" REQUEST_INSTALL_PACKAGES allow
before_update=$(adb shell dumpsys package "$DBG" | grep -m1 lastUpdateTime | tr -d '\r')
adb shell am force-stop "$DBG"   # a fresh start that reads the test's update settings
adb logcat -c
adb shell am start -W -n "$DBG/com.foryou.chat.MainActivity" --es testUrl file:///android_asset/test/bridge-test.html \
  --es updateBase http://10.0.2.2:8000/ --ez autoUpdate true >/dev/null
handed() { adb logcat -d -s ForYou:V | grep -qF "Update handed to the installer"; }
if wait_for 60 handed; then pass "update downloads, matches the published file and goes to the installer"; else fail "update did not reach the installer"; adb logcat -d -s ForYou:V | tail -20 >> "$OUT/results.txt"; fi
sleep 3
shot 07-update-confirm
if wait_for 20 tap_text "Update"; then
  updated() { [ "$(adb shell dumpsys package "$DBG" | grep -m1 lastUpdateTime | tr -d '\r')" != "$before_update" ]; }
  if wait_for 60 updated; then pass "Android's installer updates the app"; else fail "the app was not replaced"; fi
else
  fail "could not find the installer's Update button"
fi
shot 08-after-update
kill "$SERVER" 2>/dev/null

if grep -qF "Push token ready" "$OUT/release-log.txt"; then pass "release app gets a push token"; else echo "NOTE: no push token in the release app (expected until google-services.json is added)" | tee -a "$OUT/results.txt"; fi

adb logcat -d -b crash > "$OUT/crashes.txt" 2>/dev/null
if grep -qF "com.foryou.chat" "$OUT/crashes.txt"; then fail "the app crashed (see crashes.txt)"; else pass "no crashes"; fi
adb logcat -d | grep -iE "foryou|AndroidRuntime" | tail -400 > "$OUT/logcat.txt"

echo
cat "$OUT/results.txt"
exit $FAILED
