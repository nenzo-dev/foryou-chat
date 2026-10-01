package com.foryou.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

/**
 * "Decline" on the ringing notification: stops the ringing and tells the caller, without opening the
 * app. If the app is running, its page sends the decline; if the call arrived by push while the app was
 * closed, the app sends it itself.
 */
public class CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        Notifier.cancelCall(c);
        String key = intent.getStringExtra(MainActivity.EXTRA_ROOM_KEY);
        if (key == null || !key.matches("[0-9a-f]{32}")) return;
        MainActivity m = MainActivity.current();
        if (m != null) m.callAction("decline", key);

        JSONObject pending = Store.pendingCall(c);
        if (pending == null || !key.equals(pending.optString("roomKey"))) return;
        Store.clearPendingCall(c);
        final String caller = pending.optString("from"), me = Store.deviceUser(c);
        if (caller.isEmpty() || me.isEmpty()) return;
        final Context app = c.getApplicationContext();
        final PendingResult done = goAsync();
        new Thread(() -> {
            try {
                Api.broadcastDecline(app, caller, me, key);
            } catch (Exception e) {
                Log.w("ForYou", "Couldn't send the decline: " + e.getMessage());
            } finally {
                done.finish();
            }
        }).start();
    }
}
