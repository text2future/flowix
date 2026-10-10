# Windows installation maintenance

The installer uses Tauri's standard NSIS template. Hooks own PATH registration,
update result reporting and one shared install/uninstall preflight. They never
rename, recursively merge or recursively remove the installation directory.

The native helper requests a normal desktop shutdown, waits for document saving
and child cleanup, closes verified bundled CLI/runtime processes, and checks
program files for remaining locks. An unresponsive desktop or an external lock
blocks installation with an actionable error; external MCP hosts are not killed.
The helper does not provide an atomic upgrade or rollback guarantee.

Windows runtime state belongs in `%LOCALAPPDATA%\FlowixData`; existing Pi sessions
are migrated once during Pi initialization without overwriting destination data.
When both stores exist, each conversation resolves its existing history in place;
only a conversation with competing histories is blocked. Path getters do not migrate.
Existing installation locations and CLI command links remain compatible.
Old rollback folders are never deleted
automatically.

## Implementation and verification

- [x] Add executable lifecycle tests: multiple CLI instances, another installation,
  a non-cooperative desktop, a locked program file and missing first-install files.
- [x] Remove directory transactions and the private template; share preflight
  across install/uninstall and preserve NSIS output directories and error details.
- [x] Centralize state paths, migrate legacy sessions, remove updater-side kills.
- [x] Compile the helper and actual NSIS hooks; run lifecycle and installation
  smoke tests in disposable directories, including paths with spaces.
- [x] Review failures and document any unavailable full desktop/package checks.

The standard template's process-check macro is overridden in the hook with the
path-scoped helper, avoiding the upstream name-only process termination. Verify
this integration when upgrading Tauri. The hook fails compilation if the upstream
macro is absent. It passes the template's executable filename (including spaces)
as required `--main-executable`; the helper resolves it under `--target` and rejects
absolute paths or directory components. Install failure keeps the standard NSIS
partial-install semantics; it does not claim to restore the previous version.

## Operational notes

- Setup and uninstall run NSIS and the bundled native Rust helper only. They do
  not invoke PowerShell, cmd.exe or taskkill. The flowix.cmd shim is written for
  later CLI use, not executed by setup. PowerShell is used by development tests.
- Legacy desktop versions have no maintenance event listener. Save and exit
  those versions manually when prompted. The installer never force-kills a
  desktop holding unsaved documents.
- In-app updates await the document-save handshake and child-process cleanup
  before Tauri's Windows updater exits. Check/download/save preparation can be
  cancelled; cleanup and installation cannot. The installation worker retains
  the update and document guards, and restores Pi admission before unfreezing
  the editor if installation returns or unwinds.
- Preflight is a point-in-time check; an MCP host that repeatedly restarts the
  CLI may still need to be paused. Standard NSIS file replacement handles a
  later lock; this implementation does not promise an atomic update.

## Validation (2026-10-10)

- Native helper: 8 real Windows lifecycle tests passed, including `Flowix Dev.exe`
  and missing/out-of-scope executable arguments; 2 ignored functions are
  child-process fixtures explicitly invoked by those tests.
- Runtime migration: 5 tests passed, covering nested sessions, coexisting stores,
  legacy naming and conversation conflicts without overwriting data.
- Document shutdown: 3 state transition tests passed; acknowledgement and window
  destruction share the same completion transition.
- Update phase: 3 tests passed for cancellation at handoff, duplicate update
  rejection and the non-cancellable installation phase. Worker guard ordering
  and Pi recovery were source-reviewed; no real signed update was installed.
- The actual tauri-bundler 2.9.2 template compiled and passed disposable NSIS
  install/upgrade/uninstall tests, including an open working directory, normal
  shutdown of `Flowix Dev.exe`, active CLI, locked DLL, preserved data and logs.
  Windows CI is configured to repeat this test against checksum-verified upstream
  sources and NSIS tools; the hosted workflow has not been run from this checkout.
  The fixture rejects a changed Tauri CLI lockfile version until its bundler pin
  and integration checks are reviewed together.
- Desktop cargo check passed with a temporary TAURI_CONFIG override setting
  bundle.externalBin to an empty array. The source checkout has no built CLI
  sidecar; this validates Rust types, not a complete signed release package.
- Independent review covered shutdown, cancellation and standard-template
  integration. The queued preparation guard fixes cancellation between sending
  and receiving document-save completion.

Run cargo test --manifest-path app/Cargo.toml -p flowix-installer-helper on Windows.
Then run scripts/test-windows-installer.ps1 with -Helper pointing to the compiled
helper and -ProcessFixture pointing to app/target/debug/deps/lifecycle-*.exe.
First run `npm ci --prefix scripts/installer-fixture --ignore-scripts` to install
the isolated template renderer. The suite downloads checksum-pinned Tauri bundler
2.9.2, NSIS 3.11 and nsis-tauri-utils 0.5.3 into a temporary tool cache. It requires
Node, PowerShell and tar. It uses GUID-specific registry keys and temporary files,
disables shortcuts and the user PATH hook, and redirects legacy updater markers.
It does not install or stop a real Flowix application.
