# Window responsiveness probes

An intermittent freeze is reported as "nothing responds after restoring from
minimize". By the time a user reports it there is nothing left to inspect, so
the app now records what it can observe about itself. **These probes are
diagnostics: they never block input, retry, reload, repaint or recover
anything.** Recovery is deliberately out of scope until the evidence says which
side actually stops.

## Why two signals

The symptom is ambiguous:

- **Renderer stalled.** The WebView stops running; the native window still pumps
  messages, so Windows shows no "not responding" state, nothing is repainted
  (the content area goes blank after the next minimize/restore), and JS clicks
  do nothing while native ones still arrive.
- **UI thread blocked.** The Tauri/Win32 message loop itself stops: input,
  `CloseRequested`, timers and repaints all stop together.

A single heartbeat cannot separate them, and the fix differs completely: the
renderer needs re-initialisation, the UI thread needs a blocking-call audit.

## Signals

| Signal | Source | Meaning |
| --- | --- | --- |
| `ui_pumping` | `SendMessageTimeoutW(hwnd, WM_NULL, SMTO_ABORTIFHUNG, 1s)` on a dedicated thread | The message loop answered. Two consecutive misses (≥2s) are classified as a hang. |
| `heartbeat_gap` | `report_ui_heartbeat` IPC, every 2s while visible | The renderer's JS is running. One final beat with `hidden: true` is sent when the page becomes hidden. Only the monitored window's beats count: auxiliary windows render the same bundle and would otherwise mask a dead main renderer. |
| `minimized` / `visible` | `IsIconic` / `IsWindowVisible` (Windows); the last heartbeat's `hidden` flag elsewhere | Silence while minimized or hidden is expected and never judged. |

## Verdicts

The native probe ticks once per second (`window_responsiveness.rs`); the verdict
itself is pure logic (`window_responsiveness_signals.rs`):

1. `ui_pumping == false` → **UiThreadHung** (takes precedence: a blocked pump
   also explains a missing heartbeat).
2. Minimized or not visible → **Healthy**.
3. Restored less than 5s ago → **Healthy** (the first frame is still painting).
4. Heartbeat gap > 8s → **RendererStalled**, but only after two consecutive
   ticks agree. Beats travel through the same message loop, so a busy UI thread
   silences them too; the extra tick lets a recovered pump flush its backlog
   instead of logging a stall that never happened.
5. No beat has ever arrived → judged only after 30s of uptime, so cold start is
   not a false positive.

## Log events

Written to `app.log` through `runtime_log::record_event`, so they appear next to
every other product event with version, OS and PID:

| Event | Level | When |
| --- | --- | --- |
| `window.responsiveness.started` | info | First tick, once per run. `nativeProbe` / `heartbeat` / `uiPumping` say what the probe could actually observe, so a log with no further events is distinguishable from a probe that never ran. |
| `window.minimized` | info | Transition into the minimized state |
| `window.restored` | info | Transition back; `gapMs` is the silence measured across the restore |
| `window.ui_thread.hung` | warn | Message loop has not answered for ≥2s |
| `window.ui_thread.recovered` | info | Message loop answers again |
| `window.renderer.stalled` | warn | Visible, restored window silent for >8s |
| `window.renderer.recovered` | info | A beat arrived again |
| `window.close.uncoordinated` | warn | A close arrived for a window with no coordinator record (see below) |

Every payload carries `gapMs`, `sinceRestoreMs`, `stalledMs` and `minimized`.

## Reading a report

1. Find `window.restored`. `gapMs` there is the duration the app spent
   minimized; anything close to `sinceRestoreMs` is normal.
2. Look at what follows within a few seconds:
   - `window.ui_thread.hung` → the product froze its own message loop.
   - `window.renderer.stalled` without a preceding `window.ui_thread.hung` →
     the WebView stopped while the native window stayed alive, which is why the
     OS never flags the app as unresponsive.
   - Neither, but the user still reports a freeze → compare with
     `window.responsiveness.started`: if `nativeProbe` is false or the event is
     missing entirely, the probe never ran and the log proves nothing.
3. `stalledMs` tells how long the state lasted before recovery or exit.

## Close coordination ordering

`CloseRequested` resolves the window's coordinator record *before* calling
`prevent_close`. Suppressing the close first is irreversible, so a failed
resolution used to leave a window that could not be closed at all — no destroy,
no watchdog, no user escape except killing the process. An unresolved close now
logs `window.close.uncoordinated` and lets the platform close the window.

## Non-goals

- No automatic reload, repaint or window recreation.
- No user-visible UI, notification or prompt.
- No metrics upload; events stay in the local log.
