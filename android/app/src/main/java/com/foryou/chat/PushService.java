package com.foryou.chat;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Where Firebase delivers pushes, even when the app is closed (it starts the app for this). */
public class PushService extends FirebaseMessagingService {
    @Override
    public void onNewToken(@NonNull String token) {
        Push.saveToken(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        PushHandler.handle(this, message.getData());
    }
}
