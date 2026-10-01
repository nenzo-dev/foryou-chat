package com.foryou.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import java.util.HashMap;
import java.util.Map;

/** Debug build only: turns an adb broadcast into a push, handled exactly like one from Firebase. */
public class DebugPushReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        Map<String, String> data = new HashMap<>();
        Bundle extras = intent.getExtras();
        if (extras != null) for (String k : extras.keySet()) {
            Object v = extras.get(k);
            if (v != null) data.put(k, String.valueOf(v));
        }
        PushHandler.handle(c, data);
    }
}
