use super::*;
use crate::reconcile::DirScanRecord;
use crate::state::{
    build_local_view, credential_fingerprint, state_after_transfer, DirectoryState, NotebookState,
    PathState, ScannedLocalFile,
};
use std::collections::BTreeMap;

const NB: &str = "nb_notes";

fn store() -> (tempfile::TempDir, SyncStore) {
    let temp = tempfile::tempdir().unwrap();
    let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
    (temp, store)
}

#[test]
fn state_round_trips_including_pending_and_absent_hash() {
    let (_temp, store) = store();
    let synced = state_after_transfer(
        "notes/a.md",
        "notes/a.md",
        "sha256:aa",
        12,
        1_000,
        2_000,
        None,
    );
    let unhashed = PathState {
        content_hash: None,
        last_synced_at: 0,
        ..state_after_transfer("notes/b.md", "notes/B.md", "sha256:bb", 7, 1_500, 0, None)
    };
    let pending = PathState {
        pending_since: Some(9_000),
        ..state_after_transfer(
            "notes/c.md",
            "notes/c.md",
            "sha256:cc",
            3,
            1_600,
            2_100,
            None,
        )
    };

    store
        .save_path_states(NB, &[synced.clone(), unhashed.clone(), pending.clone()])
        .unwrap();

    let snapshot = store.snapshot(NB).unwrap();
    assert_eq!(snapshot.states.len(), 3);
    assert_eq!(snapshot.states["notes/a.md"], synced);
    assert_eq!(snapshot.states["notes/b.md"], unhashed);
    assert_eq!(snapshot.states["notes/b.md"].display_path, "notes/B.md");
    assert_eq!(snapshot.states["notes/c.md"].pending_since, Some(9_000));
}

#[test]
fn saving_the_same_path_twice_updates_instead_of_duplicating() {
    let (_temp, store) = store();
    let first = state_after_transfer("a.md", "a.md", "sha256:aa", 10, 1_000, 2_000, None);
    store.save_path_states(NB, &[first]).unwrap();

    let second = state_after_transfer("a.md", "a.md", "sha256:bb", 20, 3_000, 4_000, None);
    store
        .save_path_states(NB, std::slice::from_ref(&second))
        .unwrap();

    let snapshot = store.snapshot(NB).unwrap();
    assert_eq!(snapshot.states.len(), 1);
    assert_eq!(snapshot.states["a.md"], second);
}

#[test]
fn pending_set_is_replaced_not_merged() {
    let (_temp, store) = store();
    store
        .save_path_states(
            NB,
            &[
                PathState {
                    pending_since: Some(1_000),
                    ..state_after_transfer("a.md", "a.md", "h", 1, 1, 1, None)
                },
                PathState {
                    pending_since: Some(2_000),
                    ..state_after_transfer("b.md", "b.md", "h", 1, 1, 1, None)
                },
                state_after_transfer("c.md", "c.md", "h", 1, 1, 1, None),
            ],
        )
        .unwrap();

    // `a.md` confirmed, `b.md` dropped, `c.md` newly observed absent.
    let next = [(String::from("c.md"), 5_000)].into_iter().collect();
    store.set_pending_deletions(NB, &next).unwrap();

    let snapshot = store.snapshot(NB).unwrap();
    assert_eq!(snapshot.states["a.md"].pending_since, None);
    assert_eq!(snapshot.states["b.md"].pending_since, None);
    assert_eq!(snapshot.states["c.md"].pending_since, Some(5_000));
}

#[test]
fn dir_scans_upsert_by_directory() {
    let (_temp, store) = store();
    let first: BTreeMap<String, DirScanRecord> = [(
        String::new(),
        DirScanRecord {
            stamp_millis: 100,
            scanned_at_millis: 200,
        },
    )]
    .into_iter()
    .collect();
    store.save_dir_scans(NB, &first).unwrap();

    let second: BTreeMap<String, DirScanRecord> = [
        (
            String::new(),
            DirScanRecord {
                stamp_millis: 300,
                scanned_at_millis: 400,
            },
        ),
        (
            String::from("notes"),
            DirScanRecord {
                stamp_millis: 500,
                scanned_at_millis: 600,
            },
        ),
    ]
    .into_iter()
    .collect();
    store.save_dir_scans(NB, &second).unwrap();

    let snapshot = store.snapshot(NB).unwrap();
    assert_eq!(snapshot.dir_scans.len(), 2);
    assert_eq!(snapshot.dir_scans[""].stamp_millis, 300);
    assert_eq!(snapshot.dir_scans["notes"].scanned_at_millis, 600);
}

