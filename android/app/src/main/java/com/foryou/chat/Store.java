package com.foryou.chat;

import android.content.Context;
import android.content.SharedPreferences;

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
        prefs(c).edit().remove("apiUrl").remove("apiKey").remove("deviceToken").remove("deviceUser").remove("since").apply();
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
