package com.vcpchat.m15fixture;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import org.json.JSONObject;
import org.json.JSONException;

/** Application-side oracle. It never consumes controller receipts or predicted outcomes. */
final class JourneyFixture {
    final MainActivity a;
    final String variant;
    final Handler handler = new Handler(Looper.getMainLooper());
    String page = "home", first = "", second = "";
    int firstWrites, secondWrites, nexts, backs, submissions, selections, toggles, scrollY, targetClicks;
    int starts, pulses, downCount, upCount, cancelCount, holdCount, tapCount;
    long downAt, wallDownAt, durationMs, wallDurationMs, finalAt;
    boolean selected, checked, loading, done, finalDone, activeTouch;
    static boolean isVariant(String v) {
        return "touch".equals(v) || "selected".equals(v) || "toggle".equals(v) || "multi".equals(v)
            || "lost".equals(v) || "scroll".equals(v) || "loading".equals(v) || "transient".equals(v)
            || "stuck".equals(v) || "launch".equals(v);
    }
    JourneyFixture(MainActivity a, String variant) { this.a = a; this.variant = variant; }
    void close() { handler.removeCallbacksAndMessages(null); }
    void add(View v, int height) { a.content.addView(v, new LinearLayout.LayoutParams(-1, height < 0 ? height : a.dp(height))); }
    Button button(String label, int id, Runnable action) {
        Button b = new Button(a); b.setText(label); b.setId(id); b.setOnClickListener(v -> { action.run(); a.publish(); }); return b;
    }
    EditText field(boolean primary) {
        EditText e = new EditText(a); e.setId(primary ? R.id.jd_first : R.id.jd_second);
        e.setSingleLine(true); e.setSaveEnabled(false); e.setShowSoftInputOnFocus(false);
        e.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(128) });
        e.setText(primary ? first : second);
        e.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void afterTextChanged(Editable s) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                if (primary && !first.equals(s.toString())) { first = s.toString(); firstWrites++; }
                if (!primary && !second.equals(s.toString())) { second = s.toString(); secondWrites++; }
                a.publish();
            }
        }); return e;
    }
    boolean back() {
        if (!"second".equals(page)) return false;
        backs++; page = "home"; if ("lost".equals(variant)) first = "";
        render(); a.publish(); return true;
    }
    void finish() { loading = false; done = finalDone = true; finalAt = SystemClock.uptimeMillis(); render(); a.publish(); }
    void start() {
        starts++; loading = true; render();
        if ("stuck".equals(variant)) return;
        if ("transient".equals(variant)) handler.postDelayed(() -> {
            pulses++; done = true; render(); a.publish();
            handler.postDelayed(() -> { done = false; render(); a.publish(); }, 80);
        }, 700);
        handler.postDelayed(this::finish, 2400);
    }
    void render() {
        a.content.removeAllViews();
        if ("touch".equals(variant)) { add(new TouchPad(), -1); }
        else if ("selected".equals(variant)) {
            Button b = button("Select item", R.id.jd_select, () -> { selected = true; selections++; });
            b.setSelected(selected); b.setOnClickListener(v -> { selected = true; selections++; b.setSelected(true); a.publish(); }); add(b, 64);
        } else if ("toggle".equals(variant)) {
            Switch s = new Switch(a); s.setId(R.id.jd_toggle); s.setText("Local option"); s.setChecked(checked);
            s.setOnCheckedChangeListener((v, value) -> { checked = value; toggles++; a.publish(); }); add(s, 64);
        } else if ("multi".equals(variant) || "lost".equals(variant)) {
            if ("home".equals(page)) {
                add(field(true), 64);
                add(button("Next", R.id.jd_next, () -> { nexts++; page = "second"; render(); }), 56);
                add(button("Review", R.id.jd_review, () -> { submissions++; page = "review"; done = true; render(); }), 56);
            } else if ("second".equals(page)) add(field(false), 64);
            else { add(a.label(first, R.id.jd_first), 56); add(a.label(second, R.id.jd_second), 56); }
        } else if ("scroll".equals(variant)) {
            if (!done) {
                ScrollView s = new ScrollView(a); s.setId(R.id.jd_scroll);
                LinearLayout rows = new LinearLayout(a); rows.setOrientation(LinearLayout.VERTICAL);
                for (int i = 0; i < 20; i++) rows.addView(a.label("Local row " + i, View.NO_ID), new LinearLayout.LayoutParams(-1, a.dp(64)));
                rows.addView(button("Open target", R.id.jd_target, () -> { targetClicks++; done = true; render(); }), new LinearLayout.LayoutParams(-1, a.dp(64)));
                // Leave room below the target so it can enter the viewport interior.
                rows.addView(a.label("End", View.NO_ID), new LinearLayout.LayoutParams(-1, a.dp(120)));
                s.addView(rows); add(s, -1); s.getViewTreeObserver().addOnScrollChangedListener(() -> { scrollY = s.getScrollY(); a.publish(); });
            }
        } else if ("launch".equals(variant)) { done = true; }
        else {
            if (starts == 0) add(button("Start loading", R.id.jd_start, this::start), 64);
            if (loading) add(a.label("Loading", R.id.jd_loading), 64);
        }
        if (done) add(a.label("Completed", R.id.jd_done), 56);
        a.content.post(a::publish);
    }
    final class TouchPad extends View {
        TouchPad() { super(a); setId(R.id.jd_touch); setClickable(true); setLongClickable(true); setContentDescription("Measured touch pad"); setBackgroundColor(0xffdceafa); }
        public boolean onTouchEvent(MotionEvent e) {
            int action = e.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) { downCount++; activeTouch = true; downAt = e.getEventTime(); wallDownAt = SystemClock.uptimeMillis(); }
            if (action == MotionEvent.ACTION_UP && activeTouch) {
                upCount++; activeTouch = false; durationMs = e.getEventTime() - downAt; wallDurationMs = SystemClock.uptimeMillis() - wallDownAt;
                if (durationMs >= 500) holdCount++; else tapCount++;
            }
            if (action == MotionEvent.ACTION_CANCEL && activeTouch) { cancelCount++; activeTouch = false; }
            a.publish(); return true;
        }
    }
    JSONObject state() throws JSONException {
        return new JSONObject().put("version", 1).put("variant", variant).put("page", page).put("first", first).put("second", second)
            .put("firstWrites", firstWrites).put("secondWrites", secondWrites).put("nexts", nexts).put("backs", backs).put("submissions", submissions)
            .put("selected", selected).put("selections", selections).put("checked", checked).put("toggles", toggles)
            .put("scrollY", scrollY).put("targetClicks", targetClicks).put("starts", starts).put("pulses", pulses)
            .put("loading", loading).put("done", done).put("finalDone", finalDone).put("finalAt", finalAt)
            .put("downCount", downCount).put("upCount", upCount).put("cancelCount", cancelCount).put("holdCount", holdCount).put("tapCount", tapCount)
            .put("activeTouch", activeTouch).put("durationMs", durationMs).put("wallDurationMs", wallDurationMs);
    }
}