/// Rebinding must do all three things at once: clear pending, move every
/// baseline to the migration instant, open a grace window. Doing only two
/// leaves either an instant delete or a full re-download (§13.4).
#[test]
fn rebinding_a_different_bucket_resets_pending_and_baselines() {
    let (_temp, store) = store();
    let fingerprint = credential_fingerprint("r2-primary", "flowix", "u/usr_1/");
    store
        .save_path_states(
            NB,
            &[
                PathState {
                    pending_since: Some(1_000),
                    ..state_after_transfer("a.md", "a.md", "sha256:aa", 1, 1, 2_000, None)
                },
                state_after_transfer("b.md", "b.md", "sha256:bb", 1, 1, 2_000, None),
            ],
        )
        .unwrap();
    store
        .save_notebook_state(&NotebookState::new(NB, fingerprint.clone()))
        .unwrap();

    let changed = store
        .rebind_credential(NB, "sha256:newbucket", 50_000, 350_000)
        .unwrap();
    assert!(changed);

    let snapshot = store.snapshot(NB).unwrap();
    assert_eq!(
        snapshot.states["a.md"].pending_since, None,
        "old bucket's first-seen is meaningless"
    );
    assert_eq!(snapshot.states["a.md"].last_synced_at, 50_000);
    assert_eq!(snapshot.states["b.md"].last_synced_at, 50_000);
    // Hashes survive the rebind and remain available to the next pass.
    assert_eq!(
        snapshot.states["b.md"].content_hash.as_deref(),
        Some("sha256:bb")
    );

    let state = store.notebook_state(NB).unwrap().unwrap();
    assert_eq!(state.credential_fingerprint, "sha256:newbucket");
    assert_eq!(state.grace_until, Some(350_000));
    assert!(!state.allows_deletes(349_999));
}

#[test]
fn rebinding_the_same_bucket_keeps_baselines_and_reports_no_change() {
    let (_temp, store) = store();
    let fingerprint = credential_fingerprint("r2-primary", "flowix", "u/usr_1/");
    store
        .save_path_states(
            NB,
            &[PathState {
                pending_since: Some(1_000),
                ..state_after_transfer("a.md", "a.md", "sha256:aa", 1, 1, 2_000, None)
            }],
        )
        .unwrap();
    store
        .save_notebook_state(&NotebookState::new(NB, fingerprint.clone()))
        .unwrap();

    let changed = store
        .rebind_credential(NB, &fingerprint, 50_000, 350_000)
        .unwrap();
    assert!(
        !changed,
        "same bucket, so credentials rotate without invalidating state"
    );

    let snapshot = store.snapshot(NB).unwrap();
    assert_eq!(snapshot.states["a.md"].last_synced_at, 2_000);
    assert_eq!(snapshot.states["a.md"].pending_since, Some(1_000));
}

#[test]
fn clearing_one_notebook_leaves_the_other_alone() {
    let (_temp, store) = store();
    store
        .save_path_states(
            NB,
            &[state_after_transfer(
                "a.md",
                "a.md",
                "sha256:aa",
                1,
                1,
                2_000,
                None,
            )],
        )
        .unwrap();
    store
        .save_path_states(
            "nb_other",
            &[state_after_transfer(
                "a.md",
                "a.md",
                "sha256:aa",
                1,
                1,
                2_000,
                None,
            )],
        )
        .unwrap();

    store.clear_notebook(NB).unwrap();

    assert!(store.snapshot(NB).unwrap().states.is_empty());
    assert_eq!(store.snapshot("nb_other").unwrap().states.len(), 1);
}

