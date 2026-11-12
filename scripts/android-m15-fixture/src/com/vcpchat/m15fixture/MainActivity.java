package com.vcpchat.m15fixture;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.Surface;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.view.GestureDetector;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.text.Editable;
import android.text.TextWatcher;
import org.json.JSONObject;
import java.util.UUID;

public final class MainActivity extends Activity {
    static volatile String snapshot = "{\"ready\":false}";
    // Animation runs until STOP. A fixed short window turns slow-host link latency into a false
    // product signal (observed 2026-11-05: the 30s motion window expired mid-case); the cap only
    // guards against a forgotten fixture and is far beyond any verification case.
    static final long ANIMATION_CAP_MS = 600_000L;
    final String session = UUID.randomUUID().toString();
    String mode = "gestures";
    boolean resumed;
    int longPress, doubleTap, dragDrops, imeActions, keyCombos, scrollY, targetClicks;
    int pinchBegins, pinchUpdates, deleteEvents, lastImeKey;
    int comboKey, comboMeta;
    double scale = 1;
    EditText input;
    SearchFixture m5;
    JourneyFixture journey;
    String m5Variant;
    TextView status, scrollTarget;
    LinearLayout content;
    View dragTarget;
    static final int M2_COLOR = Color.rgb(32, 160, 96);
    final Handler m2Handler = new Handler(Looper.getMainLooper());
    int m2ClicksA, m2ClicksB, m2DynamicCounter, m2Ticks, m2MotionStep;
    boolean m2Motion;
    long m2TextUntil, m2MotionUntil;
    int rotateRequests;
    Button m2Dynamic;
    TextView m2ColorView;
    final Runnable m2TextTick = new Runnable() {
        public void run() {
            if (!resumed || !"m2".equals(mode) || m2TextUntil == 0) return;
            if (SystemClock.uptimeMillis() >= m2TextUntil) { m2TextUntil = 0; publish(); return; }
            m2DynamicCounter++; m2Ticks++; updateM2Label(); publish();
            m2Handler.postDelayed(this, 100);
        }
    };
    final Runnable m2MotionTick = new Runnable() {
        public void run() {
            if (!resumed || !"m2".equals(mode) || !m2Motion) return;
            if (SystemClock.uptimeMillis() >= m2MotionUntil) { m2Motion = false; m2MotionUntil = 0; publish(); return; }
            m2Ticks++; m2MotionStep = (m2MotionStep + 1) % 120;
            LinearLayout.LayoutParams p = (LinearLayout.LayoutParams)m2ColorView.getLayoutParams();
            p.leftMargin = dp(2 * (m2MotionStep <= 60 ? m2MotionStep : 120 - m2MotionStep));
            m2ColorView.setLayoutParams(p);
            m2Handler.postDelayed(this, 80);
        }
    };

