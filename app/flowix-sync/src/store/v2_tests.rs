use super::*;
use crate::models::CloudUser;
use crate::v2::{
    V2CloudAccount, V2EntityType, V2FreezeOperation, V2NotePut, V2NoteState, V2OperationData,
    V2OperationKind, V2PushOperation, V2RemoteApply, PROTOCOL_EPOCH,
};

#[test]
fn v2_state_uses_one_account_cursor_and_same_notebook_id() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    let account = V2CloudAccount {
        user: CloudUser {
            id: "usr_1".into(),
            email: "user@example.com".into(),
            display_name: "User".into(),
            region: "non_mainland".into(),
        },
        protocol_epoch: PROTOCOL_EPOCH,
    };
    store.save_v2_account(&account).unwrap();
    assert_eq!(store.v2_account().unwrap(), Some(account));
    assert_eq!(store.v2_cursor().unwrap(), 0);

    let enabled = store
        .set_v2_notebook("nb_same_local_and_cloud", true)
        .unwrap();
    assert_eq!(enabled.notebook_id, "nb_same_local_and_cloud");
    assert!(enabled.enabled);
    assert!(enabled.bootstrap_required);
    store
        .complete_v2_notebook_bootstrap("nb_same_local_and_cloud")
        .unwrap();
    assert!(!store.v2_notebooks(true).unwrap()[0].bootstrap_required);

    store
        .set_v2_notebook("nb_same_local_and_cloud", false)
        .unwrap();
    let reenabled = store
        .set_v2_notebook("nb_same_local_and_cloud", true)
        .unwrap();
    assert!(reenabled.bootstrap_required);

    store.commit_v2_cursor(12, 100).unwrap();
    assert_eq!(store.v2_cursor().unwrap(), 12);
    assert!(store.commit_v2_cursor(11, 101).is_err());
}

#[test]
fn scoped_notebook_cursors_do_not_advance_each_other() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store.set_v2_notebook("nb_a", true).unwrap();
    store.set_v2_notebook("nb_b", true).unwrap();

    store
        .commit_v2_notebook_sync_report("nb_a", &[], 10, &["nb_a".into()], 100)
        .unwrap();
    assert_eq!(store.v2_notebook_cursor("nb_a").unwrap(), 10);
    assert_eq!(store.v2_notebook_cursor("nb_b").unwrap(), 0);
    assert_eq!(store.v2_cursor().unwrap(), 0);

    store
        .commit_v2_notebook_sync_report("nb_b", &[], 20, &["nb_b".into()], 200)
        .unwrap();
    assert_eq!(store.v2_notebook_cursor("nb_a").unwrap(), 10);
    assert_eq!(store.v2_notebook_cursor("nb_b").unwrap(), 20);

    store.commit_v2_sync_report(&[], 30, &[], 300).unwrap();
    assert_eq!(store.v2_cursor().unwrap(), 30);
    assert_eq!(store.v2_notebook_cursor("nb_a").unwrap(), 30);
    assert_eq!(store.v2_notebook_cursor("nb_b").unwrap(), 30);
}

