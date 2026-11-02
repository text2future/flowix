use super::*;
use std::fs;

fn fixture() -> (tempfile::TempDir, MemoFile, NotebookWatchContext) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notes");
    fs::create_dir_all(&root).unwrap();
    let mut memo_file = MemoFile::new(temp.path().join("config"));
    memo_file.write_notebook_configs(&[flowix_core::memo_file::NotebookConfig {
        id: "nb_test".into(),
        name: "Test".into(),
        icon: None,
        path: format!("{}/", root.display()),
        is_default: true,
        sort: 0,
        created_at: 0,
        updated_at: 0,
    }]).unwrap();
    memo_file.set_current_notebook(Some("nb_test".into()));
    memo_file.reconcile_note_index("nb_test").unwrap();
    let ctx = NotebookWatchContext { notebook_id: "nb_test".into(), root };
    (temp, memo_file, ctx)
}

fn assert_path_indexed(outcome: DispatchOutcome, relative_path: &str) {
    match outcome {
        DispatchOutcome::PathIndexed { relative_path: actual, .. } => assert_eq!(actual, relative_path),
    }
}

fn change_kind(outcome: DispatchOutcome) -> PathChangeKind {
    match outcome {
        DispatchOutcome::PathIndexed { change, .. } => change,
    }
}

#[test]
fn atomic_replacement_reported_as_create_is_an_update() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("Note.md");
    fs::write(&path, "original").unwrap();
    assert_eq!(change_kind(dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap()), PathChangeKind::Created);
    for kind in [FsEventKind::Create, FsEventKind::Modify, FsEventKind::Create] {
        flowix_core::memo_file::atomic_write_bytes(&path, b"saved draft").unwrap();
        assert_eq!(change_kind(dispatch_modify_event(&memo_file, &ctx, &path, kind).unwrap()), PathChangeKind::Updated);
    }
}

#[test]
fn new_path_is_created_even_when_modify_arrives_before_create() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("New.md");
    fs::write(&path, "new note").unwrap();
    assert_eq!(change_kind(dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Modify).unwrap()), PathChangeKind::Created);
    assert_eq!(change_kind(dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap()), PathChangeKind::Updated);
}

#[test]
fn delayed_remove_after_replacement_does_not_delete_or_create() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("Note.md");
    fs::write(&path, "original").unwrap();
    memo_file.refresh_note_path(&ctx.notebook_id, "Note.md").unwrap();
    fs::remove_file(&path).unwrap();
    fs::write(&path, "replacement").unwrap();
    assert_eq!(change_kind(dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Remove).unwrap()), PathChangeKind::Updated);
    fs::remove_file(&path).unwrap();
    assert_eq!(change_kind(dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Remove).unwrap()), PathChangeKind::Deleted);
    fs::write(&path, "a genuinely recreated note").unwrap();
    assert_eq!(change_kind(dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap()), PathChangeKind::Created);
}

#[test]
fn cold_projection_does_not_claim_existing_file_is_new() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("Existing.md");
    fs::write(&path, "existing file").unwrap();
    let connection = rusqlite::Connection::open(memo_file.notebook_db_path(&ctx.notebook_id).unwrap()).unwrap();
    connection.execute("DELETE FROM note_index_meta WHERE key='build_state'", []).unwrap();
    assert_eq!(memo_file.indexed_note_path_presence(&ctx.notebook_id, "Existing.md").unwrap(), None);
    assert_eq!(change_kind(dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap()), PathChangeKind::Updated);
}

#[test]
fn watcher_baseline_detects_new_path_after_index_was_refreshed_early() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("New.md");
    fs::write(&path, "new note").unwrap();

    // A background reader may populate the projection before notify's event
    // reaches the processor. The watcher's captured absent baseline wins.
    memo_file.refresh_note_path(&ctx.notebook_id, "New.md").unwrap();
    assert_eq!(
        change_kind(refresh_path(&memo_file, &ctx, &path, Some(false)).unwrap()),
        PathChangeKind::Created,
    );
}

#[test]
fn external_markdown_is_indexed_without_a_memo_id() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("docs/guide/Reference.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = "# Reference\n\nExternal body\n";
    fs::write(&path, original).unwrap();

    let outcome = dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap();
    assert_path_indexed(outcome, "docs/guide/Reference.md");
    let entry = memo_file.read_note_entry_by_path("nb_test", "docs/guide/Reference.md")
        .unwrap().expect("path entry");
    assert_eq!(entry.title, "Reference");
    // The derived preview currently mirrors the first visible body line, so the
    // exact text depends on a pending product decision (whether the card shows
    // a second line or repeats the title). Assert only that it was derived from
    // the body of an externally created file.
    assert!(!entry.preview.is_empty());
    assert!(memo_file.read_all_memos().is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn external_edit_refreshes_the_same_path_entry() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("Note.md");
    fs::write(&path, "# Draft\n\nBefore\n").unwrap();
    assert_path_indexed(
        dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap(),
        "Note.md",
    );

    // Change the first visible line so the refresh is observable without
    // depending on which body line the preview is taken from.
    fs::write(&path, "# Note\n\nAfter\n").unwrap();
    assert_path_indexed(
        dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Modify).unwrap(),
        "Note.md",
    );
    let entry = memo_file.read_note_entry_by_path("nb_test", "Note.md")
        .unwrap().expect("updated path entry");
    assert_eq!(entry.title, "Note");
    assert!(memo_file.read_all_memos().is_empty());
}

#[test]
fn removed_markdown_drops_only_its_path_entry() {
    let (_temp, memo_file, ctx) = fixture();
    let removed = ctx.root.join("Removed.md");
    let kept = ctx.root.join("Kept.md");
    fs::write(&removed, "# Removed\n").unwrap();
    fs::write(&kept, "# Kept\n").unwrap();
    dispatch_modify_event(&memo_file, &ctx, &removed, FsEventKind::Create).unwrap();
    dispatch_modify_event(&memo_file, &ctx, &kept, FsEventKind::Create).unwrap();

    fs::remove_file(&removed).unwrap();
    assert_path_indexed(
        dispatch_modify_event(&memo_file, &ctx, &removed, FsEventKind::Remove).unwrap(),
        "Removed.md",
    );
    assert!(memo_file.read_note_entry_by_path("nb_test", "Removed.md").unwrap().is_none());
    assert!(memo_file.read_note_entry_by_path("nb_test", "Kept.md").unwrap().is_some());
    assert!(memo_file.read_all_memos().is_empty());
}

#[test]
fn external_copy_keeps_authored_yaml_without_using_it_as_identity() {
    let (_temp, memo_file, ctx) = fixture();
    let path = ctx.root.join("Copied.md");
    let original = "---\nflowix_key: abc12345\n---\n# Copied\n";
    fs::write(&path, original).unwrap();
    assert_path_indexed(
        dispatch_modify_event(&memo_file, &ctx, &path, FsEventKind::Create).unwrap(),
        "Copied.md",
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(memo_file.read_all_memos().is_empty());
    assert!(memo_file.read_note_entry_by_path("nb_test", "Copied.md").unwrap().is_some());
}
