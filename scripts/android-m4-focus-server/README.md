# scrcpy 5.0.1 focus1 research server

This candidate adds `VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED` (`1 << 16`) to the existing Android 14+ new-display flag branch in scrcpy 5.0.1. `TRUSTED` and `OWN_FOCUS` remain enabled. It is a separately identified research artifact; the bundled production server is never replaced.

The build requires an existing clean checkout of commit `a60891aea193d92e7e5c3942700eca63f9d19a5f` in `artifacts/android-m4-focus-2026-11-06/upstream/` (or `--source`). The builder verifies the commit and clean status, copies sources into a fresh staging directory, applies the two exact edits in `focus1.patch`, generates upstream AIDL and BuildConfig, then compiles with the installed SDK. It does not download dependencies, invoke Gradle, execute ADB, install anything or change global configuration.

```powershell
node scripts/android-m4-focus-server/build.cjs --sdk F:/AndroidSdk --jdk F:/AndroidSdk/jbr
```

Defaults are platform `android-36` and build-tools `36.0.0`; `android-36.1` is also accepted. Output is `.build/scrcpy-server-focus1.jar`, `.build/build-evidence.json`, and `.build/LICENSE.scrcpy`. Per-build staging, command exits and logs are retained. The evidence records candidate identity, upstream commit, source hashes, patch hashes, compiler inputs, archive hash and Apache-2.0 license provenance. The server protocol version stays `5.0.1`; artifact identity is `scrcpy-5.0.1-focus1`.

AOSP Android 14 already defines this flag. With `TRUSTED` + `OWN_FOCUS`, Android can keep the default display as top focused while giving the virtual display its own focused window for explicitly targeted input. `DisplayWindowSettings` derives `mDontMoveToTop` from this flag, blocking activity-launch promotion; WindowManager also checks it on input-triggered display promotion. See the fixed AOSP sources and research note under `artifacts/android-m4-focus-2026-11-06/research-agent/`.

The flag does not isolate task reuse, system dialogs, clipboard, or application state. AOSP documents IME limitations on displays that cannot steal top focus, so the probe must retain `display_ime_policy=hide` and prohibit clipboard/IME input paths. Runtime behavior on the target ROM must be independently checked. Build success is not device acceptance or production approval.
