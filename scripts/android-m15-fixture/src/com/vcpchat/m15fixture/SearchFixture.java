package com.vcpchat.m15fixture;

import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;

import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import org.json.JSONException;
import org.json.JSONObject;

final class SearchFixture {
    static final String SEED = "M5_SEED_OLD";
    static final int QUERY_LIMIT = 128;
    final MainActivity activity;
    final String variant;
    String stage;
    String query = SEED;
    String lastQuery = "";
    int entries, submissions, textChanges;
    boolean resultVisible;
    boolean passwordField;

    static boolean isVariant(String value) {
        return "home".equals(value) || "form".equals(value) || "duplicate".equals(value)
            || "password".equals(value) || "preexisting".equals(value) || "no-result".equals(value);
    }

    SearchFixture(MainActivity activity, String variant) {
        if (!isVariant(variant)) throw new IllegalArgumentException("Unknown M5 variant");
        this.activity = activity;
        this.variant = variant;
        stage = "home".equals(variant) ? "home" : "form";
        resultVisible = "preexisting".equals(variant);
    }

    void render() {
        activity.content.removeAllViews();
        if ("home".equals(stage)) {
            Button entry = button("M5 ENTRY", R.id.m5_entry);
            entry.setOnClickListener(v -> {
                if (!"home".equals(stage)) return;
                if (entries < Integer.MAX_VALUE) entries++;
                stage = "form";
                render();
                activity.publish();
            });
            activity.content.addView(entry, new LinearLayout.LayoutParams(-1, activity.dp(56)));
        } else if ("form".equals(stage)) {
            EditText field = new EditText(activity);
            field.setId(R.id.m5_query);
            field.setSaveEnabled(false);
            field.setFilters(new InputFilter[] { new InputFilter.LengthFilter(QUERY_LIMIT) });
            field.setSingleLine(true);
            field.setInputType(InputType.TYPE_CLASS_TEXT | ("password".equals(variant)
                ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS));
            passwordField = field.getTransformationMethod() instanceof android.text.method.PasswordTransformationMethod;
            field.setShowSoftInputOnFocus(false);
            field.setText(query);
            field.addTextChangedListener(new TextWatcher() {
                public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
                public void onTextChanged(CharSequence s, int start, int before, int count) {
                    String next = bounded(s.toString());
                    if (!query.equals(next)) {
                        query = next;
                        if (textChanges < Integer.MAX_VALUE) textChanges++;
                        activity.publish();
                    }
                }
                public void afterTextChanged(Editable s) { }
            });
            activity.content.addView(field, new LinearLayout.LayoutParams(-1, activity.dp(64)));
            addSubmit("M5 SEARCH");
            if ("duplicate".equals(variant)) addSubmit("M5 SEARCH ALTERNATE");
        }
        if (resultVisible) {
            activity.content.addView(activity.label("M5 RESULTS", R.id.m5_results),
                new LinearLayout.LayoutParams(-1, activity.dp(56)));
        }
    }

    Button button(String text, int id) {
        Button button = new Button(activity);
        button.setId(id);
        button.setText(text);
        return button;
    }

    void addSubmit(String text) {
        Button submit = button(text, R.id.m5_search_go);
        submit.setOnClickListener(v -> {
            if (!"form".equals(stage)) return;
            lastQuery = bounded(query);
            if (submissions < Integer.MAX_VALUE) submissions++;
            if (!"no-result".equals(variant)) {
                stage = "results";
                resultVisible = true;
                render();
            }
            activity.publish();
        });
        activity.content.addView(submit, new LinearLayout.LayoutParams(-1, activity.dp(56)));
    }

    static String bounded(String value) {
        return value.length() > QUERY_LIMIT ? value.substring(0, QUERY_LIMIT) : value;
    }

    JSONObject state() throws JSONException {
        JSONObject state = new JSONObject();
        state.put("version", 1);
        state.put("variant", variant);
        state.put("stage", stage);
        state.put("entries", entries);
        state.put("submissions", submissions);
        state.put("textChanges", textChanges);
        state.put("query", query);
        state.put("lastQuery", lastQuery);
        state.put("resultVisible", resultVisible);
        state.put("passwordField", passwordField);
        return state;
    }
}
