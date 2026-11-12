package com.vcpchat.uiautomator;

import android.os.Process;
import android.os.SystemClock;
import android.system.Os;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;

/** The nonce binds accidental stale processes, not a compromised shell UID. */
public final class Owner {
    private static final String PREFIX = "VCP_OWNER_V1 ";
    private final String nonce;
    private final int rpcPort;
    private final ServerSocket control;
    private final JSONObject identity;
    // Host death, adb loss, and host quarantine must all release UiAutomation.
    // Only authenticated INFO with a proven RPC socket renews this monotonic lease.
    private static final long LEASE_MS = 30000;
    private volatile long leaseDeadline = SystemClock.elapsedRealtime() + LEASE_MS;

    private void checkLease() {
        if (SystemClock.elapsedRealtime() >= leaseDeadline) System.exit(71);
    }

    private Owner(int port) throws Exception {
        rpcPort = port;
        nonce = System.getenv("VCP_OWNER_NONCE");
        if (nonce == null || !nonce.matches("[a-f0-9]{64}")) throw new IOException("Invalid owner nonce");
        ServerSocket candidate;
        do {
            candidate = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
            if (candidate.getLocalPort() != rpcPort) break;
            candidate.close();
        } while (true);
        control = candidate;
        control.setSoTimeout(1000);
        identity = new JSONObject();
        identity.put("nonce", nonce);
        identity.put("port", control.getLocalPort());
        identity.put("pid", Process.myPid());
        identity.put("startTime", startTime());
        identity.put("uid", Process.myUid());
        JSONArray argv = new JSONArray();
        for (String arg : read("/proc/self/cmdline").split("\u0000")) if (!arg.isEmpty()) argv.put(arg);
        identity.put("cmdline", argv);
    }

    private static String read(String file) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[4096];
            int n;
            while ((n = in.read(buffer)) != -1) {
                if (out.size() + n > 1024 * 1024) throw new IOException("Proc data too large");
                out.write(buffer, 0, n);
            }
        }
        return new String(out.toByteArray(), "UTF-8");
    }

    private static String startTime() throws IOException {
        String stat = read("/proc/self/stat");
        String[] fields = stat.substring(stat.lastIndexOf(')') + 2).trim().split("\\s+");
        return fields[19];
    }

    private String rpcInode() throws Exception {
        Set<String> sockets = new HashSet<String>();
        File[] descriptors = new File("/proc/self/fd").listFiles();
        if (descriptors == null) throw new IOException("Cannot enumerate own sockets");
        for (File fd : descriptors) {
            try {
                String link = Os.readlink(fd.getPath());
                if (link.startsWith("socket:[") && link.endsWith("]")) sockets.add(link.substring(8, link.length() - 1));
            } catch (Exception ignored) { /* Descriptor may close during enumeration. */ }
        }
        for (String table : new String[] { "/proc/self/net/tcp", "/proc/self/net/tcp6" }) {
            for (String line : read(table).split("\n")) {
                String[] f = line.trim().split("\\s+");
                if (f.length < 10 || !"0A".equals(f[3])) continue;
                String[] address = f[1].split(":");
                if (address.length == 2 && Integer.parseInt(address[1], 16) == rpcPort && sockets.contains(f[9])) return f[9];
            }
        }
        return null;
    }

    private String line(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int c; (c = in.read()) != -1;) {
            if (c == '\n') return new String(out.toByteArray(), "US-ASCII");
            if (out.size() >= 1024) throw new IOException("Command too long");
            out.write(c);
        }
        throw new EOFException();
    }

    private boolean authorized(String supplied) throws Exception {
        return MessageDigest.isEqual(nonce.getBytes("US-ASCII"), supplied.getBytes("US-ASCII"));
    }

    private void serve() throws Exception {
        while (true) {
            checkLease();
            try (Socket socket = control.accept()) {
                socket.setSoTimeout(1500);
                try {
                    String[] command = line(socket.getInputStream()).split(" ", -1);
                    checkLease();
                    PrintWriter out = new PrintWriter(new OutputStreamWriter(socket.getOutputStream(), "UTF-8"), true);
                    if (command.length != 2 || !authorized(command[1])) { out.println("DENIED"); continue; }
                    if ("STOP".equals(command[0])) {
                        out.println("STOPPING");
                        System.exit(0);
                    }
                    if (!"INFO".equals(command[0])) { out.println("DENIED"); continue; }
                    String inode = null;
                    try { inode = rpcInode(); } catch (Exception ignored) { /* Unknown ownership never admits RPC. */ }
                    JSONObject result = new JSONObject(identity.toString());
                    result.put("rpcPort", rpcPort);
                    result.put("rpcOwned", inode != null);
                    result.put("rpcInode", inode == null ? JSONObject.NULL : inode);
                    checkLease();
                    if (inode != null) leaseDeadline = SystemClock.elapsedRealtime() + LEASE_MS;
                    out.println(result.toString());
                } catch (Exception ignored) { /* Malformed clients cannot terminate the owner. */ }
            } catch (SocketTimeoutException ignored) { /* Check the host lease. */ }
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("RPC port required");
        final int rpcPort = Integer.parseInt(args[0]);
        if (rpcPort < 1 || rpcPort > 65535) throw new IllegalArgumentException("Invalid RPC port");
        final Owner owner = new Owner(rpcPort);
        Thread watchdog = new Thread(new Runnable() {
            public void run() {
                try {
                    while (true) { Thread.sleep(1000); owner.checkLease(); }
                } catch (Throwable failure) { System.exit(73); }
            }
        }, "vcp-owner-lease");
        watchdog.setDaemon(true);
        watchdog.start();
        System.out.println(PREFIX + owner.identity.toString());
        System.out.flush();
        PrintStream sink = new PrintStream(new FileOutputStream("/dev/null"), true);
        System.setOut(sink);
        System.setErr(sink);
        Thread control = new Thread(new Runnable() {
            public void run() {
                try { owner.serve(); }
                catch (Throwable failure) { /* The control plane must not disappear independently. */ }
                finally { System.exit(72); }
            }
        }, "vcp-owner");
        control.start();
        try {
            Class.forName("com.github.uiautomator2.Console").getMethod("main", String[].class)
                .invoke(null, (Object) new String[] { "-p", Integer.toString(rpcPort) });
        } catch (Throwable failure) { System.exit(70); }
    }
}