#[test]
fn v2_dirty_generation_does_not_lose_an_edit_that_arrives_during_upload() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    let (first, first_changed) = store
        .mark_v2_dirty_with_change(
            V2EntityType::Note,
            "abc12345",
            Some("nb_1"),
            V2OperationKind::Put,
            "hash-a",
            10,
        )
        .unwrap();
    assert!(first_changed);
    let (repeated_scan, repeated_changed) = store
        .mark_v2_dirty_with_change(
            V2EntityType::Note,
            "abc12345",
            Some("nb_1"),
            V2OperationKind::Put,
            "hash-a",
            11,
        )
        .unwrap();
    assert!(!repeated_changed);
    assert_eq!(repeated_scan.generation, first.generation);
    let frozen = store
        .freeze_v2_operation(V2FreezeOperation {
            operation_id: "op_generation_1",
            entity_type: V2EntityType::Note,
            entity_id: "abc12345",
            generation: first.generation,
            operation_kind: V2OperationKind::Put,
            base_revision: Some("rev_1"),
            payload_json: r#"{"contentHash":"hash-a"}"#,
        })
        .unwrap();
    assert_eq!(frozen.generation, 1);
    assert_eq!(store.v2_inflight_due(0).unwrap().len(), 1);

    let (second, second_changed) = store
        .mark_v2_dirty_with_change(
            V2EntityType::Note,
            "abc12345",
            Some("nb_1"),
            V2OperationKind::Put,
            "hash-b",
            20,
        )
        .unwrap();
    assert!(second_changed);
    assert_eq!(second.generation, 2);

    let operation = V2PushOperation::NotePut {
        operation_id: frozen.operation_id.clone(),
        base_revision: Some("rev_1".into()),
        note: V2NotePut {
            id: "abc12345".into(),
            notebook_id: "nb_1".into(),
            filename: "abc12345.md".into(),
            file_kind: "markdown".into(),
            content_hash: "hash-a".into(),
            blob_id: "blob_test_123".into(),
            size_bytes: 6,
        },
    };
    let data = V2OperationData {
        entity_type: "note".into(),
        entity_id: "abc12345".into(),
        revision: "rev_2".into(),
        sync_seq: 2,
        deleted: false,
        resolution: "fast_forward".into(),
        base_revision: Some("rev_1".into()),
        replaced_revision: Some("rev_1".into()),
        content_hash: Some("hash-a".into()),
        source_revision: None,
        source_sync_seq: None,
    };

    store
        .acknowledge_v2_operation(
            &frozen.operation_id,
            V2EntityType::Note,
            "abc12345",
            frozen.generation,
            &operation,
            &data,
        )
        .unwrap();
    assert_eq!(
        store.v2_note_state("abc12345").unwrap(),
        Some(V2NoteState {
            note_id: "abc12345".into(),
            notebook_id: "nb_1".into(),
            revision: "rev_2".into(),
            content_hash: Some("hash-a".into()),
            filename: "abc12345.md".into(),
            deleted: false,
            last_seq: 2,
            attachments: Vec::new(),
        })
    );
    let connection = store.open().unwrap();
    let generation = connection
        .query_row(
            "SELECT generation FROM v2_dirty_entities WHERE entity_type = 'note' AND entity_id = 'abc12345'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(generation, 2);
}

#[test]
fn v2_note_state_tracks_server_revision_not_client_time() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    let state = V2NoteState {
        note_id: "abc12345".into(),
        notebook_id: "nb_1".into(),
        revision: "rev_c".into(),
        content_hash: Some("hash".into()),
        filename: "abc12345.md".into(),
        deleted: false,
        last_seq: 12,
        attachments: Vec::new(),
    };
    store.save_v2_note_state(&state).unwrap();
    assert_eq!(store.v2_note_state("abc12345").unwrap(), Some(state));
}

#[test]
fn pending_move_survives_reopen_and_acknowledges_both_heads() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("sync.db");
    let store = SyncStore::new(&database).unwrap();
    let notebook = "nb_1";
    let old = "folder/old.md";
    let new = "folder/new.md";
    let old_id = crate::v2::v2_path_note_id(notebook, old);
    let new_id = crate::v2::v2_path_note_id(notebook, new);
    store
        .save_v2_note_state(&V2NoteState {
            note_id: old_id.clone(),
            notebook_id: notebook.into(),
            revision: "rev_2".into(),
            content_hash: Some("hash-a".into()),
            filename: old.into(),
            deleted: false,
            last_seq: 2,
            attachments: Vec::new(),
        })
        .unwrap();
    assert!(store.enqueue_v2_move(notebook, old, new).unwrap());
    assert!(!store.enqueue_v2_move(notebook, old, new).unwrap());
    drop(store);
    let reopened = SyncStore::new(&database).unwrap();
    let queued = reopened.v2_pending_moves().unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].base_revision, "rev_2");
    let data = V2OperationData {
        entity_type: "note".into(),
        entity_id: new_id.clone(),
        revision: "rev_4".into(),
        sync_seq: 4,
        deleted: false,
        resolution: "fast_forward".into(),
        base_revision: Some("rev_2".into()),
        replaced_revision: None,
        content_hash: Some("hash-a".into()),
        source_revision: Some("rev_3".into()),
        source_sync_seq: Some(3),
    };
    reopened.acknowledge_v2_move(&queued[0], &data).unwrap();
    assert!(reopened.v2_pending_moves().unwrap().is_empty());
    let source = reopened.v2_note_state(&old_id).unwrap().unwrap();
    let target = reopened.v2_note_state(&new_id).unwrap().unwrap();
    assert!(source.deleted);
    assert_eq!(source.revision, "rev_3");
    assert_eq!(target.revision, "rev_4");
    assert_eq!(target.content_hash.as_deref(), Some("hash-a"));
}

