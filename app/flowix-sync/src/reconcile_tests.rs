//! Branch-level tests for the decision table in `reconcile`.
//!
//! They live in their own file so the module stays well under the
//! thousand-line freeze gate: the engine and the executor will keep adding
//! to `reconcile.rs`, but the table only grows when a rule changes.

use super::*;

const NOW: i64 = 1_795_300_000_000;
const MINUTE: i64 = 60_000;

fn local(files: Vec<LocalFile>) -> LocalView {
    LocalView {
        files,
        last_synced_at: BTreeMap::new(),
        remote_etags: BTreeMap::new(),
        pending_deletions: BTreeMap::new(),
        device_id: "mac-7f3a".to_string(),
        allow_deletes: true,
    }
}

fn synced(mut view: LocalView, path: &str, mtime: i64) -> LocalView {
    view.last_synced_at.insert(path.to_string(), mtime);
    view
}

fn plan(
    local: &LocalView,
    remote: &RemoteListing,
    pending: &[(String, i64)],
    now: i64,
) -> ReconcilePlan {
    let mut view = local.clone();
    view.pending_deletions = pending.iter().cloned().collect();
    reconcile(&view, remote, now)
}

fn tags(plan: &ReconcilePlan) -> Vec<&'static str> {
    plan.actions.iter().map(SyncAction::kind_tag).collect()
}