/// End to end across the two halves: what SQL stores is what the decision
/// layer sees.
#[test]
fn snapshot_and_scan_feed_the_decision_layer() {
    let (_temp, store) = store();
    store
        .save_path_states(
            NB,
            &[
                state_after_transfer(
                    "notes/synced.md",
                    "notes/synced.md",
                    "sha256:aa",
                    10,
                    1_000,
                    2_000,
                    None,
                ),
                state_after_transfer(
                    "notes/edited.md",
                    "notes/edited.md",
                    "sha256:bb",
                    10,
                    1_000,
                    2_000,
                    None,
                ),
            ],
        )
        .unwrap();
    let snapshot = store.snapshot(NB).unwrap();

    let scanned = vec![
        ScannedLocalFile::new("notes/synced.md", 10, 1_000).unwrap(),
        // Same length, later mtime: only the mtime betrays the edit.
        ScannedLocalFile::new("notes/edited.md", 10, 2_500).unwrap(),
        ScannedLocalFile::new("notes/new.md", 4, 3_000).unwrap(),
    ];
    let view = build_local_view(&snapshot, &scanned, "mac-7f3a", true);

    let dirty: Vec<(&str, bool)> = view
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.dirty))
        .collect();
    assert_eq!(
        dirty,
        vec![
            ("notes/synced.md", false),
            ("notes/edited.md", true),
            ("notes/new.md", true)
        ]
    );
    assert!(view.pending_deletions.is_empty());
}

#[test]
fn schema_initialization_is_idempotent() {
    let (_temp, store) = store();
    store.initialize_schema().unwrap();
    store.initialize_schema().unwrap();
    assert!(store.snapshot(NB).unwrap().states.is_empty());
}

/// Proxy deletions used to ride in the stamp queue behind a NUL-prefixed
/// synthetic path. An install from before the split still has those rows, and
/// the stamp queue only holds directories now — leaving them there would make
/// the next pass publish a directory stamp for a file path.
#[test]
fn legacy_proxy_rows_move_out_of_the_stamp_queue() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("sync.db");
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE v4_pending_stamp (
                    notebook_id TEXT NOT NULL,
                    dir TEXT NOT NULL,
                    PRIMARY KEY(notebook_id, dir)
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO v4_pending_stamp(notebook_id, dir) VALUES (?1, ?2), (?1, ?3)",
                rusqlite::params![NB, "\0proxy/notes/a.md", "notes"],
            )
            .unwrap();
    }

    let store = SyncStore::new(&path).unwrap();
    assert_eq!(store.pending_stamps(NB).unwrap(), ["notes"]);
    assert_eq!(store.pending_proxy_deletions(NB).unwrap(), ["notes/a.md"]);
}

#[test]
fn directory_states_round_trip_confirmation_window() {
    let (_temp, store) = store();
    let state = DirectoryState {
        path: "projects/empty".into(),
        last_synced_at: 5_000,
        deleted: false,
        local_mtime_millis: 4_000,
        pending_since: Some(8_000),
    };
    store
        .save_directory_states(NB, std::slice::from_ref(&state))
        .unwrap();

    assert_eq!(store.directory_states(NB).unwrap(), [state]);
}

/// `remote_etag` arrived after the table shipped, so an existing install has
/// the old shape. `CREATE TABLE IF NOT EXISTS` does not migrate it, and every
/// insert would then fail on a missing column — a startup-time break for
/// anyone who ran an earlier build.
#[test]
fn an_existing_table_gains_the_etag_column() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("sync.db");
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE v4_path_state (
                    notebook_id TEXT NOT NULL,
                    path TEXT NOT NULL,
                    display_path TEXT NOT NULL,
                    content_hash TEXT,
                    local_size INTEGER NOT NULL,
                    local_mtime_millis INTEGER NOT NULL,
                    last_synced_at INTEGER NOT NULL,
                    pending_since INTEGER,
                    PRIMARY KEY(notebook_id, path)
                );",
            )
            .unwrap();
    }

    let store = SyncStore::new(&path).unwrap();
    store
        .save_path_states(
            NB,
            &[state_after_transfer(
                "notes/a.md",
                "notes/a.md",
                "sha256:aa",
                12,
                1_000,
                2_000,
                Some("\"etag-v1\"".to_string()),
            )],
        )
        .unwrap();

    let snapshot = store.snapshot(NB).unwrap();
    assert_eq!(
        snapshot
            .states
            .get("notes/a.md")
            .and_then(|state| state.remote_etag.as_deref()),
        Some("\"etag-v1\""),
        "the added column must round-trip, not just exist"
    );
}
