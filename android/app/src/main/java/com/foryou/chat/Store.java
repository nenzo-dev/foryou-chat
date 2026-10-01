package com.foryou.chat;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** The little the app keeps on the phone, in its private storage (deleted on uninstall). */
final class Store {
    private Store() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("foryou", Context.MODE_PRIVATE);
    }

    static int getInt(Context c, String k, int def) {
        return prefs(c).getInt(k, def);
    }

    static void putInt(Context c, String k, int v) {
        prefs(c).edit().putInt(k, v).apply();
    }

    // ---------------------------------------------------------------- device code for background checks
    static void saveDevice(Context c, String url, String key, String token, String user) {
        prefs(c).edit()
                .putString("apiUrl", url).putString("apiKey", key)
                .putString("deviceToken", token).putString("deviceUser", user)
                .putString("since", isoNow(0))
                .putBoolean("pushUploaded", false)
                .apply();
    }

    static boolean hasDevice(Context c) {
        return prefs(c).getString("deviceToken", null) != null;
    }

    static String deviceUser(Context c) {
        return prefs(c).getString("deviceUser", "");
    }

    static String apiUrl(Context c) {
        return prefs(c).getString("apiUrl", "");
    }

    static String apiKey(Context c) {
        return prefs(c).getString("apiKey", "");
    }

    static String token(Context c) {
        return prefs(c).getString("deviceToken", "");
    }

    static void clearDevice(Context c) {
        prefs(c).edit().remove("apiUrl").remove("apiKey").remove("deviceToken").remove("deviceUser").remove("since")
                .putBoolean("pushUploaded", false).apply();
    }

    // ---------------------------------------------------------------- Firebase push token
    static void setPushToken(Context c, String token) {
        if (token.equals(pushToken(c))) return;
        prefs(c).edit().putString("pushToken", token).putBoolean("pushUploaded", false).apply();
    }

    static String pushToken(Context c) {
        return prefs(c).getString("pushToken", "");
    }

    static boolean pushUploaded(Context c) {
        return prefs(c).getBoolean("pushUploaded", false);
    }

    static void setPushUploaded(Context c, boolean v) {
        prefs(c).edit().putBoolean("pushUploaded", v).apply();
    }

    // ---------------------------------------------------------------- a call that arrived by push
    /** The invite from the latest call push, kept briefly so the app can answer it once it opens. */
    static void savePendingCall(Context c, JSONObject invite) {
        prefs(c).edit().putString("pendingCall", invite.toString()).putLong("pendingCallAt", System.currentTimeMillis())
                .remove("pendingAction").apply();
    }

    /** The waiting call, if it's still recent enough to answer (about a minute). */
    static JSONObject pendingCall(Context c) {
        long at = prefs(c).getLong("pendingCallAt", 0);
        String json = prefs(c).getString("pendingCall", null);
        if (json == null || System.currentTimeMillis() - at > 60_000) return null;
        try {
            return new JSONObject(json);
        } catch (Exception e) {
            return null;
        }
    }

    static void clearPendingCall(Context c) {
        prefs(c).edit().remove("pendingCall").remove("pendingCallAt").remove("pendingAction").apply();
    }

    /** "accept" when Answer was pressed on the ringing notification before the app opened. */
    static void setPendingAction(Context c, String roomKey, String action) {
        JSONObject p = pendingCall(c);
        if (p != null && p.optString("roomKey").equals(roomKey)) prefs(c).edit().putString("pendingAction", action).apply();
    }

    static String pendingAction(Context c) {
        return prefs(c).getString("pendingAction", "show");
    }

    // ---------------------------------------------------------------- debug builds under test
    /** The test page a debug build keeps opening while android/ci/emulator-test.sh runs. */
    static String testUrl(Context c) {
        return prefs(c).getString("testUrl", null);
    }

    static void setTestUrl(Context c, String url) {
        prefs(c).edit().putString("testUrl", url).apply();
    }

    // ---------------------------------------------------------------- app updates
    /** Where updates come from: the website, or (debug builds under test only) a local server. */
    static String updateBase(Context c) {
        return prefs(c).getString("updateBase", "");
    }

    static void setUpdateBase(Context c, String url) {
        prefs(c).edit().putString("updateBase", url).putLong("updateCheckedAt", 0).apply();
    }

    static long updateCheckedAt(Context c) {
        return prefs(c).getLong("updateCheckedAt", 0);
    }

    static void setUpdateCheckedAt(Context c, long at) {
        prefs(c).edit().putLong("updateCheckedAt", at).apply();
    }

    /** The newer version that's available (from app/android.json), or null. */
    static JSONObject update(Context c) {
        String s = prefs(c).getString("update", null);
        if (s == null) return null;
        try {
            JSONObject j = new JSONObject(s);
            return j.optInt("versionCode") > BuildConfig.VERSION_CODE ? j : null;
        } catch (Exception e) {
            return null;
        }
    }

    static void setUpdate(Context c, JSONObject j) {
        if (j == null) prefs(c).edit().remove("update").apply();
        else prefs(c).edit().putString("update", j.toString()).apply();
    }

    /** The server time of the last check: only messages after it are new. */
    static String since(Context c) {
        return prefs(c).getString("since", isoNow(0));
    }

    static void setSince(Context c, String iso) {
        prefs(c).edit().putString("since", iso).apply();
    }

    /** The open app just showed a notification itself, so everything before now has been seen. */
    static void markNotified(Context c) {
        if (hasDevice(c)) setSince(c, isoNow(-60_000));
    }

    static String isoNow(long offsetMs) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(System.currentTimeMillis() + offsetMs));
    }
}