#[test]
fn moving_back_reuses_the_prior_path_tombstone() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    let notebook = "nb_1";
    let old = "folder/old.md";
    let current = "folder/current.md";
    let old_id = crate::v2::v2_path_note_id(notebook, old);
    let current_id = crate::v2::v2_path_note_id(notebook, current);
    store
        .save_v2_note_state(&V2NoteState {
            note_id: old_id.clone(),
            notebook_id: notebook.into(),
            revision: "rev_3".into(),
            content_hash: None,
            filename: old.into(),
            deleted: true,
            last_seq: 3,
            attachments: Vec::new(),
        })
        .unwrap();
    store
        .save_v2_note_state(&V2NoteState {
            note_id: current_id.clone(),
            notebook_id: notebook.into(),
            revision: "rev_4".into(),
            content_hash: Some("hash-current".into()),
            filename: current.into(),
            deleted: false,
            last_seq: 4,
            attachments: Vec::new(),
        })
        .unwrap();

    assert!(store.enqueue_v2_move(notebook, current, old).unwrap());
    let queued = store.v2_pending_moves().unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].from_note_id, current_id);
    assert_eq!(queued[0].to_note_id, old_id);
}

#[test]
fn rejected_move_is_removed_only_with_a_required_bootstrap() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    let notebook = "nb_1";
    let from = "old.md";
    let to = "new.md";
    store.set_v2_notebook(notebook, true).unwrap();
    store.complete_v2_notebook_bootstrap(notebook).unwrap();
    store
        .save_v2_note_state(&V2NoteState {
            note_id: crate::v2::v2_path_note_id(notebook, from),
            notebook_id: notebook.into(),
            revision: "rev_2".into(),
            content_hash: Some("base-hash".into()),
            filename: from.into(),
            deleted: false,
            last_seq: 2,
            attachments: Vec::new(),
        })
        .unwrap();
    assert!(store.enqueue_v2_move(notebook, from, to).unwrap());
    let movement = store.v2_pending_moves().unwrap().remove(0);

    store.discard_v2_move_after_conflict(&movement).unwrap();

    assert!(store.v2_pending_moves().unwrap().is_empty());
    assert!(store.v2_notebooks(true).unwrap()[0].bootstrap_required);
}

#[test]
fn v2_report_commits_heads_bootstrap_and_cursor_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store.set_v2_notebook("nb_1", true).unwrap();
    let remote = vec![
        V2RemoteApply::Notebook {
            notebook_id: "nb_1".into(),
            name: Some("Notes".into()),
            icon: None,
            sort_order: Some(0),
            revision: "rev_1".into(),
            sync_seq: 1,
            deleted: false,
        },
        V2RemoteApply::Note {
            note_id: "abc12345".into(),
            notebook_id: "nb_1".into(),
            filename: "abc12345.md".into(),
            content_hash: Some("hash".into()),
            content: Some(b"memo".to_vec()),
            revision: "rev_2".into(),
            sync_seq: 2,
            deleted: false,
            attachments: Vec::new(),
        },
    ];
    store
        .commit_v2_sync_report(&remote, 2, &["nb_1".into()], 100)
        .unwrap();
    assert_eq!(store.v2_cursor().unwrap(), 2);
    assert_eq!(
        store.v2_note_state("abc12345").unwrap().unwrap().revision,
        "rev_2"
    );
    assert_eq!(
        store.v2_notebook_state("nb_1").unwrap().unwrap().revision,
        "rev_1"
    );
    assert!(!store.v2_notebooks(true).unwrap()[0].bootstrap_required);
}

