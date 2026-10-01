package com.foryou.chat;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** The app's screen: ForYou itself, plus what a phone app adds (calls, notifications, files). */
public class MainActivity extends Activity {
    static final String SITE_URL = "https://foryou-chat.pages.dev/";
    static final String SITE_HOST = "foryou-chat.pages.dev";
    static final String EXTRA_HASH = "hash";
    static final String EXTRA_CALL_ACTION = "callAction";
    static final String EXTRA_ROOM_KEY = "roomKey";
    static final String EXTRA_RINGING = "ringing";
    static final String EXTRA_UPDATE = "update";
    private static final String TAG = "ForYou";
    private static final String OFFLINE_URL = "file:///android_asset/offline.html";
    private static final String TEST_PREFIX = "file:///android_asset/test/";
    private static final int REQ_FILE = 10;
    private static final int REQ_NOTIFICATIONS = 11;
    private static final int REQ_MEDIA = 12;

    private static volatile boolean visible;
    private static volatile MainActivity current;
    private volatile boolean trusted;
    private boolean debuggable;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingMedia;
    private boolean startUpdateOnResume;
    private boolean pageLoaded;
    private String pendingHash;

    static boolean isVisible() {
        return visible;
    }

    static MainActivity current() {
        return current;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        current = this;
        Notifier.channels(this);
        debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        web.setBackgroundColor(0xFF07070A);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // the other person's voice starts without a tap
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " ForYouAndroid/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(this), "ForYouAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> openExternal(url));

        // Act on what opened the app (a notification, a call, an update) only on a fresh start. When
        // Android rebuilds this screen later, getIntent() is still that first intent, already handled;
        // anything new arrives through onNewIntent.
        boolean fresh = state == null && (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0;
        Intent opened = fresh ? getIntent() : new Intent();
        String start = SITE_URL + hashFrom(opened);
        String test = getIntent().getStringExtra("testUrl");
        if (debuggable && test != null && test.startsWith(TEST_PREFIX)) start = test;
        // Decide trust before loading: a fast page can call the bridge before onPageStarted arrives.
        trusted = trustedUrl(start);
        web.loadUrl(start);

        showOverLockScreen(opened.getBooleanExtra(EXTRA_RINGING, false));
        rememberCallAction(getIntent()); // safe to repeat: it only applies to the call still waiting
        askForNotificationsOnce();
        if (Store.hasDevice(this)) InboxJob.schedule(this);
        Push.refresh(this);
        startUpdateOnResume = opened.getBooleanExtra(EXTRA_UPDATE, false);
        if (!testUpdate(opened)) Updater.checkInBackground(this, false);
    }

    /** Debug builds under test can fetch updates from a local server (see ci/emulator-test.sh). */
    private boolean testUpdate(Intent i) {
        String base = i.getStringExtra("updateBase");
        if (!debuggable || base == null || !base.startsWith("http")) return false;
        Store.setUpdateBase(this, base);
        final boolean auto = i.getBooleanExtra("autoUpdate", false);
        final Context app = getApplicationContext();
        new Thread(() -> {
            Updater.check(app, false, true);
            tellPage();
            if (auto) runOnUiThread(() -> Updater.start(this));
        }).start();
        return true;
    }

    /** Tells the page how an update is going: downloading (with %), checking, installing, confirm, error. */
    void updateProgress(String state, int pct) {
        runJs("window.__foryouUpdate&&window.__foryouUpdate(" + JSONObject.quote(state) + "," + pct + ")");
    }

    /**
     * Answer pressed on a call that arrived by push while the app was closed: the page isn't running yet,
     * so the choice waits in Store until it asks for it (Bridge.takePendingCall).
     */
    private void rememberCallAction(Intent i) {
        String action = i.getStringExtra(EXTRA_CALL_ACTION), key = i.getStringExtra(EXTRA_ROOM_KEY);
        JSONObject waiting = Store.pendingCall(this);
        if ("accept".equals(action) && key != null && waiting != null && key.equals(waiting.optString("roomKey"))) {
            Notifier.cancelCall(this);
            Store.setPendingAction(this, key, "accept");
        }
    }

