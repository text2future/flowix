# Pi runtime integration

Flowix uses Pi v1.1.0 through its JSONL RPC process interface. Each Flowix
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

- Pi is an application resource in every desktop build. Runtime availability
  checks and Pi process startup resolve the same bundled executable; neither
  `PATH` nor `PI_CLI_PATH` selects an external Pi installation.
- `npm run tauri:dev` reuses the matching architecture already staged in
  `.build/pi-runtime`; if it is missing, the command downloads Pi v1.1.0,
  verifies its pinned SHA-256 digest, and stages it. No system-wide Pi
  installation is required. `npm run tauri:dev:pi` remains available to force
  staging again.
- `npm run tauri:build:prod` stages Pi v1.1.0 and includes it in the package.
  The legacy `npm run tauri:build:prod:pi` command remains an alias. A universal
  macOS build stages arm64 and x64 archives and packages only the matching
  runtime in each app. Release CI prepares the runtime for each target before
  generating its Tauri resource configuration.

## Vendored Pi packages

The staging script installs a pinned list of Pi packages
(`npm:pi-subagents@0.79.2`, the sub-agent capability) into every staged
resource as `pi/<target>/pi-agent`, so the packaged app ships them without a
runtime `pi install` (which would require npm and network access on the user's
machine). Set `FLOWIX_PI_SKIP_PACKAGES=1` to stage without vendored packages.

On the first RPC launch of each process, Flowix seeds the vendored tree into
the user's Pi agent directory (`agent_external/pi/package_seed.rs`): files are
copied (never overwriting user-owned files such as `auth.json`, `mcp.json`, or
`sessions`), and the vendored `packages` declarations are merged into
`settings.json` without touching other user settings. A digest marker at
`packages-seed.json` makes repeat launches a no-op until the bundled tree
changes. Seeding is best-effort: failures are logged to the runtime log and
never block launching Pi, which stays fully functional without the vendored
packages.

Production packages always include Pi. Their updater endpoint remains the
regular platform endpoint unless `FLOWIX_UPDATER_ENDPOINT_PI_MACOS`,
`FLOWIX_UPDATER_ENDPOINT_PI_WINDOWS`, or `FLOWIX_UPDATER_ENDPOINT_PI_LINUX` is
configured. Set those variables only when release infrastructure publishes a
separate Pi manifest, such as `/updater/pi/{macos,windows,linux}/latest.json`.

## Models and permissions

Flowix explicitly passes each enabled skill directory from the working
directory's `.agents/skills` collection to Pi with `--skill`. This makes
notebook skills available in RPC mode even without a saved Pi project-trust
decision. Legacy or duplicate skill names receive a stable, valid command
name at runtime; Flowix stages a Pi-compatible copy in the conversation's
session directory and leaves the notebook file untouched. Saving that skill
from the settings editor writes the canonical name into its frontmatter.
This explicit skill loading does not grant trust to other project-local Pi
settings, extensions, or MCP configuration.
Pi discovers skills at process startup and advertises their descriptions to
the model; `/skill:name` explicitly loads a skill. Flowix fingerprints enabled
notebook skills, Pi's user-level `skills/` directory, the Pi user MCP file,
and the current directory's `.pi/mcp.json` when opening a conversation.
Hashing `.pi/mcp.json` does not load it or grant project trust. A changed
fingerprint takes effect when the next prompt starts and replaces the existing
RPC process; history reads keep using the current process.
Notebook `.agents/mcp.json` is not a Pi MCP source; Pi's user MCP settings are
managed in the Pi Preferences page.

The model picker reads Pi's `get_available_models` RPC response and stores the
selected provider ID and model ID together. The reasoning selector uses Pi's
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` levels. Pi RPC
does not provide sandbox approval modes; it lets the host select built-in tools
with `--tools`. Flowix exposes three permission choices in the conversation
input. These choices limit which tools Pi can invoke; they do not provide
operating-system-level filesystem isolation or per-path write restrictions.

## Tool selection and the local execution environment

The permission mode sets the maximum tool set; the machine decides what is
actually usable. Flowix intersects the two before every run instead of passing
a fixed list:

- `read` and `ls` are always enabled. `ls` has no external dependency, so a
  read-only conversation can still list directories.
- `grep` and `find` are enabled only when `rg` / `fd` resolve on the session
  PATH or in the Pi `bin` directory. Pi's implementations have no JavaScript
  fallback: when the binary is missing they download from GitHub and fail the
  call, which is not acceptable in an offline or restricted network.
- `read-only` stops there. `workspace-write` adds `edit` and `write`.
  `danger-full-access` adds `edit`, `write`, and the platform shell tool.
- The shell tool is `bash` on platforms where Pi can resolve one and
  `powershell` on native Windows without Git Bash. Pi resolves `bash` from
  `shellPath`, Git Bash under Program Files, then `bash.exe` on `PATH`; its
  `powershell` tool needs no installation.

Pi runs as an RPC subprocess and every shell command inherits that process
environment, so Flowix injects the PATH itself: on macOS and Linux the PATH is
read once from the user's login shell (`$SHELL -ilc`, 1.2 s timeout, cached for
the process lifetime) and merged ahead of the inherited PATH. Without this a
`.app` launched from Finder only sees the launchd PATH and cannot find
Homebrew, nvm, or uv binaries. Windows GUI processes already inherit the full
user environment, so no login-shell lookup is performed there.

The `shellPath` value in Pi's `settings.json` takes precedence over
auto-detection. Flowix reads it when computing the tool list but does not write
it.

History is read from Pi's native session through the `get_messages` RPC after
opening the conversation's session directory with `--continue`. A dedicated
Pi history adapter maps native user, assistant, reasoning, tool, bash, custom,
and compaction messages into Flowix rows and pages the full RPC transcript by
conversation turns. Pi's session remains the history source of truth; Flowix's
external-event journal is not used to reconstruct Pi conversations.
History RPC responses are routed by request ID, so snapshots can be read while
a prompt is streaming. Flowix checks the native append cursor and active leaf
around the message read; an unfinished tail without a native entry ID remains
owned by the live stream projection. Pi does not persist a partial assistant
message, so a refresh restores committed history and the submitted user message
but cannot restore assistant text streamed before the refresh. If a new turn is
still starting its Pi process, history reads wait for that active run to bind
its session before reading, so reopening the conversation does not mistake
session startup for an empty history.

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
