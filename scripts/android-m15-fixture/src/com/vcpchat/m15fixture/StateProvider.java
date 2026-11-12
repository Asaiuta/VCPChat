package com.vcpchat.m15fixture;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;

public final class StateProvider extends ContentProvider {
    public boolean onCreate() { return true; }
    public String getType(Uri uri) { return "application/json"; }
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        if (!"content".equals(uri.getScheme()) || !(getContext().getPackageName() + ".state").equals(uri.getAuthority())
                || !"/state".equals(uri.getPath()) || uri.getQuery() != null || uri.getFragment() != null
                || projection != null || selection != null || args != null || order != null) {
            throw new IllegalArgumentException("Only an unfiltered /state query is supported");
        }
        MatrixCursor result = new MatrixCursor(new String[] { "state" });
        result.addRow(new Object[] { "com.vcpchat.fixturepeer".equals(getContext().getPackageName()) ? PeerActivity.snapshot : MainActivity.snapshot });
        return result;
    }
    public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("Read only"); }
    public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException("Read only"); }
    public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException("Read only"); }
}
