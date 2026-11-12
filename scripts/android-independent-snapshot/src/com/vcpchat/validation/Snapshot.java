package com.vcpchat.validation;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.util.Xml;
import org.xmlpull.v1.XmlSerializer;
import java.io.StringWriter;

/** One read, no input APIs, no persistent service, no global-idle requirement. */
public final class Snapshot {
    private static int nodes;
    private static String safe(CharSequence value) {
        if (value == null) return "";
        StringBuilder out = new StringBuilder();
        String text = value.toString();
        for (int offset = 0; offset < text.length();) {
            int c = text.codePointAt(offset);
            offset += Character.charCount(c);
            if (c == 9 || c == 10 || c == 13 || c >= 32 && c <= 0xd7ff
                || c >= 0xe000 && c <= 0xfffd || c >= 0x10000 && c <= 0x10ffff) out.appendCodePoint(c);
        }
        return out.toString();
    }
    private static void write(XmlSerializer xml, AccessibilityNodeInfo node, int depth) throws Exception {
        if (++nodes > 2000 || depth > 80) throw new IllegalStateException("TREE_LIMIT");
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        xml.startTag(null, "node");
        xml.attribute(null, "package", safe(node.getPackageName()));
        xml.attribute(null, "resource-id", safe(node.getViewIdResourceName()));
        xml.attribute(null, "class", safe(node.getClassName()));
        xml.attribute(null, "text", node.isPassword() ? "" : safe(node.getText()));
        xml.attribute(null, "password", Boolean.toString(node.isPassword()));
        xml.attribute(null, "visible-to-user", Boolean.toString(node.isVisibleToUser()));
        xml.attribute(null, "bounds", "[" + bounds.left + "," + bounds.top + "][" + bounds.right + "," + bounds.bottom + "]");
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) throw new IllegalStateException("TREE_CHANGED");
            try { write(xml, child, depth + 1); } finally { child.recycle(); }
        }
        xml.endTag(null, "node");
    }
    public static void main(String[] args) {
        Thread watchdog = new Thread(() -> {
            try { Thread.sleep(10000); } catch (InterruptedException ignored) { return; }
            System.err.println("VCP_SNAPSHOT_TIMEOUT"); Runtime.getRuntime().halt(70);
        });
        watchdog.setDaemon(true); watchdog.start();
        UiAutomation automation = null;
        Object wrapper = null;
        boolean connected = false;
        String output = null;
        String stage = "CONNECT";
        try {
            if (args.length != 0) throw new IllegalArgumentException();
            // The platform wrapper prepares its own main looper during connect.
            Class<?> shell = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
            wrapper = shell.getDeclaredConstructor().newInstance();
            stage = "CONNECT";
            shell.getMethod("connect").invoke(wrapper);
            connected = true;
            shell.getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false);
            automation = (UiAutomation) shell.getMethod("getUiAutomation").invoke(wrapper);
            stage = "ROOT";
            // Connection can be ready before the first active window is published.
            // Wait only for a non-null root, never for global accessibility idle.
            AccessibilityNodeInfo root = null;
            long rootDeadline = android.os.SystemClock.uptimeMillis() + 2000;
            do {
                root = automation.getRootInActiveWindow();
                if (root != null || android.os.SystemClock.uptimeMillis() >= rootDeadline) break;
                android.os.SystemClock.sleep(100);
            } while (true);
            if (root == null) throw new IllegalStateException();
            long treeDeadline = android.os.SystemClock.uptimeMillis() + 3000;
            for (int attempt = 1; attempt <= 3; attempt++) {
                StringWriter buffer = new StringWriter();
                nodes = 0;
                try {
                    stage = "TREE";
                    XmlSerializer xml = Xml.newSerializer(); xml.setOutput(buffer);
                    xml.startDocument("UTF-8", true); xml.startTag(null, "hierarchy");
                    write(xml, root, 0);
                    xml.endTag(null, "hierarchy"); xml.endDocument();
                    if (android.os.SystemClock.uptimeMillis() >= treeDeadline) throw new IllegalStateException("TREE_LIMIT");
                    output = buffer.toString();
                    break;
                } catch (IllegalStateException changed) {
                    if (!"TREE_CHANGED".equals(changed.getMessage()) || attempt == 3
                        || android.os.SystemClock.uptimeMillis() + 100 >= treeDeadline) throw changed;
                    System.err.println("VCP_SNAPSHOT_TREE_RETRY");
                } finally { root.recycle(); }
                android.os.SystemClock.sleep(100);
                root = automation.getRootInActiveWindow();
                if (root == null) throw new IllegalStateException("TREE_CHANGED");
            }
        } catch (Throwable failure) {
            System.err.println("VCP_SNAPSHOT_" + stage + "_FAILED");
            System.err.println("VCP_SNAPSHOT_EXCEPTION " + failure.getClass().getName());
            if (failure.getCause() != null) System.err.println("VCP_SNAPSHOT_CAUSE " + failure.getCause().getClass().getName());
            Throwable cause = failure.getCause() == null ? failure : failure.getCause();
            for (StackTraceElement frame : cause.getStackTrace()) {
                System.err.println("VCP_SNAPSHOT_FRAME " + frame.getClassName() + "." + frame.getMethodName() + ":" + frame.getLineNumber());
            }
            String message = String.valueOf(cause.getMessage());
            if (message.equals("TREE_CHANGED") || message.equals("TREE_LIMIT")) System.err.println("VCP_SNAPSHOT_DETAIL " + message);
            System.err.println("VCP_SNAPSHOT_REASON timeout=" + message.toLowerCase().contains("timed out")
                + " connected=" + message.contains("connected") + " register=" + message.contains("register")
                + " looper=" + message.toLowerCase().contains("looper") + " handler=" + message.toLowerCase().contains("handler"));
        } finally {
            if (connected) {
                try { wrapper.getClass().getMethod("disconnect").invoke(wrapper); }
                catch (Throwable failure) { output = null; System.err.println("VCP_SNAPSHOT_DISCONNECT_FAILED"); }
            }
        }
        if (output != null) System.out.println(output);
        System.exit(output == null ? 1 : 0);
    }
}