/// The decision matrix: local state × remote state. Each row is one path.
#[test]
fn decision_table() {
    struct Row {
        name: &'static str,
        file: Option<LocalFile>,
        baseline: Option<i64>,
        remote: Option<RemoteObject>,
        /// Whether the containing directory was listed this pass.
        listed: bool,
        pending: Option<i64>,
        allow_deletes: bool,
        expected: &'static str,
    }

    let clean = || Some(LocalFile::new("notes/a.md", 100));
    let dirty = || {
        Some(
            LocalFile::new("notes/a.md", 120)
                .dirty()
                .hashed("sha256:bbbb"),
        )
    };
    let remote_file = |mtime: i64, size: u64| Some(RemoteObject::file("notes/a.md", mtime, size));

    let rows = vec![
        Row {
            name: "identical content clears a dirty flag without moving bytes",
            file: dirty(),
            baseline: Some(NOW - MINUTE),
            remote: Some(RemoteObject::file("notes/a.md", NOW - MINUTE, 120).hashed("sha256:bbbb")),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "",
        },
        Row {
            name: "new local file uploads",
            file: clean(),
            baseline: None,
            remote: None,
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "upload:new",
        },
        Row {
            name: "new remote file downloads",
            file: None,
            baseline: None,
            remote: remote_file(NOW, 100),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "download:new",
        },
        Row {
            name: "clean local, remote changed, remote wins",
            file: clean(),
            baseline: Some(NOW - MINUTE),
            remote: remote_file(NOW, 140),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "download:remote-new",
        },
        Row {
            name: "dirty local edited after the baseline uploads",
            file: dirty(),
            baseline: Some(NOW - MINUTE),
            remote: remote_file(NOW - MINUTE, 100),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "upload:local-ahead",
        },
        Row {
            name: "dirty local versus newer remote keeps a conflict copy",
            file: dirty(),
            baseline: Some(NOW - MINUTE),
            remote: remote_file(NOW - 30_000, 100),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "download:conflict",
        },
        Row {
            name: "equal timestamps tie-break on hash, remote higher",
            file: Some(
                LocalFile::new("notes/a.md", 100)
                    .dirty()
                    .hashed("sha256:aaaa"),
            ),
            baseline: Some(NOW),
            remote: Some(RemoteObject::file("notes/a.md", NOW, 100).hashed("sha256:bbbb")),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "download:conflict",
        },
        Row {
            name: "equal timestamps tie-break on hash, local higher",
            file: Some(
                LocalFile::new("notes/a.md", 100)
                    .dirty()
                    .hashed("sha256:cccc"),
            ),
            baseline: Some(NOW),
            remote: Some(RemoteObject::file("notes/a.md", NOW, 100).hashed("sha256:bbbb")),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "upload:local-ahead",
        },
        Row {
            name: "absent, never synced, is a new file not a delete",
            file: clean(),
            baseline: None,
            remote: None,
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "upload:new",
        },
        Row {
            name: "first absence only starts the window",
            file: clean(),
            baseline: Some(NOW - MINUTE),
            remote: None,
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "defer:delete-unconfirmed",
        },
        Row {
            name: "second absence past the window deletes",
            file: clean(),
            baseline: Some(NOW - MINUTE),
            remote: None,
            listed: true,
            pending: Some(NOW - DELETE_CONFIRM_WINDOW_MS),
            allow_deletes: true,
            expected: "delete-local",
        },
        Row {
            name: "absence inside the window keeps waiting",
            file: clean(),
            baseline: Some(NOW - MINUTE),
            remote: None,
            listed: true,
            pending: Some(NOW - MINUTE),
            allow_deletes: true,
            expected: "defer:delete-unconfirmed",
        },
        Row {
            name: "grace period suppresses the delete",
            file: clean(),
            baseline: Some(NOW - MINUTE),
            remote: None,
            listed: true,
            pending: Some(NOW - DELETE_CONFIRM_WINDOW_MS * 2),
            allow_deletes: false,
            expected: "defer:grace",
        },
        Row {
            name: "dirty local survives an absent remote",
            file: dirty(),
            baseline: Some(NOW - MINUTE),
            remote: None,
            listed: true,
            pending: Some(NOW - DELETE_CONFIRM_WINDOW_MS * 2),
            allow_deletes: true,
            expected: "upload:resurrect",
        },
        Row {
            name: "unlisted directory proves nothing",
            file: clean(),
            baseline: Some(NOW - MINUTE),
            remote: None,
            listed: false,
            pending: None,
            allow_deletes: true,
            expected: "",
        },
        Row {
            name: "unlisted directory keeps a pending window unaaged",
            file: clean(),
            baseline: Some(NOW - MINUTE),
            remote: None,
            listed: false,
            pending: Some(NOW - MINUTE),
            allow_deletes: true,
            expected: "defer:remote-unknown",
        },
        Row {
            name: "dirty file in an unlisted directory is probed",
            file: dirty(),
            baseline: Some(NOW - MINUTE),
            remote: None,
            listed: false,
            pending: None,
            allow_deletes: true,
            expected: "probe",
        },
        Row {
            name: "tombstone after our last sync deletes a clean file",
            file: clean(),
            baseline: Some(NOW - MINUTE),
            remote: Some(RemoteObject::tombstone("notes/a.md", NOW)),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "delete-local",
        },
        Row {
            name: "tombstone predating our last sync resurrects",
            file: clean(),
            baseline: Some(NOW),
            remote: Some(RemoteObject::tombstone("notes/a.md", NOW - MINUTE)),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "upload:resurrect",
        },
        Row {
            name: "dirty file beats a tombstone",
            file: dirty(),
            baseline: Some(NOW - MINUTE),
            remote: Some(RemoteObject::tombstone("notes/a.md", NOW)),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "upload:resurrect",
        },
        Row {
            name: "tombstone with no local copy just records the baseline",
            file: None,
            baseline: None,
            remote: Some(RemoteObject::tombstone("notes/a.md", NOW)),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "",
        },
        Row {
            name: "a file gone from disk is a deletion, not a download",
            file: None,
            baseline: Some(NOW - MINUTE),
            remote: remote_file(NOW - MINUTE, 100),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "defer:delete-unconfirmed",
        },
        Row {
            name: "a local deletion is propagated once the window elapsed",
            file: None,
            baseline: Some(NOW - MINUTE),
            remote: remote_file(NOW - MINUTE, 100),
            listed: true,
            pending: Some(NOW - DELETE_CONFIRM_WINDOW_MS),
            allow_deletes: true,
            expected: "write-tombstone",
        },
        Row {
            name: "a local deletion inside the grace window waits",
            file: None,
            baseline: Some(NOW - MINUTE),
            remote: remote_file(NOW - MINUTE, 100),
            listed: true,
            pending: Some(NOW - DELETE_CONFIRM_WINDOW_MS * 2),
            allow_deletes: false,
            expected: "defer:grace",
        },
        Row {
            name: "a local deletion of a file nobody else has needs no tombstone",
            file: None,
            baseline: Some(NOW - MINUTE),
            remote: None,
            listed: true,
            pending: Some(NOW - MINUTE),
            allow_deletes: true,
            expected: "",
        },
        Row {
            name: "same size and unchanged stamp needs no transfer",
            file: clean(),
            baseline: Some(NOW),
            remote: remote_file(NOW, 100),
            listed: true,
            pending: None,
            allow_deletes: true,
            expected: "",
        },
    ];

    for row in rows {
        let mut view = local(row.file.clone().into_iter().collect());
        view.allow_deletes = row.allow_deletes;
        if let Some(baseline) = row.baseline {
            view = synced(view, "notes/a.md", baseline);
        }
        let remote = RemoteListing {
            observed_dirs: if row.listed {
                ["notes".to_string()].into_iter().collect()
            } else {
                BTreeSet::new()
            },
            ..RemoteListing::with_dirs(row.remote.clone(), [])
        };
        let pending = row
            .pending
            .map(|at| vec![("notes/a.md".to_string(), at)])
            .unwrap_or_default();
        let plan = plan(&view, &remote, &pending, NOW);
        let actual = tags(&plan).join(",");
        assert_eq!(actual, row.expected, "case: {}", row.name);
    }
}

