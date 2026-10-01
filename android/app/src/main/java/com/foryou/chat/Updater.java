package com.foryou.chat;

import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * App updates. The website publishes the latest version as app/android.json and app/foryou.apk (see
 * .github/workflows/android.yml). The app checks about once an hour, tells the person when a newer
 * version is out, and "Update" downloads it, checks it's exactly the published file (SHA-256), and
 * hands it to Android's own installer, which asks "Update this app?" and only accepts a file signed
 * with the same key as the installed app.
 */
final class Updater {
    private static final String TAG = "ForYou";
    private static final long CHECK_EVERY_MS = 60 * 60 * 1000L;
    private static volatile boolean busy;

    private Updater() {}

    static String base(Context c) {
        String b = Store.updateBase(c);
        return b.isEmpty() ? MainActivity.SITE_URL : b;
    }

    /** Fetches app/android.json. Network: call off the main thread. */
    static JSONObject latest(Context c) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(base(c) + "app/android.json?t=" + System.currentTimeMillis()).openConnection();
        try {
            con.setConnectTimeout(15000);
            con.setReadTimeout(15000);
            con.setUseCaches(false);
            if (con.getResponseCode() != 200) throw new IOException("HTTP " + con.getResponseCode());
            try (InputStream in = con.getInputStream(); ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[4096];
                int n;
                while ((n = in.read(chunk)) != -1 && buf.size() < 20000) buf.write(chunk, 0, n);
                return new JSONObject(buf.toString("UTF-8"));
            }
        } finally {
            con.disconnect();
        }
    }

    /**
     * Looks for a newer version (at most hourly unless forced). Remembers it for the page, and with
     * notify=true shows a notification once per version. Network: call off the main thread.
     */
    static void check(Context c, boolean notify, boolean force) {
        if (!force && System.currentTimeMillis() - Store.updateCheckedAt(c) < CHECK_EVERY_MS) {
            maybeNotify(c, notify);
            return;
        }
        try {
            JSONObject j = latest(c);
            Store.setUpdateCheckedAt(c, System.currentTimeMillis());
            int code = j.optInt("versionCode", 0);
            String sha = j.optString("sha256", "");
            if (code > BuildConfig.VERSION_CODE && sha.matches("[0-9a-f]{64}")) {
                Store.setUpdate(c, j);
                Log.i(TAG, "Update available: " + j.optString("versionName"));
            } else {
                Store.setUpdate(c, null);
            }
        } catch (Exception e) {
            Log.w(TAG, "Update check failed: " + e.getMessage());
        }
        maybeNotify(c, notify);
    }

    private static void maybeNotify(Context c, boolean notify) {
        JSONObject u = Store.update(c);
        if (!notify || u == null || MainActivity.isVisible()) return;
        int code = u.optInt("versionCode");
        if (Store.getInt(c, "updateNotified", 0) == code) return;
        Store.putInt(c, "updateNotified", code);
        Notifier.update(c, u.optString("versionName", "new"));
    }

    static void checkInBackground(MainActivity a, boolean force) {
        final Context c = a.getApplicationContext();
        new Thread(() -> {
            check(c, false, force);
            a.tellPage();
        }).start();
    }

    // ---------------------------------------------------------------- installing
    /** "Update" pressed: permission first if needed, then download, verify and install. */
    static void start(MainActivity a) {
        JSONObject u = Store.update(a);
        if (u == null) {
            a.updateProgress("none", 0);
            return;
        }
        if (busy) return;
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            Store.putInt(a, "updateAfterPermission", 1);
            new AlertDialog.Builder(a)
                    .setTitle("Allow ForYou to update itself")
                    .setMessage("To install the new version, Android needs your OK for ForYou to install updates. In the next screen, turn on \"Allow from this source\", then come back.")
                    .setPositiveButton("Continue", (d, w) -> {
                        try {
                            a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
                        } catch (ActivityNotFoundException e) {
                            a.startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS));
                        }
                    })
                    .setNegativeButton("Not now", (d, w) -> {
                        Store.putInt(a, "updateAfterPermission", 0);
                        a.updateProgress("idle", 0);
                    })
                    .show();
            return;
        }
        busy = true;
        final Context c = a.getApplicationContext();
        new Thread(() -> {
            File apk = new File(c.getCacheDir(), "update.apk");
            try {
                download(a, base(c) + "app/foryou.apk?v=" + u.optInt("versionCode"), apk);
                a.updateProgress("checking", 100);
                if (!u.optString("sha256").equalsIgnoreCase(sha256(apk))) throw new IOException("download didn't match the published file");
                a.updateProgress("installing", 100);
                install(c, apk);
            } catch (Exception e) {
                Log.w(TAG, "Update failed: " + e.getMessage());
                a.updateProgress("error", 0);
            } finally {
                busy = false;
            }
        }).start();
    }

    private static void download(MainActivity a, String url, File to) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        try {
            con.setConnectTimeout(20000);
            con.setReadTimeout(30000);
            con.setUseCaches(false);
            if (con.getResponseCode() != 200) throw new IOException("HTTP " + con.getResponseCode());
            long total = con.getContentLength();
            try (InputStream in = con.getInputStream(); OutputStream out = new FileOutputStream(to)) {
                byte[] chunk = new byte[16384];
                long done = 0;
                int n, last = -1;
                while ((n = in.read(chunk)) != -1) {
                    out.write(chunk, 0, n);
                    done += n;
                    int pct = total > 0 ? (int) (done * 100 / total) : 0;
                    if (pct != last) {
                        last = pct;
                        a.updateProgress("downloading", pct);
                    }
                }
            }
        } finally {
            con.disconnect();
        }
    }

    static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] chunk = new byte[16384];
            int n;
            while ((n = in.read(chunk)) != -1) md.update(chunk, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** Hands the file to Android's installer; UpdateReceiver hears back (and shows its "Update?" screen). */
    private static void install(Context c, File apk) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(c.getPackageName());
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (OutputStream out = s.openWrite("foryou.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                byte[] chunk = new byte[16384];
                int n;
                while ((n = in.read(chunk)) != -1) out.write(chunk, 0, n);
                s.fsync(out);
            }
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent status = PendingIntent.getBroadcast(c, id, new Intent(c, UpdateReceiver.class), flags);
            s.commit(status.getIntentSender());
            Log.i(TAG, "Update handed to the installer");
        }
    }
}
