package com.vcpchat.m4fixture;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import java.util.List;

public final class StateProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { validate(uri); return "application/json"; }
    private static Integer validate(Uri uri) {
        if (!"content".equals(uri.getScheme()) || !"com.vcpchat.m4fixture.state".equals(uri.getAuthority())
            || !"/state".equals(uri.getPath()) || uri.getFragment() != null) {
            throw new IllegalArgumentException("Only /state[?displayId=N] is supported");
        }
        if (uri.getQuery() == null) return null;
        if (uri.getQueryParameterNames().size() != 1 || !uri.getQueryParameterNames().contains("displayId")) {
            throw new IllegalArgumentException("Only displayId filtering is supported");
        }
        List<String> values = uri.getQueryParameters("displayId");
        if (values.size() != 1 || !values.get(0).matches("0|[1-9][0-9]*")) {
            throw new IllegalArgumentException("displayId must be a nonnegative integer");
        }
        return Integer.valueOf(values.get(0));
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        Integer displayId = validate(uri);
        if (projection != null || selection != null || args != null || order != null) {
            throw new IllegalArgumentException("SQL query options are unsupported");
        }
        MatrixCursor result = new MatrixCursor(new String[] { "json" });
        result.addRow(new Object[] { FixtureState.read(displayId) });
        return result;
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("Read only"); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException("Read only"); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException("Read only"); }
}
