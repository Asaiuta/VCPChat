package com.vcpchat.m15fixture;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.UUID;

/** Isolated launch target: no permissions, storage, network, or editable user data. */
public final class PeerActivity extends Activity {
    static volatile String snapshot = "{\"ready\":false}";
    final String session = UUID.randomUUID().toString();
    boolean resumed;
    @Override public void onCreate(Bundle state) {
        super.onCreate(null);
        TextView view = new TextView(this); view.setText("Isolated launch peer"); view.setTextSize(24); setContentView(view);
    }
    @Override public void onResume() { super.onResume(); resumed = true; publish(); }
    @Override public void onPause() { resumed = false; publish(); super.onPause(); }
    void publish() {
        try { snapshot = new JSONObject().put("ready", true).put("package", getPackageName()).put("protocol", 1)
            .put("session", session).put("resumed", resumed).toString(); }
        catch (org.json.JSONException e) { throw new IllegalStateException(e); }
    }
}
