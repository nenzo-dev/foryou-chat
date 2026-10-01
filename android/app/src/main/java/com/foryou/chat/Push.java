package com.foryou.chat;

import android.content.Context;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Firebase Cloud Messaging: the phone's push token, and telling the database about it (through the
 * device code from migration 08, see supabase/migrations/09). Off when the build has no Firebase
 * settings (android/app/google-services.json).
 */
final class Push {
    private static final String TAG = "ForYou";

    private Push() {}

    static boolean enabled() {
        return BuildConfig.PUSH_ENABLED;
    }

    static void init(Context c) {
        if (!enabled()) return;
        try {
            if (FirebaseApp.getApps(c).isEmpty()) {
                FirebaseApp.initializeApp(c, new FirebaseOptions.Builder()
                        .setApplicationId(BuildConfig.FCM_APP_ID)
                        .setApiKey(BuildConfig.FCM_API_KEY)
                        .setProjectId(BuildConfig.FCM_PROJECT_ID)
                        .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                        .build());
            }
        } catch (Exception e) {
            Log.w(TAG, "Push couldn't start: " + e.getMessage());
        }
    }

    /** Asks Firebase for this phone's push token, then registers it if someone is signed in. */
    static void refresh(Context c) {
        if (!enabled()) return;
        final Context app = c.getApplicationContext();
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    Log.i(TAG, "Push token ready");
                    saveToken(app, task.getResult());
                } else {
                    Log.w(TAG, "No push token: " + (task.getException() == null ? "unknown" : task.getException().getMessage()));
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "No push token: " + e.getMessage());
        }
    }

    /** A new or changed token: keep it, and send it to the database in the background. */
    static void saveToken(Context c, String token) {
        Store.setPushToken(c, token);
        upload(c);
    }

    static void upload(Context c) {
        final Context app = c.getApplicationContext();
        if (!Store.hasDevice(app) || Store.pushToken(app).isEmpty() || Store.pushUploaded(app)) return;
        new Thread(() -> {
            try {
                boolean known = Api.setPushToken(app, Store.pushToken(app));
                if (known) {
                    Store.setPushUploaded(app, true);
                    Log.i(TAG, "Push token registered");
                } else {
                    Store.clearDevice(app); // the device code was signed out elsewhere
                }
            } catch (Exception e) {
                Log.w(TAG, "Push token not registered yet: " + e.getMessage());
            }
        }).start();
    }
}