#[test]
fn conflict_download_carries_a_backup_label() {
    let view = synced(
        local(vec![LocalFile::new("notes/a.md", 100).dirty()]),
        "notes/a.md",
        NOW - MINUTE,
    );
    let remote = RemoteListing::with_dirs([RemoteObject::file("notes/a.md", NOW, 100)], ["notes"]);
    let plan = plan(&view, &remote, &[], NOW);
    let SyncAction::Download(download) = &plan.actions[0] else {
        panic!("expected a download")
    };
    assert_eq!(download.reason, DownloadReason::Conflict);
    let backup = download.backup.as_ref().expect("backup label");
    assert_eq!(backup.device_id, "mac-7f3a");
    assert_eq!(backup.at_millis, NOW);
    assert_eq!(
        plan.baselines[0],
        Baseline {
            path: "notes/a.md".into(),
            mtime_millis: NOW,
            clear_dirty: true
        }
    );
}

#[test]
fn uploads_touch_each_directory_once() {
    let view = local(vec![
        LocalFile::new("notes/a.md", 10).dirty(),
        LocalFile::new("notes/b.md", 10).dirty(),
        LocalFile::new("notes/sub/c.md", 10).dirty(),
        LocalFile::new("root.md", 10).dirty(),
    ]);
    // Dirs must be registered as listed, otherwise absence is unknown and
    // the pass probes instead of uploading.
    let remote = RemoteListing::with_dirs([], ["", "notes", "notes/sub"]);
    let plan = plan(&view, &remote, &[], NOW);
    assert_eq!(plan.stats.uploads, 4);
    assert_eq!(
        plan.touch_dirs.into_iter().collect::<Vec<_>>(),
        vec!["", "notes", "notes/sub"]
    );
}

/// A `HEAD` 404 is evidence about exactly one key. It must be enough to
/// start the delete window (otherwise a dirty-then-deleted file probes
/// forever) and not enough to authorise anything else in that directory.
#[test]
fn a_probed_404_starts_the_delete_window_without_revealing_the_directory() {
    let view = synced(
        local(vec![LocalFile::new("notes/a.md", 100)]),
        "notes/a.md",
        NOW - MINUTE,
    );
    let mut remote = RemoteListing::default();
    remote.mark_missing("notes/a.md");
    assert_eq!(remote.state_for("notes/a.md"), RemoteState::Missing);
    assert_eq!(remote.state_for("notes/b.md"), RemoteState::Unknown);

    let first = plan(&view, &remote, &[], NOW);
    assert_eq!(tags(&first), vec!["defer:delete-unconfirmed"]);
    assert_eq!(first.pending_deletions.get("notes/a.md"), Some(&NOW));

    // Still absent five minutes later: now it is a delete.
    let later = plan(
        &view,
        &remote,
        &[("notes/a.md".to_string(), NOW - DELETE_CONFIRM_WINDOW_MS)],
        NOW,
    );
    assert_eq!(tags(&later), vec!["delete-local"]);
}

