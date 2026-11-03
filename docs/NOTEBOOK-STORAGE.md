# Notebook storage boundaries

This document describes the current storage contract for notebooks. The
Markdown files remain authoritative for note content. SQLite databases and
other files under `.flowix` hold notebook identity, derived projections, or
Flowix-owned metadata.

## On-disk layout

```text
~/.flowix/
  db/local.db                      Device-local notebook registry

<notebook>/
  *.md                             Note content; source of truth
  attachments/                     Attachment folder, excluded from catalog scans by default
  .flowix/
    notebook.json                 Portable notebook identity manifest
    notebook.db                    Notebook-local catalog and metadata
    view-preferences.json          Notebook file-management preferences
    versions/                      Note version history
    note-index-refresh-pending.d/  Recovery markers after failed note projection refreshes
    plugin/                        Plugin-owned output
```

New Flowix-owned notebook data is written under `.flowix/`. A one-time
migration still moves plugin output from `.plugin-output/` into that directory.

## Database ownership

| Store | Ownership | Contents | Rebuild policy |
| --- | --- | --- | --- |
| `~/.flowix/db/local.db` | Device | Notebook registry and workspace mounts | Preserve; it is not a notebook cache |
| `<notebook>/.flowix/notebook.db` | Notebook | Path-keyed note and full-text projections, the multidimensional-table listing catalog, media identities and properties | Rebuild note, search, and table-listing projections selectively; preserve user-owned media properties |

The notebook database deliberately remains one file. Its tables have different
lifecycles, so maintenance code must target the relevant tables and must not
delete the whole database to rebuild the note projection.

Media bytes remain in notebook files. The `media_resources` table stores a
notebook-relative path, resource identity, file fingerprint, and user
properties. Those properties cannot be reconstructed from the media file.

## Catalog lifecycle

The multidimensional-table listing is a rebuildable file catalog. Its
view-group membership preference is stored separately by stable `table_id`,
so a catalog refresh or file rename does not reset the user's choice.
`missing_since` records when a startup scan first found a resource absent;
its metadata remains readable for recovery. `deleted_at` records an explicit
watcher deletion and hides the resource from normal reads. These fields have
different visibility semantics and should remain separate.

## Naming and API rules

- **Note** is a Markdown document identified by `(notebook_id, relative_path)`.
  Moving or renaming it changes that identity. The file remains the content
  source of truth.
- Note identity is `(notebook_id, relative_path)` across storage and APIs.
- **Media resource** is a separate image or video identity with notebook-owned
  properties. Its ID is independent from Note paths.
- Frontmatter properties, including `flowix_key`, are user data. The application
  does not generate, interpret, or use `flowix_key` as a document identity.
- **File entry** is any filesystem file or directory shown by the browser; it
  has a path but does not automatically need a database identity.
- Use `registry_db_path()` and `notebook_db_path(id)` when opening a database.
- `MemoFile` remains the storage façade used by existing core operations;
  document identity is path-based. `NotebookRegistry` owns the device-local
  registry path, connection setup and config cache; Note, media and revision
  implementations live in their own modules.
- Note projection tables use `note_*` names. Existing `v2_*` projection tables
  are discarded transactionally on first open. The current projection is kept
  when both sets exist; when only V2 exists, Markdown files rebuild the new
  projection. Schema versioning owns later database evolution.
- Keep generic file-tree enumeration on the filesystem. Do not add database
  rows for ordinary files unless a feature needs durable metadata for them.

The Rust service boundary exposes path-keyed `NoteService` operations. The
`MemoService` facade and `resolve_memo` service lookup have been removed. The
Web Note list is keyed by `(notebookId, relativePath)`, and path-identified
operations use the `notes` Tauri client. On notebook initialization, legacy
Memo properties are copied into Markdown before the old Memo tables are
dropped; tags, todos, and agents are rebuilt from Markdown into the `notes`
row. The old `v2_*` SQLite projection tables are discarded on first use.

The persisted filename `notebook.db` is retained for backward
compatibility. Its meaning is made explicit by the APIs above; changing
that filename requires a separate, downgrade-aware migration.

## Index update model

- Note writes and Markdown watcher events refresh one path. Startup and
  directory-level recovery reconcile the notebook tree against the note
  projection.
- The `notes.tags`, `notes.todos`, and `notes.agents` columns are the query
  source for tag navigation and note task/agent summaries. Tags are derived
  from Markdown; notebooks do not store standalone empty tags or a separate
  tag catalog.
- The `note_search_fts` FTS5 table caches note titles, tags and body text. A
  path refresh updates it in the same transaction as the note projection.
  Existing notebooks backfill it once on the first path-based search, using
  short per-note write transactions. A failed refresh after saving Markdown
  leaves a recovery marker; the next search verifies the projection and clears
  that marker after a successful scan. Queries
  of one or two characters use `LIKE`, since trigram search needs at least
  three characters. Desktop, CLI, and app Note search share this index. This
  table is derived data; Markdown remains authoritative.
- The notebook watcher refreshes individual image and video paths on create,
  modify, rename and remove when the notebook file-management policy includes
  them. Startup maintenance and directory-level recovery reconcile the media
  catalog under the same policy. Opening or editing a resource also refreshes
  that path.
- The file tree and folder document list read the current directory directly;
  folder document lists do not keep a separate file-entry catalog. The notebook
  watcher writes the media catalog.
- Note storage and queries use notebook-relative paths. Markdown remains the
  source for rebuildable note metadata; the note index has no document ID key.

The global `index.db` is retired. Version initialization no longer copies or imports it. After current stores initialize successfully, both old locations and their SQLite companions are archived under `rebuild-backups/<UUID>/` before initialization is marked complete. Cleanup failures are logged and skipped independently for each location; they do not block initialization or schedule a retry on normal startup. Old-only installations must re-register their notebook folders; Markdown files are unchanged.
