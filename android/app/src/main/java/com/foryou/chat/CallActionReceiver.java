package com.foryou.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** "Decline" on the ringing notification: stops the ringing and tells the caller, without opening the app. */
public class CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        Notifier.cancelCall(c);
        String key = intent.getStringExtra(MainActivity.EXTRA_ROOM_KEY);
        MainActivity m = MainActivity.current();
        if (m != null && key != null && key.matches("[0-9a-f]{32}")) m.callAction("decline", key);
    }
}
