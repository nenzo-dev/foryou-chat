package com.foryou.chat;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The two database functions the app calls by itself, with the public anon key and the phone's
 * device code (supabase/migrations/08): device_inbox while the app is closed, and unregister_device
 * on sign-out. The person's own sign-in stays inside the web app and is never used from here.
 */
final class Api {
    private Api() {}

    /** Only a Supabase project, over HTTPS. */
    static boolean isAllowedBase(String url) {
        return url != null && url.matches("https://[a-z0-9-]+\\.supabase\\.co");
    }

    private static String call(Context c, String fn, JSONObject body) throws Exception {
        String base = Store.apiUrl(c), key = Store.apiKey(c);
        if (!isAllowedBase(base) || key.isEmpty()) throw new IOException("no device code");
        HttpURLConnection con = (HttpURLConnection) new URL(base + "/rest/v1/rpc/" + fn).openConnection();
        try {
            con.setConnectTimeout(15000);
            con.setReadTimeout(15000);
            con.setRequestMethod("POST");
            con.setDoOutput(true);
            con.setRequestProperty("apikey", key);
            con.setRequestProperty("Authorization", "Bearer " + key);
            con.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = con.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = con.getResponseCode();
            InputStream in = code >= 400 ? con.getErrorStream() : con.getInputStream();
            String text = read(in);
            if (code >= 400) throw new IOException("HTTP " + code);
            return text;
        } finally {
            con.disconnect();
        }
    }

    static JSONObject inbox(Context c) throws Exception {
        String text = call(c, "device_inbox", new JSONObject().put("p_token", Store.token(c)).put("p_since", Store.since(c))).trim();
        return text.isEmpty() || "null".equals(text) ? new JSONObject() : new JSONObject(text);
    }

    /** Returns false when the database no longer knows this phone's device code. */
    static boolean setPushToken(Context c, String fcm) throws Exception {
        String text = call(c, "set_push_token", new JSONObject().put("p_token", Store.token(c)).put("p_fcm", fcm)).trim();
        return "true".equals(text);
    }

    /**
     * "Decline" pressed while the app is closed: tells the caller straight away, through the same live
     * channel the web app uses (Supabase Realtime's broadcast endpoint), so they stop ringing.
     */
    static void broadcastDecline(Context c, String callerId, String myId, String roomKey) throws Exception {
        String base = Store.apiUrl(c), key = Store.apiKey(c);
        if (!isAllowedBase(base) || key.isEmpty()) throw new IOException("no device code");
        JSONObject payload = new JSONObject().put("type", "decline").put("from", myId).put("roomKey", roomKey);
        JSONObject body = new JSONObject().put("messages", new org.json.JSONArray().put(
                new JSONObject().put("topic", "ring-" + callerId).put("event", "ring").put("payload", payload)));
        HttpURLConnection con = (HttpURLConnection) new URL(base + "/realtime/v1/api/broadcast").openConnection();
        try {
            con.setConnectTimeout(15000);
            con.setReadTimeout(15000);
            con.setRequestMethod("POST");
            con.setDoOutput(true);
            con.setRequestProperty("apikey", key);
            con.setRequestProperty("Authorization", "Bearer " + key);
            con.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = con.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = con.getResponseCode();
            if (code >= 400) throw new IOException("HTTP " + code);
        } finally {
            con.disconnect();
        }
    }

    static void unregister(Context c) throws Exception {
        if (Store.hasDevice(c)) call(c, "unregister_device", new JSONObject().put("p_token", Store.token(c)));
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream s = in; ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[8192];
            int n;
            while ((n = s.read(chunk)) != -1) buf.write(chunk, 0, n);
            return buf.toString("UTF-8");
        }
    }
}
