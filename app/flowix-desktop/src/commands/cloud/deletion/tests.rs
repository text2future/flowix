use super::*;
use flowix_core::memo_file::NotebookConfig;
use flowix_core::MemoService;
use flowix_sync::{V2EntityType, V2NoteState, V2OperationKind};
use std::path::PathBuf;

fn fixture() -> (tempfile::TempDir, MemoFile, SyncManager, String, PathBuf, String) {
    let directory = tempfile::tempdir().unwrap();
    let notebook_path = directory.path().join("notes");
    std::fs::create_dir_all(&notebook_path).unwrap();
    let store = MemoFile::new(directory.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "work".into(),
            name: "Work".into(),
            icon: None,
            path: notebook_path.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 1,
            updated_at: 1,
        }])
        .unwrap();
    let created = MemoService::new(&store)
        .create_memo_named_with_tag_in_directory(Some("work"), None, "Untitled", "# Note\noriginal\n", None)
        .unwrap();
    let sync = SyncManager::new(
        "https://cloud.example.test",
        directory.path().join("sync.db"),
    )
    .unwrap();
    let content = std::fs::read(&created.path).unwrap();
    sync.store()
        .save_v2_note_state(&V2NoteState {
            note_id: created.memo.id.clone(),
            notebook_id: "work".into(),
            revision: "revision-1".into(),
            content_hash: Some(v2_content_hash(&content)),
            filename: created.memo.filename.clone(),
            deleted: false,
            last_seq: 1,
            attachments: Vec::new(),
        })
        .unwrap();
    (directory, store, sync, created.memo.id, created.path, created.memo.relative_path)
}