    /** Only links to ForYou's own screens are followed from a notification. */
    static boolean safeHash(String h) {
        return h != null && h.matches("#/[a-z]+(/[A-Za-z0-9_.%\\-]+)?");
    }

    private static String hashFrom(Intent i) {
        String h = i == null ? null : i.getStringExtra(EXTRA_HASH);
        return safeHash(h) ? h : "";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        showOverLockScreen(intent.getBooleanExtra(EXTRA_RINGING, false));
        String h = hashFrom(intent);
        if (!h.isEmpty()) {
            if (pageLoaded) runJs("location.hash=" + JSONObject.quote(h));
            else pendingHash = h; // still loading (the screen was just rebuilt): go there once it's up
        }
        if (intent.getBooleanExtra(EXTRA_UPDATE, false)) Updater.start(this);
        testUpdate(intent);
        String action = intent.getStringExtra(EXTRA_CALL_ACTION);
        String key = intent.getStringExtra(EXTRA_ROOM_KEY);
        if (action != null && key != null && key.matches("[0-9a-f]{32}")) {
            Notifier.cancelCall(this);
            rememberCallAction(intent);
            callAction(action, key);
        }
    }

    /** Answer or Decline pressed on the ringing notification: the page does the rest. */
    void callAction(String action, String roomKey) {
        runJs("window.__foryouCall&&window.__foryouCall(" + JSONObject.quote(action) + "," + JSONObject.quote(roomKey) + ")");
    }

    void runJs(String js) {
        runOnUiThread(() -> {
            if (web != null && trusted) web.evaluateJavascript(js, null);
        });
    }

