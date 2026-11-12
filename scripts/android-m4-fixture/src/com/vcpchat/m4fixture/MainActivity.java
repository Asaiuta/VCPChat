package com.vcpchat.m4fixture;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Point;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Display;
import android.view.MotionEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.lang.reflect.Method;
import java.util.LinkedHashSet;
import java.util.UUID;

/** Deliberately separate from the M1.5 fixture and all production controller code. */
public class MainActivity extends Activity {
    final String session = UUID.randomUUID().toString();
    private final LinkedHashSet<Integer> touchDisplayIds = new LinkedHashSet<>();
    private final LinkedHashSet<Integer> deliveredDisplayIds = new LinkedHashSet<>();
    private LinearLayout root;
    private TextView status;
    private Button button;
    private EditText input;
    private boolean resumed;
    private boolean focused;
    private boolean destroyed;
    private int taps;
    private int touchEventCount;
    private int touchDisplayIdUnavailable;
    private String touchDisplayIdError = "";
    private int newIntentCount;
    private int lastDisplayId = -1;
    private int lastTaskId = -1;
    private int width;
    private int height;

    @Override public void onCreate(Bundle state) {
        super.onCreate(null);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(48), dp(24), dp(24));
        root.setFocusableInTouchMode(true);
        root.setBackgroundColor(Color.rgb(0, 150, 165));
        status = new TextView(this);
        status.setId(R.id.status);
        status.setTextColor(Color.WHITE);
        status.setTextSize(20);
        root.addView(status, new LinearLayout.LayoutParams(-1, -2));
        button = new Button(this);
        button.setId(R.id.tap_button);
        button.setText("M4 TAP 0");
        button.setTextColor(Color.BLACK);
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(255, 210, 40)));
        LinearLayout.LayoutParams buttonLayout = new LinearLayout.LayoutParams(-1, dp(80));
        buttonLayout.topMargin = dp(28);
        root.addView(button, buttonLayout);
        button.setOnClickListener(v -> { taps++; button.setText("M4 TAP " + taps); publish(); });
        input = new EditText(this);
        input.setId(R.id.input);
        input.setSingleLine(true);
        input.setHint("M4 synthetic input / IME");
        input.setTextColor(Color.BLACK);
        input.setHintTextColor(Color.DKGRAY);
        input.setBackgroundColor(Color.WHITE);
        input.setPadding(dp(12), dp(8), dp(12), dp(8));
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setImeOptions(EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(128) });
        input.setSaveEnabled(false);
        LinearLayout.LayoutParams inputLayout = new LinearLayout.LayoutParams(-1, dp(64));
        inputLayout.topMargin = dp(28);
        root.addView(input, inputLayout);
        input.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { publish(); }
            public void afterTextChanged(Editable s) {}
        });
        input.setOnFocusChangeListener((v, hasFocus) -> publish());
        setContentView(root);
        root.requestFocus();
        root.getViewTreeObserver().addOnGlobalLayoutListener(this::publish);
        FixtureState.register(this);
        publish();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private int currentDisplayId() {
        if (destroyed) return lastDisplayId;
        Display display = root == null ? null : root.getDisplay();
        if (display == null) display = getWindowManager().getDefaultDisplay();
        if (display != null) {
            lastDisplayId = display.getDisplayId();
            Point size = new Point();
            display.getRealSize(size);
            if (size.x > 0 && size.y > 0) { width = size.x; height = size.y; }
        }
        return lastDisplayId;
    }

    @Override protected void onResume() { super.onResume(); resumed = true; publish(); }
    @Override protected void onPause() { resumed = false; publish(); super.onPause(); }
    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus); focused = hasFocus; publish();
    }
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration); publish();
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); newIntentCount++; publish();
    }
    @Override protected void onSaveInstanceState(Bundle state) { /* No input persistence. */ }
    @Override protected void onDestroy() {
        resumed = false; focused = false; destroyed = true; publish();
        FixtureState.retire(this);
        super.onDestroy();
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        touchEventCount++;
        deliveredDisplayIds.add(currentDisplayId());
        // getDisplayId exists in framework internals but is absent from public SDK 35.
        // Never substitute the receiving Activity display for raw input-event evidence.
        try {
            Method getter = event.getClass().getMethod("getDisplayId");
            touchDisplayIds.add(((Number) getter.invoke(event)).intValue());
        } catch (ReflectiveOperationException | RuntimeException failure) {
            touchDisplayIdUnavailable++;
            touchDisplayIdError = failure.getClass().getSimpleName();
        }
        boolean handled = super.dispatchTouchEvent(event);
        publish();
        return handled;
    }

    private static JSONObject bounds(View view) throws JSONException {
        if (view == null || !view.isLaidOut()) return null;
        int[] point = new int[2];
        view.getLocationOnScreen(point);
        return new JSONObject().put("left", point[0]).put("top", point[1])
            .put("right", point[0] + view.getWidth()).put("bottom", point[1] + view.getHeight());
    }

    JSONObject capture() {
        try {
            int displayId = currentDisplayId();
            int taskId = getTaskId();
            if (taskId >= 0) lastTaskId = taskId;
            return new JSONObject().put("session", session)
                .put("activity", getClass().getSimpleName()).put("displayId", displayId)
                .put("taskId", lastTaskId).put("resumed", resumed).put("focused", focused)
                .put("destroyed", destroyed).put("width", width).put("height", height)
                .put("taps", taps).put("touchEventCount", touchEventCount)
                .put("touchDisplayIds", new JSONArray(touchDisplayIds))
                .put("deliveredDisplayIds", new JSONArray(deliveredDisplayIds))
                .put("touchDisplayIdUnavailable", touchDisplayIdUnavailable)
                .put("touchDisplayIdError", touchDisplayIdError)
                .put("buttonBounds", nullable(bounds(button))).put("inputBounds", nullable(bounds(input)))
                .put("inputText", input == null ? "" : input.getText().toString())
                .put("inputFocused", input != null && input.hasFocus())
                .put("newIntentCount", newIntentCount).put("capturedAtUptimeMs", SystemClock.uptimeMillis());
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    private static Object nullable(Object value) { return value == null ? JSONObject.NULL : value; }
    private void publish() {
        if (root == null || input == null) return;
        currentDisplayId();
        String label = "M4 DISPLAY " + lastDisplayId + " / TASK " + getTaskId()
            + "\n" + getClass().getSimpleName() + "\n" + session.substring(0, 8) + " / taps " + taps;
        if (!label.contentEquals(status.getText())) status.setText(label);
        FixtureState.publish(session, capture());
    }
}