#[test]
fn bootstrap_pages_keep_cursor_and_requirement_until_final_page() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store.set_v2_notebook("nb_1", true).unwrap();
    let first = V2RemoteApply::Note {
        note_id: "first".into(),
        notebook_id: "nb_1".into(),
        filename: "first.md".into(),
        content_hash: Some("hash-first".into()),
        content: Some(b"first".to_vec()),
        revision: "rev_1".into(),
        sync_seq: 1,
        deleted: false,
        attachments: Vec::new(),
    };
    store.commit_v2_sync_report(&[first], 0, &[], 100).unwrap();
    assert_eq!(store.v2_cursor().unwrap(), 0);
    assert!(store.v2_notebooks(true).unwrap()[0].bootstrap_required);
    assert!(store.v2_note_state("first").unwrap().is_some());

    let second = V2RemoteApply::Note {
        note_id: "second".into(),
        notebook_id: "nb_1".into(),
        filename: "second.md".into(),
        content_hash: Some("hash-second".into()),
        content: Some(b"second".to_vec()),
        revision: "rev_2".into(),
        sync_seq: 2,
        deleted: false,
        attachments: Vec::new(),
    };
    store
        .commit_v2_sync_report(&[second], 2, &["nb_1".into()], 101)
        .unwrap();
    assert_eq!(store.v2_cursor().unwrap(), 2);
    assert!(!store.v2_notebooks(true).unwrap()[0].bootstrap_required);
    assert!(store.v2_note_state("second").unwrap().is_some());
}

#[test]
fn switching_users_clears_user_scoped_sync_state() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    let account = |id: &str| V2CloudAccount {
        user: CloudUser {
            id: id.into(),
            email: format!("{id}@example.com"),
            display_name: id.into(),
            region: "non_mainland".into(),
        },
        protocol_epoch: PROTOCOL_EPOCH,
    };
    store.save_v2_account(&account("usr_a")).unwrap();
    store.set_v2_notebook("nb_a", true).unwrap();
    store.commit_v2_cursor(9, 100).unwrap();
    store.save_v2_account(&account("usr_b")).unwrap();

    assert_eq!(store.v2_cursor().unwrap(), 0);
    assert!(store.v2_notebooks(false).unwrap().is_empty());
    assert_eq!(store.v2_account().unwrap().unwrap().user.id, "usr_b");
}

#[test]
fn clearing_account_removes_user_scoped_sync_state() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store
        .save_v2_account(&V2CloudAccount {
            user: CloudUser {
                id: "usr_a".into(),
                email: "a@example.com".into(),
                display_name: "A".into(),
                region: "non_mainland".into(),
            },
            protocol_epoch: PROTOCOL_EPOCH,
        })
        .unwrap();
    store.set_v2_notebook("nb_a", true).unwrap();
    store.commit_v2_cursor(9, 100).unwrap();

    store.clear_v2_account().unwrap();

    assert!(store.v2_account().unwrap().is_none());
    assert_eq!(store.v2_cursor().unwrap(), 0);
    assert!(store.v2_notebooks(false).unwrap().is_empty());
}