#[test]
fn a_resolved_path_leaves_the_pending_set() {
    let view = synced(
        local(vec![LocalFile::new("notes/a.md", 100)]),
        "notes/a.md",
        NOW - MINUTE,
    );
    // Same stamp as the baseline: the path is already converged, so the
    // pending deletion is simply dropped.
    let remote = RemoteListing::with_dirs(
        [RemoteObject::file("notes/a.md", NOW - MINUTE, 100)],
        ["notes"],
    );
    let pending = vec![("notes/a.md".to_string(), NOW - MINUTE * 10)];
    let plan = plan(&view, &remote, &pending, NOW);
    assert!(plan.pending_deletions.is_empty());
    assert!(plan.actions.is_empty());
}

#[test]
fn confirmed_delete_drops_the_pending_entry() {
    let view = synced(
        local(vec![LocalFile::new("notes/a.md", 100)]),
        "notes/a.md",
        NOW - MINUTE,
    );
    let remote = RemoteListing::with_dirs([], ["notes"]);
    let pending = vec![("notes/a.md".to_string(), NOW - DELETE_CONFIRM_WINDOW_MS)];
    let plan = plan(&view, &remote, &pending, NOW);
    assert_eq!(tags(&plan), vec!["delete-local"]);
    assert!(plan.pending_deletions.is_empty());
}

/// An entry nobody can check is kept, not dropped: it is what forces the gate
/// to re-list the directory. Once readable, it goes away.
#[test]
fn an_orphan_pending_entry_survives_until_it_can_be_checked() {
    let blind = plan(
        &local(vec![]),
        &RemoteListing::default(),
        &[("notes/gone.md".to_string(), NOW - MINUTE)],
        NOW,
    );
    assert_eq!(tags(&blind), vec!["defer:remote-unknown"]);
    assert_eq!(blind.pending_deletions.len(), 1);

    let listed = plan(
        &local(vec![]),
        &RemoteListing::with_dirs([], ["notes"]),
        &[("notes/gone.md".to_string(), NOW - MINUTE)],
        NOW,
    );
    assert!(listed.actions.is_empty());
    assert!(listed.pending_deletions.is_empty());
    assert_eq!(listed.forget, vec!["notes/gone.md"]);
}

/// A file deleted on this device while the cloud still has it must produce a
/// tombstone — otherwise the next pass downloads it back and the note returns.
#[test]
fn a_local_deletion_writes_a_tombstone_and_moves_the_directory_stamp() {
    let view = synced(local(vec![]), "notes/a.md", NOW - MINUTE);
    let remote = RemoteListing::with_dirs(
        [RemoteObject::file("notes/a.md", NOW - MINUTE, 100)],
        ["notes"],
    );
    let pending = vec![("notes/a.md".to_string(), NOW - DELETE_CONFIRM_WINDOW_MS)];

    let plan = plan(&view, &remote, &pending, NOW);
    assert_eq!(tags(&plan), vec!["write-tombstone"]);
    assert_eq!(plan.stats.tombstones, 1);
    assert_eq!(
        plan.stats.deletes, 0,
        "nothing local to delete: it is already gone"
    );
    assert_eq!(
        plan.touch_dirs.into_iter().collect::<Vec<_>>(),
        vec!["notes"],
        "a tombstone is a write under f/, so other devices only notice via the stamp",
    );
    assert!(plan.pending_deletions.is_empty());
}

