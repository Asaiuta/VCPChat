package com.vcpchat.m4fixture;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

final class FixtureState {
    private static final String PROCESS_SESSION = UUID.randomUUID().toString();
    private static final Map<String, JSONObject> states = new LinkedHashMap<>();
    private static final Map<String, WeakReference<MainActivity>> active = new LinkedHashMap<>();

    static synchronized void register(MainActivity activity) {
        active.put(activity.session, new WeakReference<>(activity));
    }
    static synchronized void publish(String session, JSONObject state) { states.put(session, state); }
    static synchronized void retire(MainActivity activity) { active.remove(activity.session); }

    private static void refresh() {
        ArrayList<WeakReference<MainActivity>> copy;
        synchronized (FixtureState.class) { copy = new ArrayList<>(active.values()); }
        for (WeakReference<MainActivity> reference : copy) {
            MainActivity activity = reference.get();
            if (activity != null) publish(activity.session, activity.capture());
        }
    }

    static String read(Integer displayId) {
        String captureStatus = "fresh";
        if (Looper.myLooper() == Looper.getMainLooper()) refresh();
        else {
            CountDownLatch done = new CountDownLatch(1);
            new Handler(Looper.getMainLooper()).post(() -> { try { refresh(); } finally { done.countDown(); } });
            try { if (!done.await(2, TimeUnit.SECONDS)) captureStatus = "main-thread-timeout"; }
            catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt(); captureStatus = "interrupted";
            }
        }
        try {
            ArrayList<JSONObject> copy;
            synchronized (FixtureState.class) { copy = new ArrayList<>(states.values()); }
            copy.sort(Comparator.comparingInt((JSONObject value) -> value.optInt("displayId", -1))
                .thenComparing(value -> value.optString("session")));
            JSONArray result = new JSONArray();
            for (JSONObject value : copy) {
                if (displayId == null || value.optInt("displayId", -1) == displayId.intValue()) result.put(value);
            }
            return new JSONObject().put("schemaVersion", 1).put("package", "com.vcpchat.m4fixture")
                .put("processSession", PROCESS_SESSION).put("captureStatus", captureStatus)
                .put("capturedAtUptimeMs", SystemClock.uptimeMillis()).put("states", result).toString();
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }
}
