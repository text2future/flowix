# Note reference paths

Wiki note cards persist as `[[destination#heading]]` only for notes inside the
source notebook. Other targets use ordinary `[label](destination)` links.

## Path rules

- References within the source document's owning notebook use paths relative to
  the source document's directory, beginning with `./` or `../`.
- Cross-notebook targets, absolute Wiki inputs, URLs, folders and non-note files
  become Markdown links. Cross-notebook destinations use absolute paths; Windows
  drive paths use `/` separators and UNC targets use `file://server/share/...`.
- A leading `/` is a filesystem absolute path. Notebook-root references use an
  explicit relative path, rather than the historical leading-slash shorthand.
- Unicode and spaces stay readable. Literal `%`, `#`, `?`, `[`, `]` and `|` in
  filenames stay percent-encoded, distinct from anchors and aliases.
- Existing Flowix deep links, `<note>` tags and bare wiki names remain readable.
  Unknown notebook locators are preserved until they can be resolved. Bare Wiki
  names resolve to the same-directory `.md` note, rather than searching other
  folders for matching titles. Both `folder/note.md` and `./folder/note.md` use
  the source document directory as their base.
- Markdown destinations without a scheme are local paths regardless of file
  extension. Use `https://` or `http://` for web pages; they open in the system
  browser. A bare extensionless destination such as `[目录](资料)` first probes
  `资料.md` at the owning notebook root, then falls back to the authored path.
- Directory checks use filesystem metadata, including folders named `folder.md`.

## Responsibilities

- `lib/wiki-reference.ts` parses wiki syntax and finds complete source spans.
  Move rewriting excludes code, HTML, Markdown link and frontmatter ranges;
  emphasis within a wiki path does not split the reference.
- `lib/document-relative-path.ts` owns filesystem URL decoding and cross-platform
  path arithmetic. `lib/document-resource-context.ts` chooses relative versus
  absolute persistence from source and target ownership.
- `features/editor/extensions/note-link/note-reference-path.ts` adapts old
  locators, resolves targets and normalizes a serialization snapshot. Its name
  lookup dependency is supplied by the caller.
- Editor and composer hosts capture resource state once per serialization.
  Snapshot serialization leaves the live ProseMirror document unchanged. The
  document editor separately converts general references into link marks, using
  asynchronous filesystem metadata to detect directories.
- Native HTML transfers carry an absolute `data-note-path` and a separate
  heading. Pasting into another document reuses that target and formats the next
  save relative to the destination document's context, or as an absolute Markdown
  link when crossing notebook boundaries.
- Backend relation indexing and preview derivation recognize wiki references.
  The projection parser version advances when preview derivation changes, so
  existing cached previews rebuild without modifying source Markdown.
  TypeScript and Rust both consume `test-fixtures/note-reference-paths.json` to
  check agreement on Windows drives, UNC paths and encoded filename characters.

Changes to these rules should cover save/reopen, copy between documents, source
and target moves, legacy inputs, and backend indexing/preview behavior together.

## Navigation and notebook switching

Wiki and Markdown clicks in the document editor use the host's local-link
callback. `prepareLocalLinkNavigation` resolves both source and destination
through filesystem metadata before comparing their notebook ownership. This
includes symlinks and canonical path aliases. A cross-notebook confirmation is
shown by one application-level host; cancellation leaves the active document
unchanged. New confirmation requests cancel older requests rather than sharing
one approval across several clicks.

A Wiki destination without an extension implies `.md`, including `./note` and
`folder/note`. The same lexical resolver is used for saving and move rewrites.
If the implied note is absent and the literal destination is a directory, its
Markdown replacement uses an explicit relative path such as `./folder/`. It
cannot accidentally invoke the root-note priority of `[folder](folder)`.

File opens, folder opens and notebook-selector actions share notebook selection
and compensation through `createNotebookNavigationScope`. History replays use
the same Surface opening transactions with history insertion disabled. The
primary column updates the selected notebook and reloads its note list; its
sidebar tree observes the new notebook root and rejects stale directory reads.
This also applies after swapping the two columns. The secondary column retains
its independent notebook context.
