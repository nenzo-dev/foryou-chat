package com.foryou.chat;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Checks for new messages while the app is closed: about every 15 minutes (Android's shortest
 * repeating interval for background work), only with a network, and again after a restart. Each new
 * chat gets one notification; AI replies sent for you get a reminder to follow up.
 */
public class InboxJob extends JobService {
    static final int JOB_ID = 4242;
    private static final String TAG = "ForYou";

    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        for (JobInfo j : js.getAllPendingJobs()) if (j.getId() == JOB_ID) return; // already set
        JobInfo info = new JobInfo.Builder(JOB_ID, new ComponentName(c, InboxJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build();
        js.schedule(info);
        Log.i(TAG, "Inbox check scheduled");
    }

    static void cancel(Context c) {
        c.getSystemService(JobScheduler.class).cancel(JOB_ID);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            boolean retry = false;
            try {
                check(getApplicationContext());
            } catch (Exception e) {
                Log.w(TAG, "Inbox check failed: " + e.getMessage());
                retry = true;
            } finally {
                jobFinished(params, retry);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    static void check(Context c) throws Exception {
        if (!Store.hasDevice(c)) {
            cancel(c);
            return;
        }
        JSONObject r = Api.inbox(c);
        if (r.optBoolean("signed_out")) {
            // Signed out somewhere else, or the code was replaced: stop checking until the next sign-in.
            Store.clearDevice(c);
            cancel(c);
            return;
        }
        String now = r.optString("now", "");
        if (MainActivity.isVisible()) { // the open app shows new messages itself
            if (!now.isEmpty()) Store.setSince(c, now);
            return;
        }

        // Newest message per chat, and how many arrived in each.
        JSONArray items = r.optJSONArray("items");
        Map<String, JSONObject> latest = new LinkedHashMap<>();
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (int i = 0; items != null && i < items.length(); i++) {
            JSONObject m = items.getJSONObject(i);
            String key = m.optString("kind") + ":" + m.optString("thread");
            latest.put(key, m); // items come oldest first, so the last one wins
            Integer n = counts.get(key);
            counts.put(key, n == null ? 1 : n + 1);
        }
        for (Map.Entry<String, JSONObject> e : latest.entrySet()) {
            JSONObject m = e.getValue();
            boolean room = "room".equals(m.optString("kind"));
            String thread = m.optString("thread");
            String from = m.optString("from_name", "Someone");
            String text = (m.optBoolean("by_ai") ? "AI auto-reply: " : "") + m.optString("text", "");
            int n = counts.get(e.getKey());
            String title = room ? m.optString("room_name", "Group") : from;
            String body = (room ? firstName(from) + ": " : "") + text;
            if (n > 1) body = n + " new messages. " + body;
            String hash = room ? "#/room/" + thread : "#/chat/" + thread;
            Notifier.message(c, (room ? "foryou-room-" : "foryou-dm-") + thread, title, body, MainActivity.safeHash(hash) ? hash : "");
        }

        int aiChats = r.optInt("ai_chats", 0);
        if (aiChats > 0) Notifier.aiFollowUp(c, aiChats);

        if (!now.isEmpty()) Store.setSince(c, now);
        Log.i(TAG, "Inbox checked: " + latest.size() + " chat(s) with new messages");
        Updater.check(c, true, false); // at most hourly: a notification when a new version is out
    }

    private static String firstName(String name) {
        String s = name == null ? "" : name.trim();
        int sp = s.indexOf(' ');
        return sp > 0 ? s.substring(0, sp) : s;
    }
}