#[test]
fn deferred_read_only_changes_survive_reopen_without_advancing_their_baseline() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("sync.db");
    let store = SyncStore::new(&path).unwrap();
    store.set_v2_notebook("nb_deferred", true).unwrap();
    store
        .commit_v2_sync_report(
            &[V2RemoteApply::Notebook {
                notebook_id: "nb_deferred".into(),
                name: Some("Original".into()),
                icon: None,
                sort_order: Some(0),
                revision: "rev_1".into(),
                sync_seq: 1,
                deleted: false,
            }],
            1,
            &["nb_deferred".into()],
            1,
        )
        .unwrap();
    store
        .mark_v2_dirty(
            V2EntityType::Notebook,
            "nb_deferred",
            Some("nb_deferred"),
            V2OperationKind::Put,
            "local-rename",
            2,
        )
        .unwrap();
    let report = crate::v2::V2AccountSyncReport {
        cursor: 8,
        read_only: true,
        bootstrapped_notebooks: vec!["nb_deferred".into()],
        deferred_notebooks: vec!["nb_deferred".into()],
        ..Default::default()
    };
    store
        .commit_v2_prepared_report(&report, Some("nb_deferred"), 3)
        .unwrap();
    drop(store);
    let reopened = SyncStore::new(&path).unwrap();
    assert_eq!(reopened.v2_notebook_cursor("nb_deferred").unwrap(), 8);
    assert!(reopened.v2_notebooks(true).unwrap()[0].bootstrap_required);
    assert_eq!(
        reopened
            .v2_notebook_state("nb_deferred")
            .unwrap()
            .unwrap()
            .revision,
        "rev_1"
    );
    assert_eq!(
        reopened.v2_dirty_entities().unwrap()[0].fingerprint,
        "local-rename"
    );
    // A later successful bootstrap clears the durable retry marker.
    reopened
        .commit_v2_notebook_sync_report("nb_deferred", &[], 9, &["nb_deferred".into()], 4)
        .unwrap();
    assert!(!reopened.v2_notebooks(true).unwrap()[0].bootstrap_required);
}

#[test]
fn acknowledged_delete_retires_older_uploads_but_preserves_newer_edits() {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    store
        .commit_v2_sync_report(
            &[V2RemoteApply::Note {
                note_id: "note".into(),
                notebook_id: "nb".into(),
                filename: "note.md".into(),
                content_hash: Some("original".into()),
                content: None,
                revision: "rev_1".into(),
                sync_seq: 1,
                deleted: false,
                attachments: Vec::new(),
            }],
            1,
            &[],
            1,
        )
        .unwrap();
    let mut generations = Vec::new();
    for (operation_id, kind, fingerprint) in [
        ("old_upload", V2OperationKind::Put, "old-edit"),
        ("delete", V2OperationKind::Delete, "deleted"),
        ("new_upload", V2OperationKind::Put, "new-edit"),
    ] {
        let dirty = store
            .mark_v2_dirty(V2EntityType::Note, "note", Some("nb"), kind, fingerprint, 2)
            .unwrap();
        generations.push(dirty.generation);
        store
            .freeze_v2_operation(V2FreezeOperation {
                operation_id,
                entity_type: V2EntityType::Note,
                entity_id: "note",
                generation: dirty.generation,
                operation_kind: kind,
                base_revision: Some("rev_1"),
                payload_json: "{}",
            })
            .unwrap();
    }
    let operation = V2PushOperation::NoteDelete {
        operation_id: "delete".into(),
        base_revision: Some("rev_1".into()),
        note_id: "note".into(),
    };
    let data = V2OperationData {
        entity_type: "note".into(),
        entity_id: "note".into(),
        revision: "rev_2".into(),
        sync_seq: 2,
        deleted: true,
        resolution: "fast_forward".into(),
        base_revision: Some("rev_1".into()),
        replaced_revision: Some("rev_1".into()),
        content_hash: None,
        source_revision: None,
        source_sync_seq: None,
    };
    store
        .acknowledge_v2_operation(
            "delete",
            V2EntityType::Note,
            "note",
            generations[1],
            &operation,
            &data,
        )
        .unwrap();
    let remaining = store.v2_inflight_due(0).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].operation_id, "new_upload");
    assert_eq!(
        store.v2_dirty_entities().unwrap()[0].generation,
        generations[2]
    );
}
