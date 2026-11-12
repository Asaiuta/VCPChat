package com.vcpchat.m4fixture;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * A5-only: requests POST_NOTIFICATIONS once on first resume so the system permission
 * dialog placement can be observed. It never grants anything itself; the probe never taps it.
 */
public final class PermissionActivity extends MainActivity {
    private static final String PERMISSION = "android.permission.POST_NOTIFICATIONS";
    private boolean requested;
    private int resultCount;
    private String lastResult = "";

    @Override protected void onResume() {
        super.onResume();
        if (!requested) {
            requested = true;
            requestPermissions(new String[] { PERMISSION }, 4501);
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != 4501) return;
        resultCount++;
        lastResult = grantResults.length == 0 ? "cancelled" : grantResults[0] == 0 ? "granted" : "denied";
        capture();
    }

    @Override JSONObject capture() {
        JSONObject state = super.capture();
        try {
            return state.put("permissionRequested", requested).put("permissionResultCount", resultCount)
                .put("permissionLastResult", lastResult);
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }
}
