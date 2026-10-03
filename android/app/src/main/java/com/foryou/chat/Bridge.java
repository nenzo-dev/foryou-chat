package com.foryou.chat;

import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * window.ForYouAndroid in the web app (js/lib/android.js). Only ForYou's own site can use it: every
 * call is ignored unless the page showing is https://foryou-chat.pages.dev (links anywhere else open
 * outside the app, so no other site ever loads here).
 */
final class Bridge {
    private final MainActivity activity;

    Bridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String info() {
        if (!activity.isTrustedPage()) return "{}";
        return activity.info().toString();
    }

    /** A new message (or anything else worth a notification) while ForYou is out of sight. */
    @JavascriptInterface
    public void notify(String title, String body, String tag, String hash) {
        if (!activity.isTrustedPage() || MainActivity.isVisible()) return;
        if (tag == null || !tag.matches("foryou-[a-z0-9_\\-]{1,120}")) return;
        Notifier.message(activity, tag, clip(title, 80), clip(body, 400), MainActivity.safeHash(hash) ? hash : "");
        Store.markNotified(activity); // the background check won't repeat these
    }

    /**
     * A call that arrived by push while the app was closed or out of sight: the page asks for it once it's
     * signed in, then answers it ("accept", when Answer was pressed) or shows it ringing ("show").
     */
    @JavascriptInterface
    public String takePendingCall() {
        if (!activity.isTrustedPage()) return "";
        JSONObject invite = Store.pendingCall(activity);
        if (invite == null) return "";
        String action = Store.pendingAction(activity);
        Store.clearPendingCall(activity);
        try {
            return new JSONObject().put("invite", invite).put("action", action).toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** "Update" in the app: download, check and install the newer version. */
    @JavascriptInterface
    public void startUpdate() {
        if (activity.isTrustedPage()) activity.runOnUiThread(() -> Updater.start(activity));
    }

    /** "Check for updates" in Settings: look now; the page hears back through its 'foryouapp' event. */
    @JavascriptInterface
    public void checkUpdate() {
        if (activity.isTrustedPage()) Updater.checkInBackground(activity, true);
    }

    @JavascriptInterface
    public void requestNotifications() {
        if (activity.isTrustedPage()) activity.runOnUiThread(activity::askNotifications);
    }

    /** Someone is calling: ring with a full-screen call screen when ForYou isn't in front. */
    @JavascriptInterface
    public void incomingCall(String json) {
        if (!activity.isTrustedPage() || json == null || json.length() > 2000) return;
        try {
            JSONObject o = new JSONObject(json);
            String key = o.optString("roomKey");
            if (!key.matches("[0-9a-f]{32}")) return;
            if (!MainActivity.isVisible()) Notifier.incomingCall(activity, key, clip(o.optString("name", "Someone"), 60));
        } catch (Exception ignored) {
            // malformed: the call still shows inside the app
        }
    }

    @JavascriptInterface
    public void endIncomingCall(String roomKey) {
        if (activity.isTrustedPage()) Notifier.cancelCall(activity);
    }

    /** Calculator lock switched on or off: keep ForYou out of the recent-apps preview while it's on. */
    @JavascriptInterface
    public void setPrivacyScreen(boolean on) {
        if (!activity.isTrustedPage()) return;
        Store.putInt(activity, "privacyScreen", on ? 1 : 0);
        activity.runOnUiThread(activity::applyPrivacyScreen);
    }

    @JavascriptInterface
    public void setInCall(boolean on) {
        if (activity.isTrustedPage()) activity.setInCall(on);
    }

    /** After sign-in: the device code the background check uses (see supabase/migrations/08). */
    @JavascriptInterface
    public void registerDevice(String json) {
        if (!activity.isTrustedPage() || json == null || json.length() > 4000) return;
        try {
            JSONObject o = new JSONObject(json);
            String url = o.optString("url"), key = o.optString("key"), token = o.optString("token"), user = o.optString("user");
            if (!Api.isAllowedBase(url) || key.isEmpty() || !token.matches("[0-9a-f]{64}") || !user.matches("[0-9a-f\\-]{36}")) return;
            Store.saveDevice(activity, url, key, token, user);
            InboxJob.schedule(activity);
            Push.upload(activity); // send the push token we already have, under the new device code
            Push.refresh(activity);
        } catch (Exception ignored) {
            // malformed: no background checks until the next sign-in
        }
    }

    /** Sign-out: forget the device code here and in the database, and stop checking. */
    @JavascriptInterface
    public void signOut() {
        if (!activity.isTrustedPage()) return;
        final android.content.Context c = activity.getApplicationContext();
        new Thread(() -> {
            try {
                Api.unregister(c);
            } catch (Exception ignored) {
                // offline: the code is deleted here anyway and simply stops being used
            }
            Store.clearDevice(c);
            InboxJob.cancel(c);
            Notifier.cancelMessages(c);
        }).start();
    }

    private static String clip(String s, int max) {
        if (s == null) return "";
        s = s.trim();
        return s.length() > max ? s.substring(0, max - 1) + "…" : s;
    }
}