#[test]
fn remote_delete_preserves_edits_before_watcher_marks_dirty() {
    let (_directory, store, sync, id, path, relative) = fixture();
    let original = std::fs::read_to_string(&path).unwrap();
    let edited = format!("{original}\nunsynced work\n");
    store.write_file(&path, edited.as_bytes()).unwrap();
    assert!(!sync.has_pending_v2_note_change(&id).unwrap());
    let baseline = sync.v2_note_state(&id).unwrap();
    let cursor = sync.store().v2_cursor().unwrap();
    let _guard = store.acquire_cross_process_write_lock().unwrap();
    let error = delete_cloud_note_locked(&store, &sync, "work", &id, relative.as_str(), |_| {
        panic!("must not acknowledge a rejected deletion")
    })
    .unwrap_err();
    assert!(error.starts_with("CLOUD_DELETE_CONFLICT:"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
    assert!(store.find_memo_by_relative_path_for_notebook_id("work", &relative).is_some());
    assert_eq!(sync.v2_note_state(&id).unwrap(), baseline);
    assert_eq!(sync.store().v2_cursor().unwrap(), cursor);
}

#[test]
fn remote_delete_preserves_pending_changes_even_when_body_hash_matches() {
    let (_directory, store, sync, id, path, relative) = fixture();
    let original = std::fs::read(&path).unwrap();
    sync.store()
        .mark_v2_dirty(
            V2EntityType::Note,
            &id,
            Some("work"),
            V2OperationKind::Put,
            "changed-attachment",
            2,
        )
        .unwrap();
    let dirty_before = sync.store().v2_dirty_entities().unwrap();
    let _guard = store.acquire_cross_process_write_lock().unwrap();
    assert!(delete_cloud_note_locked(&store, &sync, "work", &id, relative.as_str(), |_| {})
        .unwrap_err()
        .starts_with("CLOUD_DELETE_CONFLICT:"));
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(store.find_memo_by_relative_path_for_notebook_id("work", &relative).is_some());
    let dirty_after = sync.store().v2_dirty_entities().unwrap();
    assert_eq!(dirty_after.len(), dirty_before.len());
    assert_eq!(dirty_after[0].generation, dirty_before[0].generation);
}

#[test]
fn remote_delete_removes_unchanged_file_and_index_entry() {
    let (_directory, store, sync, id, path, relative) = fixture();
    let mut acknowledged = false;
    let _guard = store.acquire_cross_process_write_lock().unwrap();
    let removed = delete_cloud_note_locked(&store, &sync, "work", &id, relative.as_str(), |actual_path| {
        assert_eq!(actual_path, path.as_path());
        acknowledged = true;
    })
    .unwrap();
    assert!(acknowledged);
    assert_eq!(removed.unwrap().id, id);
    assert!(!path.exists());
    assert!(store.find_memo_by_relative_path_for_notebook_id("work", &relative).is_none());
    assert!(delete_cloud_note_locked(&store, &sync, "work", &id, relative.as_str(), |_| {})
        .unwrap()
        .is_none());
}

#[test]
fn remote_delete_preserves_external_save_during_delete() {
    let (_directory, store, sync, id, path, relative) = fixture();
    let _guard = store.acquire_cross_process_write_lock().unwrap();
    let error = delete_cloud_note_locked(&store, &sync, "work", &id, relative.as_str(), |actual_path| {
        flowix_core::memo_file::atomic_write_bytes(actual_path, b"external save").unwrap();
    }).unwrap_err();
    assert!(error.starts_with("CLOUD_DELETE_CONFLICT:"));
    assert_eq!(std::fs::read(&path).unwrap(), b"external save");
    assert!(store.find_memo_by_relative_path_for_notebook_id("work", &relative).is_some());
}

#[test]
fn remote_delete_does_not_treat_read_failure_as_a_missing_file() {
    let (_directory, store, sync, id, path, relative) = fixture();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    let _guard = store.acquire_cross_process_write_lock().unwrap();
    assert!(delete_cloud_note_locked(&store, &sync, "work", &id, relative.as_str(), |_| {})
        .unwrap_err()
        .starts_with("CLOUD_DELETE_READ_FAILED:"));
    assert!(path.is_dir());
    assert!(store.find_memo_by_relative_path_for_notebook_id("work", &relative).is_some());
}

#[test]
fn remote_delete_ignores_a_note_path_missing_in_the_target_notebook() {
    let (_directory, store, sync, id, path, relative) = fixture();
    let _guard = store.acquire_cross_process_write_lock().unwrap();
    // Path-based lookup: the same relative path simply does not exist in the
    // other notebook, so the deletion is a no-op there.
    assert!(
        delete_cloud_note_locked(&store, &sync, "other", &id, relative.as_str(), |_| {})
            .unwrap()
            .is_none()
    );
    assert!(path.exists());
    assert!(store.find_memo_by_relative_path_for_notebook_id("work", &relative).is_some());
}

#[test]
fn remote_delete_preserves_a_local_file_without_an_acknowledged_hash() {
    let (_directory, store, sync, id, path, relative) = fixture();
    let mut baseline = sync.v2_note_state(&id).unwrap().unwrap();
    baseline.content_hash = None;
    sync.store().save_v2_note_state(&baseline).unwrap();
    let original = std::fs::read(&path).unwrap();
    let _guard = store.acquire_cross_process_write_lock().unwrap();
    assert!(delete_cloud_note_locked(&store, &sync, "work", &id, relative.as_str(), |_| {})
        .unwrap_err()
        .starts_with("CLOUD_DELETE_CONFLICT:"));
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(store.find_memo_by_relative_path_for_notebook_id("work", &relative).is_some());
}

#[test]
fn remote_delete_cleans_an_already_missing_file_from_the_index() {
    let (_directory, store, sync, id, path, relative) = fixture();
    store.delete_file(&path).unwrap();
    let _guard = store.acquire_cross_process_write_lock().unwrap();
    assert!(delete_cloud_note_locked(&store, &sync, "work", &id, relative.as_str(), |_| {})
        .unwrap()
        .is_some());
    assert!(store.find_memo_by_relative_path_for_notebook_id("work", &relative).is_none());
}
