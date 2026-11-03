# Agent data ownership

Device-local notebook registration and repository mounts are stored in `~/.flowix/db/local.db`.

- `notebooks` owns notebook identity, display metadata, local root paths and order.
- `notebook_add_dirs` owns notebook-scoped repository mounts. The same directory may be mounted by multiple notebooks. A notebook deletion cascades to its mounts.
- `notebook_workspace_state` records migration completion and mount revisions.
- `app_state` stores selected notebook state.

The frontend Agent Store projects workspace data from IPC into memory. Its `workspace.resources` is derived from notebook mounts. Workspace data is neither persisted in localStorage nor merged from old browser caches. Agent model/skill catalogs and user preferences retain their existing browser persistence.

Repository selection commits a mount to a specific notebook. There is no independent global folder pool. Removing a mount does not affect another notebook's mount of the same path. Missing mounts remain visible and removable.

Flowix file IPC authorizes registered notebook roots and enabled mounted directories, together with existing explicit document grants. Agent submissions wait for initial workspace hydration; each conversation captures its own workspace snapshot. Backend chat and DSH command dispatch validate snapshot paths against current mounts, using notebook scope when present. Native Agent sandbox settings remain separate from these Flowix checks.

## Upgrade imports

- `index.db` is retired and is no longer opened or imported. After successful version initialization, copies in `~/.flowix/` and `~/.flowix/db/`, including SQLite companions, are moved to each directory's `rebuild-backups/<UUID>/` for manual recovery. Installations with only an old index must re-register their notebook folders.
- `.flowix/agent.json` is deprecated and ignored. Its contents do not create workspace mounts.
- The startup `agent_workspace_v1` job imports legacy `agent-access.json.defaults.files` into SQLite for notebooks registered at migration time. `_global` defaults apply only to those existing notebooks; unavailable notebook roots defer the job, and later notebooks do not inherit those defaults. Orphan global folder entries do not create mounts.
- Successfully imported mount defaults are not reread after workspace settings change. `defaults.runtime` is no longer read or imported. Current Agent preferences remain in the browser-owned user preference Store; Codex session settings and Pi feature mode are independent legacy inputs.

Legacy files are retained on disk for recovery, but normal workspace writes use only `local.db`.

On macOS, `~/.flowix/boot/bookmark.json` is the only bookmark store. Directory selections and successful access to registered notebook directories persist directory bookmarks; single-file selections persist file bookmarks without granting their parent directory. Saved scopes are restored at startup and held for the process lifetime. Stale bookmarks are regenerated from the resolved URL and their stored paths are updated. Denied directory access is not recorded. macOS privacy controls still apply; Flowix cannot observe the system Allow button directly. Old bookmark locations are no longer read or migrated.