/// The window has to survive a pass where the directory could not be read,
/// because a local deletion never moves the stamp and nothing else would bring
/// the directory back for a second look.
#[test]
fn a_blind_pass_does_not_restart_a_local_deletion_window() {
    let view = synced(local(vec![]), "notes/a.md", NOW - MINUTE);
    let remote = RemoteListing::default();
    assert_eq!(remote.state_for("notes/a.md"), RemoteState::Unknown);

    let blind = plan(
        &view,
        &remote,
        &[("notes/a.md".to_string(), NOW - MINUTE)],
        NOW,
    );
    assert_eq!(tags(&blind), vec!["defer:remote-unknown"]);
    assert_eq!(
        blind.pending_deletions.get("notes/a.md"),
        Some(&(NOW - MINUTE))
    );

    // Once it can be read, the elapsed window counts from the *first* sighting
    // rather than restarting at this pass.
    let visible = RemoteListing::with_dirs(
        [RemoteObject::file("notes/a.md", NOW - MINUTE, 100)],
        ["notes"],
    );
    let seen = plan(
        &view,
        &visible,
        &[("notes/a.md".to_string(), NOW - MINUTE)],
        NOW,
    );
    assert_eq!(tags(&seen), vec!["defer:delete-unconfirmed"]);
    assert_eq!(
        seen.pending_deletions.get("notes/a.md"),
        Some(&(NOW - MINUTE))
    );
}

/// Both sides gone: nothing to write, nothing to keep.
#[test]
fn a_path_gone_from_both_sides_is_forgotten() {
    let view = synced(local(vec![]), "notes/a.md", NOW - MINUTE);
    let remote = RemoteListing::with_dirs([], ["notes"]);
    let plan = plan(
        &view,
        &remote,
        &[("notes/a.md".to_string(), NOW - MINUTE)],
        NOW,
    );
    assert!(plan.actions.is_empty());
    assert_eq!(plan.forget, vec!["notes/a.md"]);
    assert!(plan.pending_deletions.is_empty());
}

/// A tombstone for a path this device no longer has is the end of the story.
#[test]
fn a_tombstone_for_a_path_that_is_already_gone_is_forgotten() {
    let view = synced(local(vec![]), "notes/a.md", NOW - MINUTE);
    let remote = RemoteListing::with_dirs([RemoteObject::tombstone("notes/a.md", NOW)], ["notes"]);
    let plan = plan(&view, &remote, &[], NOW);
    assert!(plan.actions.is_empty());
    assert_eq!(plan.forget, vec!["notes/a.md"]);
}

#[test]
fn dirty_local_converges_on_identical_content() {
    let view = synced(
        local(vec![LocalFile::new("notes/a.md", 100)
            .dirty()
            .hashed("sha256:abcd")]),
        "notes/a.md",
        NOW - MINUTE,
    );
    let remote = RemoteListing::with_dirs(
        [RemoteObject::file("notes/a.md", NOW, 100).hashed("sha256:abcd")],
        ["notes"],
    );
    let plan = plan(&view, &remote, &[], NOW);
    assert!(plan.actions.is_empty());
    assert!(plan.baselines[0].clear_dirty);
    assert_eq!(plan.baselines[0].mtime_millis, NOW);
}

#[test]
fn same_size_edit_is_never_mistaken_for_unchanged() {
    // A dirty file whose size did not change must still upload: treating a
    // size match as proof would silently drop the edit.
    let view = synced(
        local(vec![LocalFile::new("notes/a.md", 100).dirty()]),
        "notes/a.md",
        NOW,
    );
    let remote = RemoteListing::with_dirs([RemoteObject::file("notes/a.md", NOW, 100)], ["notes"]);
    assert_eq!(
        tags(&plan(&view, &remote, &[], NOW)),
        vec!["upload:local-ahead"]
    );
}

