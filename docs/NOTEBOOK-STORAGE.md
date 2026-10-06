# Notebook storage boundaries

This document describes the current storage contract for notebooks. The
Markdown files remain authoritative for note content. SQLite databases and
other files under `.flowix` hold notebook identity, derived projections, or
Flowix-owned metadata.

## On-disk layout

```text
~/.flowix/
  index.db                         Device-local notebook registry

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
| `~/.flowix/index.db` | Device | Notebook registry and legacy source rows for import | Preserve; it is not a notebook cache |
| `<notebook>/.flowix/notebook.db` | Notebook | Path-keyed note and full-text projections, the multidimensional-table listing catalog, legacy memo-ID compatibility records, media identities and properties | Rebuild note, search, and table-listing projections selectively; preserve user-owned media properties and compatibility data |

The notebook database deliberately remains one file. Its tables have different
lifecycles, so maintenance code must target the relevant tables and must not
delete the whole database to rebuild the note projection.

Media bytes remain in notebook files. The `media_resources` table stores a
notebook-relative path, resource identity, file fingerprint, and user
properties. Those properties cannot be reconstructed from the media file.

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
- **Memo ID** is an opaque compatibility identity. It is not the identity of a
  path-based Note and must not be generated for new Note writes.
- **Media resource** is a separate image or video identity with notebook-owned
  properties. Its ID is independent from both Note paths and Memo IDs.
- **File entry** is any filesystem file or directory shown by the browser; it
  has a path but does not automatically need a database identity.
- Use `registry_db_path()` and `notebook_db_path(id)` when opening a database.
- `MemoFile` remains a compatibility storage façade. `NotebookRegistry` owns
  the device-local registry path, connection setup and config cache; Note,
  media, revision and Memo-ID implementations live in their own modules.
- Note projection tables use `note_*` names. Existing `v2_*` projection tables
  are discarded transactionally on first open. The current projection is kept
  when both sets exist; when only V2 exists, Markdown files rebuild the new
  projection. Schema versioning owns later database evolution.
- Keep generic file-tree enumeration on the filesystem. Do not add database
  rows for ordinary files unless a feature needs durable metadata for them.

### Memo ID compatibility boundary

Memo ID is still a real compatibility identity in several persisted and public
surfaces. Keep those uses explicit; do not treat every remaining `Memo` string
as a naming cleanup that can be mechanically replaced.

| Surface | Current Memo-ID dependency | Direction |
| --- | --- | --- |
| Notebook database | `memos.id` and `memo_lifecycles.memo_id` retain old identity and lifecycle state. `memo_tags`, `memo_colors`, `memo_todos`, and `memo_agents` attach persisted associations to that identity. | Preserve until each association has a path-keyed migration and a rollback/read-compatibility policy. These rows are not part of the rebuildable Note projection. |
| Revisions | Legacy memo versions and content-revision records are addressed by Memo ID; existing version archives may be stored under that ID. | Keep old-version reads and writes behind compatibility operations. Path-based Note revision history is separate and should not need an ID. |
| IPC and links | Existing `get_memos`-style commands, Memo-shaped payloads, ID lookup, plugin artifact references, and older deep links can carry a Memo ID. | Keep command strings and ID resolvers as adapters while callers migrate. New Note operations should pass `(notebookId, relativePath)`. |
| Web state | `notes` is the path-keyed source for the main Note list. Legacy Memo IPC events still carry IDs, but the Web store now treats them as invalidation signals instead of retaining a Memo-ID list cache. | Keep ID-shaped event payloads in the IPC adapter. New view state should use Note paths. |
| CLI and integrations | Older CLI/MCP requests and external callers can address notes by Memo ID. | Preserve the old address form as an adapter; new address forms use notebook ID plus relative path. |

Path-based Note list, search, create, edit, move, delete, and Note-version
operations should use Note types and APIs. Keep compatibility adapters at the
service/IPC boundary; do not copy Memo IDs into Markdown or make them a second
Note key. Migrating any persisted association requires its own data migration
and compatibility plan.

The Rust path API exposes `NoteEntry`, `NoteDocument`, `NotePage`, and
`NoteService`; `MemoService` handles the remaining Memo-ID use cases. The old
`v2_*` SQLite projection tables are discarded on first use.
On the Web side, path-identified operations use the `notes` Tauri client,
`noteRepository`, and `useNoteStore` / `NoteLibraryStore`. The `memos` Tauri
client retains commands that still operate on Memo IDs. Existing Tauri command
strings stay stable while Rust and Web callers migrate.

The Web store's Note list is keyed by `(notebookId, relativePath)`. Legacy Memo
events invalidate that list; the Web store no longer retains a parallel list
keyed by Memo ID. Remaining Memo-ID consumers are confined to compatibility
commands and integration surfaces that still explicitly request Memo data.

The persisted filenames `index.db` and `notebook.db` are retained for backward
compatibility. Their meanings are made explicit by the APIs above; changing
those filenames requires a separate, downgrade-aware migration.

## Index update model

- Note writes and Markdown watcher events refresh one path. Startup and
  directory-level recovery reconcile the notebook tree against the note
  projection.
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
- The legacy memo-ID search remains an in-memory projection. Search caches may
  be rebuilt; user properties and media metadata must be preserved.
