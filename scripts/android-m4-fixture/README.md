# M4 virtual-display fixture

Package `com.vcpchat.m4fixture` is independent of the M1.5 fixture and production controller. It has no Android permissions, network access, file/database writes, or reset/control Provider methods. All evidence and synthetic input are kept in process memory; process death resets them. Build only with the installed SDK:

```powershell
node scripts/android-m4-fixture/build.cjs --sdk F:/AndroidSdk --jdk F:/AndroidSdk/jbr
```

The builder uses local build-tools 36.0.0 / android-35, signs with a disposable fixture key, verifies the signature, and writes `.build/m4-fixture.apk` and `.build/build-evidence.json`. It never installs, launches, connects to, or modifies a device.

The exported launch components are `com.vcpchat.m4fixture/.MainActivity` (`standard`, resizeable) and `com.vcpchat.m4fixture/.SingleTaskActivity` (`singleTask`, resizeable, separate `com.vcpchat.m4fixture.single` affinity). Multiple standard instances require the launch caller to choose suitable new-task/multiple-task flags; a launch mode alone does not guarantee multiple tasks. Both show a teal background, large yellow counter button, and an EditText for explicitly testing IME placement. Launch does not request the keyboard or turn the screen on.

Read `content://com.vcpchat.m4fixture.state/state` with a ContentResolver query. The single cursor row has column `json`. Optional `?displayId=N` filters by nonnegative logical display ID. Other URI paths, filters, SQL query options, inserts, updates and deletes are rejected.

The JSON envelope is `{schemaVersion:1, package, processSession, captureStatus, capturedAtUptimeMs, states:[...]}`. `captureStatus` must be `fresh` for acceptance; the read asks the main thread to sample each live instance and explicitly reports `main-thread-timeout` or `interrupted` if this cannot complete. States sort by displayId then session. Each instance contains:

| Field | Meaning |
| --- | --- |
| `session`, `activity`, `displayId`, `taskId` | Instance UUID, activity class, logical display ID, task ID |
| `resumed`, `focused`, `destroyed` | Activity lifecycle and window focus; destroyed entries remain until process death |
| `width`, `height` | Display real dimensions in pixels, in its current rotation |
| `taps`, `touchEventCount` | Button click count and all MotionEvents delivered to this activity |
| `touchDisplayIds` | Distinct raw event display IDs, only when framework reflection succeeds |
| `deliveredDisplayIds` | Distinct receiving-activity display IDs; kept separate from raw event evidence |
| `touchDisplayIdUnavailable`, `touchDisplayIdError` | Number of events whose hidden getDisplayId API was unavailable, and last failure class |
| `buttonBounds`, `inputBounds` | `{left,top,right,bottom}` in absolute pixels of that display, right/bottom exclusive; null before layout |
| `inputText`, `inputFocused` | Actual EditText text and focus; synthetic input only, maximum 128 characters |
| `newIntentCount`, `capturedAtUptimeMs` | Reused activity intent count and observation uptime |

Android SDK 35 does not publicly expose `InputEvent.getDisplayId`. The fixture tries read-only reflection and leaves `touchDisplayIds` empty if the runtime blocks it; it never substitutes the Activity display ID. Independent counter changes and matching activity/session/display identities can still prove which fixture received a touch. Neither an exported Provider nor an APK build proves real device display isolation; installation, display creation, action injection, IME placement, cleanup and task migration require the separate P0 device run.