    int dp(float n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    TextView label(String text, int id) {
        TextView v = new TextView(this); v.setId(id); v.setText(text); v.setTextSize(18);
        v.setTextColor(Color.BLACK); v.setPadding(dp(12), dp(8), dp(12), dp(8)); return v;
    }
    Button nav(String text, int id, String next) {
        Button b = new Button(this); b.setId(id); b.setText(text);
        b.setOnClickListener(v -> show(next)); return b;
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(null);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(8), dp(24), dp(8), dp(24));
        status = label("", R.id.status); status.setTextSize(12); root.addView(status);
        LinearLayout navigation = new LinearLayout(this);
        navigation.addView(nav("Gestures", R.id.nav_gestures, "gestures"), new LinearLayout.LayoutParams(0, dp(52), 1));
        navigation.addView(nav("Keyboard", R.id.nav_keyboard, "keyboard"), new LinearLayout.LayoutParams(0, dp(52), 1));
        navigation.addView(nav("Scroll", R.id.nav_scroll, "scroll"), new LinearLayout.LayoutParams(0, dp(52), 1));
        navigation.addView(nav("M2", R.id.nav_m2, "m2"), new LinearLayout.LayoutParams(0, dp(52), 1));
        // In-fixture rotation: never touches system settings, and configChanges keeps this instance alive.
        Button rotate = new Button(this); rotate.setId(R.id.nav_rotate); rotate.setText("Rotate");
        rotate.setOnClickListener(v -> toggleOrientation());
        navigation.addView(rotate, new LinearLayout.LayoutParams(0, dp(52), 1));
        root.addView(navigation);
        content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        String requestedMode = getIntent().getStringExtra("fixtureMode");
        String requestedVariant = getIntent().getStringExtra("m5Variant");
        if ("journey".equals(requestedMode) && JourneyFixture.isVariant(getIntent().getStringExtra("journeyVariant"))) {
            journey = new JourneyFixture(this, getIntent().getStringExtra("journeyVariant"));
            mode = "journey"; journey.render();
        } else if ("m5".equals(requestedMode) && SearchFixture.isVariant(requestedVariant)) {
            m5Variant = requestedVariant;
            show("m5");
        } else show("gestures");
    }
    @Override public void onSaveInstanceState(Bundle state) { }
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        // Views re-measure on their own; republish after the new layout settles so an
        // observer never reads pre-rotation bounds.
        if (content != null) content.post(this::publish);
    }
    int displayRotation() { return getWindowManager().getDefaultDisplay().getRotation(); }
    void toggleOrientation() {
        rotateRequests++;
        int rotation = displayRotation();
        boolean landscape = rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270;
        setRequestedOrientation(landscape ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT : ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        publish();
    }
    @Override public void onResume() { super.onResume(); resumed = true; publish(); }
    @Override public void onPause() { stopM2Timers(); resumed = false; publish(); super.onPause(); }
    @Override public void onDestroy() { stopM2Timers(); if (journey != null) journey.close(); super.onDestroy(); }
    @Override public void onBackPressed() { if (journey == null || !journey.back()) super.onBackPressed(); }
    void show(String next) {
        if (journey != null) { journey.close(); journey = null; }
        stopM2Timers();
        mode = next; input = null; m5 = null; scrollTarget = null; m2Dynamic = null; m2ColorView = null; content.removeAllViews();
        m2ClicksA = m2ClicksB = m2DynamicCounter = m2Ticks = m2MotionStep = 0;
        longPress = doubleTap = dragDrops = imeActions = keyCombos = scrollY = targetClicks = 0;
        pinchBegins = pinchUpdates = deleteEvents = lastImeKey = comboKey = comboMeta = 0; scale = 1;
        if ("m5".equals(mode)) {
            m5 = new SearchFixture(this, m5Variant);
            m5.render();
        } else if ("keyboard".equals(mode)) {
            content.addView(label("Local-only editor; IME SEARCH records an event, never submits", View.NO_ID));
            input = new EditText(this); input.setId(R.id.input); input.setSingleLine(true);
            input.setSaveEnabled(false);
            input.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(128) });
            input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
            input.setImeOptions(EditorInfo.IME_ACTION_SEARCH | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
            input.setOnEditorActionListener((v, action, event) -> {
                if (action == EditorInfo.IME_ACTION_SEARCH || action == EditorInfo.IME_ACTION_DONE
                        || (event != null && (event.getKeyCode() == KeyEvent.KEYCODE_ENTER || event.getKeyCode() == KeyEvent.KEYCODE_SEARCH)
                        && event.getAction() == KeyEvent.ACTION_DOWN)) { imeActions++; publish(); return true; }
                return false;
            });
            input.setOnKeyListener((v, key, event) -> {
                if (key == KeyEvent.KEYCODE_ENTER || key == KeyEvent.KEYCODE_SEARCH) {
                    if (event.getAction() == KeyEvent.ACTION_DOWN) { imeActions++; lastImeKey = key; publish(); }
                    return true;
                }
                if (event.getAction() == KeyEvent.ACTION_DOWN) {
                    if (key == KeyEvent.KEYCODE_A && event.isCtrlPressed()) {
                        keyCombos++; comboKey = key; comboMeta = event.getMetaState();
                    }
                    if (key == KeyEvent.KEYCODE_DEL) deleteEvents++;
                    v.post(this::publish);
                }
                return false;
            });
            input.setOnFocusChangeListener((v, focused) -> v.post(this::publish));
            input.addTextChangedListener(new TextWatcher() {
                public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
                public void onTextChanged(CharSequence s, int start, int before, int count) { publish(); }
                public void afterTextChanged(Editable s) { }
            });
            content.addView(input, new LinearLayout.LayoutParams(-1, dp(64)));
        } else if ("m2".equals(mode)) {
            buildM2();
        } else if ("scroll".equals(mode)) {
            ScrollView scroll = new ScrollView(this); scroll.setId(R.id.scroll_container);
            LinearLayout rows = new LinearLayout(this); rows.setOrientation(LinearLayout.VERTICAL);
            for (int i = 0; i < 46; i++) {
                TextView row = label(i == 42 ? "M15_SCROLL_TARGET" : "Fixture row " + i, i == 42 ? R.id.scroll_target : View.NO_ID);
                rows.addView(row, new LinearLayout.LayoutParams(-1, dp(64)));
                if (i == 42) { scrollTarget = row; row.setOnClickListener(v -> { targetClicks++; publish(); }); }
            }
            scroll.addView(rows); content.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
            scroll.getViewTreeObserver().addOnScrollChangedListener(() -> { scrollY = scroll.getScrollY(); publish(); });
        } else {
            content.addView(new GesturePad(), new LinearLayout.LayoutParams(-1, 0, 1));
            LinearLayout dragRow = new LinearLayout(this);
            TextView source = label("DRAG SOURCE", R.id.drag_source);
            dragTarget = label("DROP TARGET", R.id.drag_target); dragTarget.setBackgroundColor(0xffd9eecb);
            source.setBackgroundColor(0xffffe1b5); source.setClickable(true);
            source.setOnTouchListener(new View.OnTouchListener() {
                float x, y; boolean armed;
                public boolean onTouch(View v, MotionEvent e) {
                    if (e.getActionMasked() == MotionEvent.ACTION_DOWN) { x = e.getRawX(); y = e.getRawY(); armed = true; }
                    if (e.getActionMasked() == MotionEvent.ACTION_CANCEL) armed = false;
                    if (e.getActionMasked() == MotionEvent.ACTION_UP && armed) {
                        Rect r = new Rect(); dragTarget.getGlobalVisibleRect(r);
                        if (Math.hypot(e.getRawX() - x, e.getRawY() - y) > dp(24) && r.contains((int)e.getRawX(), (int)e.getRawY())) dragDrops++;
                        armed = false; publish();
                    }
                    return true;
                }
            });
            dragRow.addView(source, new LinearLayout.LayoutParams(0, dp(88), 1));
            dragRow.addView(dragTarget, new LinearLayout.LayoutParams(0, dp(88), 1)); content.addView(dragRow);
            content.addView(new PinchPad(), new LinearLayout.LayoutParams(-1, 0, 1));
        }
        publish(); content.post(this::publish);
    }
    void stopM2Timers() {
        m2Handler.removeCallbacks(m2TextTick); m2Handler.removeCallbacks(m2MotionTick);
        m2TextUntil = m2MotionUntil = 0; m2Motion = false;
    }
    void updateM2Label() {
        if (m2Dynamic != null) m2Dynamic.setText("M2 DYNAMIC " + m2DynamicCounter);
    }
    Button m2Button(String text, int id) {
        Button b = new Button(this); b.setId(id); b.setText(text); b.setTextSize(12);
        b.setSingleLine(true); b.setMinWidth(0); b.setMinimumWidth(0);
        b.setPadding(dp(4), 0, dp(4), 0); return b;
    }
    void buildM2() {
        LinearLayout scopes = new LinearLayout(this);
        LinearLayout scopeA = new LinearLayout(this); scopeA.setId(R.id.m2_scope_a);
        LinearLayout scopeB = new LinearLayout(this); scopeB.setId(R.id.m2_scope_b);
        scopeA.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        scopeB.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        Button a = m2Button("M2 SAME", R.id.m2_same_a);
        Button b = m2Button("M2 SAME", R.id.m2_same_b);
        a.setOnClickListener(v -> { m2ClicksA++; publish(); });
        b.setOnClickListener(v -> { m2ClicksB++; publish(); });
        scopeA.addView(a, new LinearLayout.LayoutParams(-1, -1));
        scopeB.addView(b, new LinearLayout.LayoutParams(-1, -1));
        scopes.addView(scopeA, new LinearLayout.LayoutParams(0, dp(56), 1));
        scopes.addView(scopeB, new LinearLayout.LayoutParams(0, dp(56), 1));
        content.addView(scopes, new LinearLayout.LayoutParams(-1, dp(56)));
        m2Dynamic = m2Button("M2 DYNAMIC 0", R.id.m2_dynamic);
        m2Dynamic.setOnClickListener(v -> { m2DynamicCounter++; updateM2Label(); publish(); });
        content.addView(m2Dynamic, new LinearLayout.LayoutParams(-1, dp(56)));
        LinearLayout colorStage = new LinearLayout(this);
        m2ColorView = new TextView(this); m2ColorView.setId(R.id.m2_color);
        m2ColorView.setBackgroundColor(M2_COLOR); m2ColorView.setContentDescription("M2 COLOR");
        m2ColorView.setClickable(true); m2ColorView.setOnClickListener(v -> publish());
        m2ColorView.addOnLayoutChangeListener((v, l, t, r, bottom, oldL, oldT, oldR, oldB) -> {
            if ("m2".equals(mode) && resumed) publish();
        });
        colorStage.addView(m2ColorView, new LinearLayout.LayoutParams(dp(120), dp(56)));
        content.addView(colorStage, new LinearLayout.LayoutParams(-1, dp(72)));
        LinearLayout starts = new LinearLayout(this);
        Button text = m2Button("START TEXT", R.id.m2_start_text);
        text.setOnClickListener(v -> {
            stopM2Timers();
            if (resumed) { m2TextUntil = SystemClock.uptimeMillis() + ANIMATION_CAP_MS; m2TextTick.run(); }
            publish();
        });
        Button motion = m2Button("START MOTION", R.id.m2_start_motion);
        motion.setOnClickListener(v -> {
            stopM2Timers();
            if (resumed) { m2Motion = true; m2MotionUntil = SystemClock.uptimeMillis() + ANIMATION_CAP_MS; m2MotionTick.run(); }
        });
        starts.addView(text, new LinearLayout.LayoutParams(0, dp(52), 1));
        starts.addView(motion, new LinearLayout.LayoutParams(0, dp(52), 1));
        content.addView(starts, new LinearLayout.LayoutParams(-1, dp(52)));
        Button stop = m2Button("STOP", R.id.m2_stop);
        stop.setOnClickListener(v -> { stopM2Timers(); publish(); });
        content.addView(stop, new LinearLayout.LayoutParams(-1, dp(52)));
    }

    void publish() {
        try {
            JSONObject j = new JSONObject(); j.put("ready", true); j.put("package", getPackageName()); j.put("protocol", 1);
            j.put("session", session); j.put("resumed", resumed); j.put("mode", mode);
            j.put("longPress", longPress); j.put("doubleTap", doubleTap); j.put("dragDrops", dragDrops);
            DisplayMetrics real = new DisplayMetrics();
            getWindowManager().getDefaultDisplay().getRealMetrics(real);
            j.put("rotation", displayRotation()); j.put("rotateRequests", rotateRequests);
            j.put("width", real.widthPixels); j.put("height", real.heightPixels);
            j.put("scaleMilli", Math.round(scale * 1000)); j.put("imeActions", imeActions); j.put("keyCombos", keyCombos);
            j.put("pinchBegins", pinchBegins); j.put("pinchUpdates", pinchUpdates);
            j.put("deleteEvents", deleteEvents); j.put("lastImeKey", lastImeKey);
            j.put("comboKey", comboKey); j.put("comboMeta", comboMeta);
            j.put("focused", input != null && input.hasFocus());
            j.put("selectionStart", input == null ? -1 : input.getSelectionStart());
            j.put("selectionEnd", input == null ? -1 : input.getSelectionEnd());
            j.put("scrollY", scrollY); j.put("targetClicks", targetClicks);
            Rect r = new Rect(); j.put("targetVisible", scrollTarget != null && scrollTarget.getGlobalVisibleRect(r) && r.height() >= dp(32));
            j.put("text", input == null ? "" : input.getText().toString());
            j.put("m2ClicksA", m2ClicksA); j.put("m2ClicksB", m2ClicksB);
            j.put("m2DynamicCounter", m2DynamicCounter); j.put("m2Ticks", m2Ticks); j.put("m2Motion", m2Motion);
            Rect m2Rect = new Rect();
            if (m2ColorView != null && m2ColorView.getGlobalVisibleRect(m2Rect)) {
                int[] rootOnScreen = new int[2]; m2ColorView.getRootView().getLocationOnScreen(rootOnScreen);
                m2Rect.offset(rootOnScreen[0], rootOnScreen[1]);
                JSONObject rect = new JSONObject(); rect.put("left", m2Rect.left); rect.put("top", m2Rect.top);
                rect.put("right", m2Rect.right); rect.put("bottom", m2Rect.bottom); j.put("m2Rect", rect);
            } else j.put("m2Rect", JSONObject.NULL);
            j.put("m2Color", M2_COLOR); j.put("m2Label", m2Dynamic == null ? "" : m2Dynamic.getText().toString());
            j.put("m5", "m5".equals(mode) && m5 != null ? m5.state() : JSONObject.NULL);
            j.put("journey", journey == null ? JSONObject.NULL : journey.state());
            snapshot = j.toString();
            if (status != null) {
                if ("journey".equals(mode)) {
                    String title = "Deterministic task fixture; protocol 1";
                    if (!title.contentEquals(status.getText())) status.setText(title);
                } else if ("m5".equals(mode)) {
                    String title = "M5 isolated search; protocol 1";
                    if (!title.contentEquals(status.getText())) status.setText(title);
                } else if ("m2".equals(mode)) {
                    String title = "M2 isolated evidence; protocol 1";
                    if (!title.contentEquals(status.getText())) status.setText(title);
                } else status.setText("M15 " + mode + " LP=" + longPress + " DT=" + doubleTap
                    + " DRAG=" + dragDrops + " SCALE=" + Math.round(scale * 1000) + " IME=" + imeActions + " CTRL=" + keyCombos);
            }
        } catch (org.json.JSONException e) { throw new IllegalStateException(e); }
    }
    final class GesturePad extends View {
        final GestureDetector detector;
        final Paint paint = new Paint(3);
        GesturePad() {
            super(MainActivity.this); setId(R.id.gesture_pad); setClickable(true); setContentDescription("Long press and double tap pad");
            detector = new GestureDetector(MainActivity.this, new GestureDetector.SimpleOnGestureListener() {
                public boolean onDown(MotionEvent e) { return true; }
                public void onLongPress(MotionEvent e) { longPress++; publish(); invalidate(); }
                public boolean onDoubleTap(MotionEvent e) { doubleTap++; publish(); invalidate(); return true; }
            });
        }
        protected void onDraw(Canvas c) { c.drawColor(0xffdceafa); paint.setColor(Color.BLACK); paint.setTextSize(dp(18)); c.drawText("LONG PRESS / DOUBLE TAP", dp(12), dp(38), paint); }
        public boolean onTouchEvent(MotionEvent e) { detector.onTouchEvent(e); return true; }
    }
    final class PinchPad extends View {
        final ScaleGestureDetector detector;
        final Paint paint = new Paint(3);
        PinchPad() {
            super(MainActivity.this); setId(R.id.pinch_pad); setClickable(true); setContentDescription("Independent pinch scale pad");
            detector = new ScaleGestureDetector(MainActivity.this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                public boolean onScaleBegin(ScaleGestureDetector d) { pinchBegins++; publish(); return true; }
                public boolean onScale(ScaleGestureDetector d) { pinchUpdates++; scale = Math.max(.05, Math.min(20, scale * d.getScaleFactor())); publish(); invalidate(); return true; }
            });
        }
        protected void onDraw(Canvas c) { c.drawColor(0xffe7ddf6); paint.setColor(Color.BLACK); paint.setTextSize(dp(18)); c.drawText("PINCH SCALE " + Math.round(scale * 1000), dp(12), dp(38), paint); }
        public boolean onTouchEvent(MotionEvent e) { detector.onTouchEvent(e); return true; }
    }
}