#[test]
fn l1_gate_lists_only_directories_that_may_have_changed() {
    let stamps: BTreeMap<String, i64> = [
        ("".to_string(), NOW - 20 * MINUTE),
        ("archive".to_string(), NOW - 2 * MINUTE),
        ("drafts".to_string(), NOW - 3_000),
        ("fresh".to_string(), NOW),
        ("notes".to_string(), NOW - 5 * MINUTE),
        ("rewound".to_string(), NOW - 10 * MINUTE),
    ]
    .into_iter()
    .collect();
    // A directory that exists only locally: no stamp, so a stamp-only gate
    // would never list it and its first upload would be stuck as "unknown".
    let view = local(vec![LocalFile::new("brand-new/note.md", 10)]);
    let scanned: BTreeMap<String, DirScanRecord> = [
        // Scanned ten minutes ago, stamp untouched since: skip.
        (
            "".to_string(),
            DirScanRecord {
                stamp_millis: NOW - 20 * MINUTE,
                scanned_at_millis: NOW - 10 * MINUTE,
            },
        ),
        // Stamp advanced past the last scan: list.
        (
            "archive".to_string(),
            DirScanRecord {
                stamp_millis: NOW - 5 * MINUTE,
                scanned_at_millis: NOW - 5 * MINUTE,
            },
        ),
        // Stamp unchanged, but a same-second write could still be in
        // flight: one boundary recheck, then it goes quiet.
        (
            "drafts".to_string(),
            DirScanRecord {
                stamp_millis: NOW - 3_000,
                scanned_at_millis: NOW - 1_000,
            },
        ),
        // Stamp unchanged and the scan happened a minute after the write,
        // so the same-second race is settled: skip.
        (
            "notes".to_string(),
            DirScanRecord {
                stamp_millis: NOW - 5 * MINUTE,
                scanned_at_millis: NOW - 4 * MINUTE,
            },
        ),
        // Stamp moved backwards: the backend rewrote LastModified, so no
        // comparison is trustworthy until the directory is re-read.
        (
            "rewound".to_string(),
            DirScanRecord {
                stamp_millis: NOW - 5 * MINUTE,
                scanned_at_millis: NOW - 5 * MINUTE,
            },
        ),
    ]
    .into_iter()
    .collect();

    let due = directories_to_scan(&view, &stamps, &scanned, NOW, false);
    assert_eq!(
        due,
        vec!["archive", "brand-new", "drafts", "fresh", "rewound"]
    );

    let forced = directories_to_scan(&view, &stamps, &scanned, NOW, true);
    assert_eq!(forced.len(), stamps.len() + 1, "a sweep lists everything");

    // Quiet steady state: nothing changes, nothing is listed.
    let quiet: BTreeMap<String, i64> = [("notes".to_string(), NOW - 5 * MINUTE)]
        .into_iter()
        .collect();
    assert!(directories_to_scan(&local(vec![]), &quiet, &scanned, NOW, false).is_empty());

    // A stamp equal to the scan moment earns exactly one recheck, then
    // goes quiet once the rescanned record has a later timestamp.
    let same_second: BTreeMap<String, DirScanRecord> = [(
        "notes".to_string(),
        DirScanRecord {
            stamp_millis: NOW - 5 * MINUTE,
            scanned_at_millis: NOW - 5 * MINUTE,
        },
    )]
    .into_iter()
    .collect();
    assert_eq!(
        directories_to_scan(&local(vec![]), &quiet, &same_second, NOW, false).len(),
        1
    );

    // Once a brand-new directory has been listed empty, it stops being due
    // even though it still has no stamp.
    let listed_empty: BTreeMap<String, DirScanRecord> = [(
        "brand-new".to_string(),
        DirScanRecord {
            stamp_millis: NOW,
            scanned_at_millis: NOW,
        },
    )]
    .into_iter()
    .collect();
    assert!(directories_to_scan(&view, &BTreeMap::new(), &listed_empty, NOW, false).is_empty());
}

/// A hard delete bumps nothing, so a quiet directory must be brought back by
/// the pending window — otherwise the second observation never happens and
/// the file stays on the device forever.
#[test]
fn l1_gate_reopens_a_directory_whose_delete_window_elapsed() {
    let stamps: BTreeMap<String, i64> = [("notes".to_string(), NOW - 5 * MINUTE)]
        .into_iter()
        .collect();
    let scanned: BTreeMap<String, DirScanRecord> = [(
        "notes".to_string(),
        DirScanRecord {
            stamp_millis: NOW - 5 * MINUTE,
            scanned_at_millis: NOW - 4 * MINUTE,
        },
    )]
    .into_iter()
    .collect();

    let mut waiting = local(vec![LocalFile::new("notes/a.md", 10)]);
    waiting
        .pending_deletions
        .insert("notes/a.md".into(), NOW - DELETE_CONFIRM_WINDOW_MS);
    assert_eq!(
        directories_to_scan(&waiting, &stamps, &scanned, NOW, false),
        vec!["notes"]
    );

    let mut early = local(vec![LocalFile::new("notes/a.md", 10)]);
    early
        .pending_deletions
        .insert("notes/a.md".into(), NOW - MINUTE);
    assert!(directories_to_scan(&early, &stamps, &scanned, NOW, false).is_empty());
}

