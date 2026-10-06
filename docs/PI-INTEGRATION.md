# Pi runtime integration

Flowix uses Pi v1.0.3 through its JSONL RPC process interface. Each Flowix
conversation gets a separate Pi session directory and a reusable RPC process.
Streamed text, reasoning, tool calls, tool results, and token usage are
projected into Flowix's existing conversation journal. Image attachments are
passed to Pi as inline image data; other attached files are included as paths
in the prompt context.

## Message and process lifecycle

Each prompt is one Flowix run. The run ends when Pi reports `agent_settled`,
independently of the RPC process lifetime. Flowix then ends the loading state
while keeping the Pi process available for the next prompt in that thread.
Stop sends `clear_queue` and `abort`; it ends the current Flowix run and keeps
the process after Pi settles. Prompts, history reads, and process replacement
are serialized per session. An idle RPC process is closed after ten minutes,
when its thread is deleted, or when Flowix exits. If model, provider, tools,
thinking level, or working directory changes, Flowix reopens the same native
Pi session with the persisted Pi session ID and the updated runtime settings.

## Build variants

- `npm run tauri:dev:pi` downloads the matching Pi v1.0.3 archive into
  `.build/pi-runtime`, verifies its pinned SHA-256 digest, and points the dev
  app at that executable. No system-wide Pi installation is required.
- `npm run tauri:dev` reuses Pi from an installed Flowix app when it finds one
  in the standard app location for the current platform. Set `PI_CLI_PATH` to
  override the executable path, or `FLOWIX_PROD_APP_PATH` when the app is in a
  non-standard location. This avoids downloading or staging another Pi build.
- `npm run tauri:build:prod` builds Flowix without Pi. The user must have `pi`
  on `PATH` or set `PI_CLI_PATH` to a Pi v1.0.3 executable.
- `npm run tauri:build:prod:pi` downloads the matching Pi v1.0.3 release
  archive, verifies its pinned SHA-256 digest, and puts the matching runtime
  in the app resources. The universal macOS build stages arm64 and x64
  archives separately and includes only the matching runtime in each app.

Pi-enabled artifacts use the Pi updater endpoint family. Release infrastructure
must publish manifests under `/updater/pi/{macos,windows,linux}/latest.json` or
set `FLOWIX_UPDATER_ENDPOINT_PI_MACOS`, `FLOWIX_UPDATER_ENDPOINT_PI_WINDOWS`,
and `FLOWIX_UPDATER_ENDPOINT_PI_LINUX` as appropriate. This keeps Pi-enabled
and base installations on separate update channels.

## Models and permissions

The model picker reads Pi's `get_available_models` RPC response and stores the
selected provider ID and model ID together. The reasoning selector uses Pi's
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` levels. Pi RPC
does not provide sandbox approval modes; it lets the host select built-in tools
with `--tools`. Flowix exposes three permission choices in the conversation
input: `read-only` enables `read`, `workspace-write` enables `read`, `edit`, and
`write`, and `danger-full-access` enables all four (`read`, `bash`, `edit`, and
`write`). The default remains `danger-full-access`. These choices limit which
tools Pi can invoke; they do not provide operating-system-level filesystem
isolation or per-path write restrictions.

History is read from Pi's native session through the `get_messages` RPC after
opening the conversation's session directory with `--continue`. A dedicated
Pi history adapter maps native user, assistant, reasoning, tool, bash, custom,
and compaction messages into Flowix rows and pages the full RPC transcript by
conversation turns. Pi's session remains the history source of truth; Flowix's
external-event journal is not used to reconstruct Pi conversations.

Pi thinking blocks are not forwarded to Flowix by default. Set
`FLOWIX_PI_FORWARD_THINKING=1` (also accepts `true`, `yes`, or `on`) in the
Flowix process environment to forward them in live events and history responses.
This only controls Flowix projection; it does not change Pi's thinking level or
the native Pi session contents.

## Session identity and restore

Flowix's `threads_index.id` is the durable product conversation identity. Each
thread maps to Pi's native `sessionId` in `threads_pi`; the binding is created
from Pi's `get_state` RPC when a run starts and can be recovered by the same
RPC while history is loaded. The Pi `sessionFile`, working directory, and
schema version are stored with the provider binding for diagnostics and future
migrations. Conversation lists and workspace restore continue to use Flowix's
persisted thread and instance records, then reopen the matching Pi session
directory. Pi RPC does not offer a session-list command, so Flowix does not
depend on one.

Session directories are derived from the Flowix thread ID using a stable
SHA-256 name. Older directories created with the previous hash scheme are
moved to the stable location the next time that conversation is opened. The
conversation title bar reads the mapped Pi `sessionId` from the desktop
database, so it remains available after a refresh and can be copied from the
agent badge hover card.

Flowix sets `PI_CODING_AGENT_DIR` to its Pi configuration directory
(`Flowix/pi` below the platform user config directory). The Preferences **Pi**
page manages compatible providers in `models.json`, API credentials in
`auth.json`, and the default provider/model in `settings.json`. Credential files
are written with user-only permissions on Unix. The page supports model
discovery, manual model entries, and a connection probe. The model picker below
the conversation input reads Pi's available-model catalog and keeps a
conversation-level provider/model selection separate from the global default.
The runtime also inherits provider API-key environment variables from Flowix.