    /** An incoming call may show over the lock screen; nothing else ever does. */
    @SuppressWarnings("deprecation")
    void showOverLockScreen(boolean on) {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(on);
            setTurnScreenOn(on);
        } else if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    /** Keeps the screen on while a call or blind date is open. */
    void setInCall(boolean on) {
        runOnUiThread(() -> {
            if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                showOverLockScreen(false);
            }
        });
    }

    // ---------------------------------------------------------------- which pages may use the bridge
    boolean isTrustedPage() {
        return trusted;
    }

    private boolean isSite(Uri u) {
        return u != null && "https".equals(u.getScheme()) && SITE_HOST.equals(u.getHost());
    }

    private boolean trustedUrl(String url) {
        if (url == null) return false;
        if (debuggable && url.startsWith(TEST_PREFIX)) return true;
        return isSite(Uri.parse(url));
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String path = u.getPath() == null ? "" : u.getPath();
            boolean stay = (isSite(u) && !path.endsWith(".apk")) || (debuggable && u.toString().startsWith(TEST_PREFIX));
            if (stay) {
                if (request.isForMainFrame()) trusted = trustedUrl(u.toString());
                return false;
            }
            openExternal(u.toString()); // shared files, other websites, app updates
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            trusted = trustedUrl(url);
            pageLoaded = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageLoaded = true;
            if (!trusted) return;
            Log.i(TAG, "Loaded " + url);
            if (pendingHash != null) runJs("location.hash=" + JSONObject.quote(pendingHash));
            pendingHash = null;
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            trusted = trustedUrl(url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline();
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 500) showOffline();
        }
    }

    private void showOffline() {
        Log.w(TAG, "Couldn't load ForYou; showing the offline page");
        trusted = false;
        web.loadUrl(OFFLINE_URL);
    }

    private class Chrome extends WebChromeClient {
        /** Camera and microphone for calls: Android asks the person first, then the page gets them. */
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            if (!trusted || !isSite(request.getOrigin())) {
                request.deny();
                return;
            }
            List<String> missing = new ArrayList<>();
            for (String r : request.getResources()) {
                String p = permissionFor(r);
                if (p != null && checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED && !missing.contains(p)) missing.add(p);
            }
            if (missing.isEmpty()) {
                grantAllowed(request);
                return;
            }
            if (pendingMedia != null) pendingMedia.deny();
            pendingMedia = request;
            requestPermissions(missing.toArray(new String[0]), REQ_MEDIA);
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingMedia == request) pendingMedia = null;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("OK", (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("Yes", (d, w) -> result.confirm())
                    .setNegativeButton("No", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            if (debuggable) Log.d(TAG, "page: " + m.message());
            return true;
        }
    }

    private static String permissionFor(String resource) {
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return Manifest.permission.CAMERA;
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return Manifest.permission.RECORD_AUDIO;
        return null;
    }

    /** Grants the page whatever it asked for that the person has allowed; denies if that's nothing. */
    private void grantAllowed(PermissionRequest request) {
        List<String> ok = new ArrayList<>();
        for (String r : request.getResources()) {
            String p = permissionFor(r);
            if (p != null && checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) ok.add(r);
        }
        if (ok.isEmpty()) request.deny();
        else request.grant(ok.toArray(new String[0]));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app on this phone can open that link.", Toast.LENGTH_SHORT).show();
        }
    }

    // ---------------------------------------------------------------- notifications permission
    boolean notificationsAllowed() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        return nm.areNotificationsEnabled()
                && (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
    }

    JSONObject info() {
        JSONObject o = new JSONObject();
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            o.put("version", BuildConfig.VERSION_NAME);
            o.put("code", BuildConfig.VERSION_CODE);
            o.put("notifications", notificationsAllowed());
            o.put("fullScreen", Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent());
            o.put("deviceUser", Store.deviceUser(this));
            o.put("push", Push.enabled() && Store.pushUploaded(this));
            JSONObject u = Store.update(this);
            if (u != null) o.put("update", new JSONObject().put("versionName", u.optString("versionName")).put("versionCode", u.optInt("versionCode")).put("size", u.optLong("size")));
        } catch (Exception ignored) {
            // leave whatever was filled in
        }
        return o;
    }

    private void askForNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        if (Store.getInt(this, "askedNotifications", 0) > 0) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
    }

    /** "Enable notifications" in Settings: ask again, or send the person to the phone's settings. */
    void askNotifications() {
        if (notificationsAllowed()) {
            tellPage();
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && (Store.getInt(this, "askedNotifications", 0) < 2 || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Turn on notifications")
                .setMessage("Notifications are off for ForYou, so it can't tell you about new messages and calls. Turn them on in the next screen.")
                .setPositiveButton("Continue", (d, w) -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
                    } catch (ActivityNotFoundException e) {
                        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                    }
                })
                .setNegativeButton("Not now", null)
                .show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_MEDIA) {
            PermissionRequest r = pendingMedia;
            pendingMedia = null;
            if (r != null) grantAllowed(r);
            return;
        }
        if (requestCode == REQ_NOTIFICATIONS) {
            Store.putInt(this, "askedNotifications", Store.getInt(this, "askedNotifications", 0) + 1);
            tellPage();
        }
    }

    void tellPage() {
        runJs("window.dispatchEvent(new Event('foryouapp'))");
    }

    // ---------------------------------------------------------------- lifecycle
    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        Notifier.cancelMessages(this); // you're looking at ForYou now
        tellPage();
        runJs("window.__foryouCheckCall&&window.__foryouCheckCall()"); // a call that arrived by push
        // Back from "Allow from this source", or opened from the update notification.
        boolean allowed = Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls();
        if (Store.getInt(this, "updateAfterPermission", 0) == 1 && allowed) {
            Store.putInt(this, "updateAfterPermission", 0);
            Updater.start(this);
        } else if (startUpdateOnResume) {
            startUpdateOnResume = false;
            Updater.start(this);
        }
    }

    @Override
    protected void onPause() {
        // The page keeps running in the background, so messages and calls still arrive while the
        // app is out of sight. When the system closes it, InboxJob checks for messages instead.
        visible = false;
        super.onPause();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // leave ForYou running instead of closing it
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