#[test]
fn dir_of_handles_root_and_nesting() {
    assert_eq!(dir_of("a.md"), "");
    assert_eq!(dir_of("notes/a.md"), "notes");
    assert_eq!(dir_of("notes/2026/q4/a.md"), "notes/2026/q4");
}

/// `LastModified` has one-second resolution, so two devices that write the same
/// key within one second produce the *same* stamp with different bytes. Time
/// cannot tell them apart and `list` carries no content hash — the ETag is the
/// only witness. Without it the loser's edit vanished with no copy anywhere,
/// which is the one silent data loss this design must not have.
mod same_second {
    use super::*;

    fn view(dirty: bool, etag: Option<&str>) -> LocalView {
        let file = if dirty {
            LocalFile::new("notes/a.md", 100).dirty()
        } else {
            LocalFile::new("notes/a.md", 100)
        };
        let mut view = synced(local(vec![file]), "notes/a.md", NOW);
        if let Some(etag) = etag {
            view.remote_etags
                .insert("notes/a.md".into(), etag.to_string());
        }
        view
    }

    fn object(mtime: i64, etag: Option<&str>) -> RemoteObject {
        let mut object = RemoteObject::file("notes/a.md", mtime, 100);
        object.etag = etag.map(str::to_string);
        object
    }

    /// Someone else replaced the key in the same second: the remote wins, and
    /// the local bytes go to a conflict copy — that copy is the whole point.
    #[test]
    fn a_replaced_object_beats_a_dirty_local() {
        let plan = plan(
            &view(true, Some("\"left-by-me\"")),
            &RemoteListing::with_dirs([object(NOW, Some("\"left-by-them\""))], ["notes"]),
            &[],
            NOW,
        );
        assert_eq!(tags(&plan), vec!["download:conflict"]);
        let SyncAction::Download(download) = &plan.actions[0] else {
            panic!("expected a download")
        };
        assert!(
            download.backup.is_some(),
            "the losing bytes must be preserved"
        );
    }

    /// Same stamp, same ETag: nobody touched the object, so the local edit is
    /// what to publish. This is the common case (remote idle, local edited) and
    /// downloading over it would destroy user work on every save.
    #[test]
    fn an_untouched_object_still_loses_to_a_local_edit() {
        let plan = plan(
            &view(true, Some("\"same\"")),
            &RemoteListing::with_dirs([object(NOW, Some("\"same\""))], ["notes"]),
            &[],
            NOW,
        );
        assert_eq!(tags(&plan), vec!["upload:local-ahead"]);
    }

    #[test]
    fn matching_etag_handles_list_milliseconds_after_head_seconds() {
        let remote = RemoteListing::with_dirs([object(NOW + 885, Some("\"same\""))], ["notes"]);
        assert_eq!(
            tags(&plan(&view(false, Some("same")), &remote, &[], NOW)),
            Vec::<&str>::new()
        );
        assert_eq!(
            tags(&plan(&view(true, Some("same")), &remote, &[], NOW)),
            vec!["upload:local-ahead"]
        );
    }

    /// A clean local has nothing to lose, so the replacement is taken directly.
    #[test]
    fn a_clean_local_takes_the_replacement_without_a_copy() {
        let plan = plan(
            &view(false, Some("\"left-by-me\"")),
            &RemoteListing::with_dirs([object(NOW, Some("\"left-by-them\""))], ["notes"]),
            &[],
            NOW,
        );
        assert_eq!(tags(&plan), vec!["download:remote-new"]);
    }

    /// Rows written before the ETag column existed must keep the old behaviour
    /// rather than declaring every path replaced.
    #[test]
    fn a_missing_etag_baseline_falls_back_to_the_local_writer() {
        let plan = plan(
            &view(true, None),
            &RemoteListing::with_dirs([object(NOW, Some("\"left-by-them\""))], ["notes"]),
            &[],
            NOW,
        );
        assert_eq!(tags(&plan), vec!["upload:local-ahead"]);
    }
}
