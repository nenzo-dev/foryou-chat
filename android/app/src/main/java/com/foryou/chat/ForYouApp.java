package com.foryou.chat;

import android.app.Application;

/** Starts Firebase before anything else, including when a push wakes the app while it's closed. */
public class ForYouApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Notifier.channels(this);
        Push.init(this);
    }
}
