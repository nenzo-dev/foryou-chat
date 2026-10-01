package com.foryou.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

/** What Android's installer says about an update: show its "Update this app?" screen, or report failure. */
public class UpdateReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context c, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        MainActivity m = MainActivity.current();
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) return;
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (MainActivity.isVisible()) {
                c.startActivity(confirm);
                if (m != null) m.updateProgress("confirm", 100);
            } else {
                Notifier.updateReady(c, confirm); // the person left the app while it downloaded
            }
        } else if (status == PackageInstaller.STATUS_SUCCESS) {
            Log.i("ForYou", "Update installed");
        } else {
            Log.w("ForYou", "Update not installed: " + status + " " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            if (m != null) m.updateProgress(status == PackageInstaller.STATUS_FAILURE_ABORTED ? "idle" : "error", 0);
        }
    }
}
