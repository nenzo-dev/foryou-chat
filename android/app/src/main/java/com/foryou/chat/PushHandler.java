package com.foryou.chat;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.util.Map;

/**
 * What a push means (see supabase/functions/push): an incoming call rings with the full-screen call
 * screen, a cancelled call stops ringing, a new message shows a notification. Nothing is shown while
 * ForYou is on screen; the open app shows those things itself.
 */
final class PushHandler {
    private static final String TAG = "ForYou";

    private PushHandler() {}

    static void handle(Context c, Map<String, String> d) {
        if (d == null) return;
        String type = d.get("type");
        Log.i(TAG, "Push received: " + type);
        if ("call".equals(type)) call(c, d);
        else if ("cancel".equals(type)) cancel(c, d);
        else if ("message".equals(type)) message(c, d);
    }

    private static void call(Context c, Map<String, String> d) {
        // "caller", not "from": Firebase reserves "from" and refuses any push that uses it. A call that
        // comes too late never arrives at all (the push lives 45 seconds), so the phone's clock isn't asked.
        String key = d.get("roomKey"), from = d.get("caller");
        if (key == null || !key.matches("[0-9a-f]{32}") || from == null || !from.matches("[0-9a-f\\-]{36}")) return;
        try {
            JSONObject invite = new JSONObject()
                    .put("type", "invite").put("roomKey", key).put("from", from)
                    .put("fromName", value(d, "fromName", "Someone"))
                    .put("fromAvatarColor", value(d, "fromAvatarColor", ""))
                    .put("fromAvatarPath", value(d, "fromAvatarPath", ""));
            Store.savePendingCall(c, invite);
        } catch (Exception ignored) {
            return;
        }
        if (!MainActivity.isVisible()) {
            Notifier.incomingCall(c, key, clip(value(d, "fromName", "Someone"), 60));
        } else {
            MainActivity m = MainActivity.current(); // on screen: let the page show it, if it hasn't already
            if (m != null) m.runJs("window.__foryouCheckCall&&window.__foryouCheckCall()");
        }
    }

    private static void cancel(Context c, Map<String, String> d) {
        JSONObject pending = Store.pendingCall(c);
        if (pending != null && pending.optString("roomKey").equals(d.get("roomKey"))) {
            Store.clearPendingCall(c);
            Notifier.cancelCall(c);
            if (!MainActivity.isVisible()) {
                Notifier.message(c, "foryou-missed-call", "Missed video call", clip(value(d, "fromName", "Someone"), 60) + " tried to call you", "");
            }
        }
    }

    private static void message(Context c, Map<String, String> d) {
        if (MainActivity.isVisible()) return;
        String tag = d.get("tag"), hash = d.get("hash");
        if (tag == null || !tag.matches("foryou-[a-z0-9_\\-]{1,120}")) return;
        Notifier.message(c, tag, clip(value(d, "title", "ForYou"), 80), clip(value(d, "body", ""), 400), MainActivity.safeHash(hash) ? hash : "");
        Store.markNotified(c);
    }

    private static String value(Map<String, String> d, String k, String def) {
        String v = d.get(k);
        return v == null || v.trim().isEmpty() ? def : v.trim();
    }

    private static String clip(String s, int max) {
        return s.length() > max ? s.substring(0, max - 1) + "…" : s;
    }
}
