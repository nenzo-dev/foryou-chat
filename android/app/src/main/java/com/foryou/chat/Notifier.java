package com.foryou.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;

import java.util.Arrays;

/** Every notification the app shows, and the channels (sound settings) they use. */
final class Notifier {
    static final String CH_MESSAGES = "messages";
    static final String CH_CALLS = "calls";
    static final String CH_AI = "ai_followups";
    static final String CH_UPDATES = "app_updates";
    static final String CALL_TAG = "call";
    private static final int GOLD = 0xFFF5C400;
    private static final long[] RING_VIBRATION = {0, 900, 700, 900, 700};

    private Notifier() {}

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);

        NotificationChannel messages = new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("New messages in your chats and groups");
        messages.enableVibration(true);

        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Rings when someone video calls you");
        calls.setSound(ringtone(), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        calls.enableVibration(true);
        calls.setVibrationPattern(RING_VIBRATION);
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        NotificationChannel ai = new NotificationChannel(CH_AI, "AI replies", NotificationManager.IMPORTANCE_DEFAULT);
        ai.setDescription("When AI answered for you while you were away, so you can follow up");

        NotificationChannel updates = new NotificationChannel(CH_UPDATES, "App updates", NotificationManager.IMPORTANCE_DEFAULT);
        updates.setDescription("When a new version of ForYou is ready to install");

        nm.createNotificationChannels(Arrays.asList(messages, calls, ai, updates));
    }

    static Uri ringtone() {
        Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return u;
    }

    @SuppressWarnings("deprecation")
    private static Notification.Builder builder(Context c, String channel) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, channel) : new Notification.Builder(c);
        return b.setSmallIcon(R.drawable.ic_stat_foryou).setColor(GOLD).setShowWhen(true);
    }

    private static PendingIntent open(Context c, String hash, int request) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (hash != null && !hash.isEmpty()) i.putExtra(MainActivity.EXTRA_HASH, hash);
        return PendingIntent.getActivity(c, request, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void post(Context c, String tag, Notification n) {
        try {
            c.getSystemService(NotificationManager.class).notify(tag, 1, n);
        } catch (SecurityException ignored) {
            // notifications aren't allowed; nothing to do
        }
    }

    /** One notification per chat: a newer message in the same chat replaces the older one. */
    @SuppressWarnings("deprecation")
    static void message(Context c, String tag, String title, String body, String hash) {
        Notification.Builder b = builder(c, CH_MESSAGES)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(open(c, hash, tag.hashCode()));
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        post(c, tag, b.build());
    }

    @SuppressWarnings("deprecation")
    static void aiFollowUp(Context c, int chats) {
        String body = chats == 1
                ? "It answered a message for you while you were away. Open ForYou to read what it said and follow up."
                : "It answered messages in " + chats + " chats while you were away. Open ForYou to read what it said and follow up.";
        Notification.Builder b = builder(c, CH_AI)
                .setContentTitle("AI replied for you")
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(open(c, "", 7));
        post(c, "foryou-ai-followup", b.build());
    }

    /** A newer version is out: tapping it, or its Update button, opens the app and starts the update. */
    @SuppressWarnings("deprecation")
    static void update(Context c, String version) {
        Intent i = new Intent(c, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_UPDATE, true);
        PendingIntent pi = PendingIntent.getActivity(c, 30, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String body = "A new version of ForYou is ready. Tap Update to install it.";
        Notification.Builder b = builder(c, CH_UPDATES)
                .setContentTitle("ForYou " + version + " is ready")
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_stat_foryou), "Update", pi).build());
        post(c, "foryou-update", b.build());
    }

    /** The download finished while the person was elsewhere: one tap shows Android's "Update?" screen. */
    static void updateReady(Context c, Intent confirm) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(c, 31, confirm, flags);
        Notification.Builder b = builder(c, CH_UPDATES)
                .setContentTitle("Finish updating ForYou")
                .setContentText("The new version is downloaded. Tap to install it.")
                .setAutoCancel(true)
                .setContentIntent(pi);
        post(c, "foryou-update", b.build());
    }

    /** The ringing screen: rings until answered, declined, cancelled, or after about a minute. */
    @SuppressWarnings("deprecation")
    static void incomingCall(Context c, String roomKey, String name) {
        Intent show = new Intent(c, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_RINGING, true);
        PendingIntent full = PendingIntent.getActivity(c, 20, show, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent answer = new Intent(c, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_RINGING, true)
                .putExtra(MainActivity.EXTRA_CALL_ACTION, "accept")
                .putExtra(MainActivity.EXTRA_ROOM_KEY, roomKey);
        PendingIntent answerPi = PendingIntent.getActivity(c, 21, answer, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent decline = new Intent(c, CallActionReceiver.class).putExtra(MainActivity.EXTRA_ROOM_KEY, roomKey);
        PendingIntent declinePi = PendingIntent.getBroadcast(c, 22, decline, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Icon icon = Icon.createWithResource(c, R.drawable.ic_stat_foryou);
        Notification.Builder b = builder(c, CH_CALLS)
                .setContentTitle(name)
                .setContentText("Incoming video call")
                .setCategory(Notification.CATEGORY_CALL)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setContentIntent(full)
                .setFullScreenIntent(full, true)
                .addAction(new Notification.Action.Builder(icon, "Decline", declinePi).build())
                .addAction(new Notification.Action.Builder(icon, "Answer", answerPi).build());
        if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(55_000);
        else b.setPriority(Notification.PRIORITY_MAX).setSound(ringtone(), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build()).setVibrate(RING_VIBRATION);
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT; // keep ringing, like a phone call
        post(c, CALL_TAG, n);
    }

    static void cancelCall(Context c) {
        c.getSystemService(NotificationManager.class).cancel(CALL_TAG, 1);
    }

    /** Clears message and AI notifications (not a ringing call). */
    static void cancelMessages(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        try {
            for (StatusBarNotification s : nm.getActiveNotifications()) {
                if (s.getTag() != null && s.getTag().startsWith("foryou-")) nm.cancel(s.getTag(), s.getId());
            }
        } catch (Exception ignored) {
            // nothing showing
        }
    }
}
