//! Executable convergence check for the reconciliation rules.
//!
//! The decision table proves each branch in isolation. This drives two devices
//! and one store through a sequence of passes, applying every plan the way the
//! real executor must, and then asks whether the system settles. Rule-level
//! tests cannot catch two branches that fight each other — upload, download,
//! upload again — and that class of bug is the expensive one in a
//! last-writer-wins design.
//!
//! Nothing here touches the network or the filesystem; the store and the
//! devices are plain maps. `SECOND` per write mimics a server-generated
//! `LastModified`, so ordering is never ambiguous.

use std::collections::{BTreeMap, BTreeSet};

use super::*;

const SECOND: i64 = 1_000;
const START: i64 = 1_795_300_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stored {
    bytes: Vec<u8>,
    mtime: i64,
    tombstone: bool,
}

impl Stored {
    fn to_remote(&self, path: &str) -> RemoteObject {
        let mut object = RemoteObject::file(path, self.mtime, self.bytes.len() as u64);
        object.tombstone = self.tombstone;
        object
    }
}

struct Store {
    objects: BTreeMap<String, Stored>,
    stamps: BTreeMap<String, i64>,
    now: i64,
    /// COS lists are eventually consistent: a write stays invisible this long.
    list_lag: i64,
}

impl Store {
    fn new() -> Self {
        Self {
            objects: BTreeMap::new(),
            stamps: BTreeMap::new(),
            now: START,
            list_lag: 0,
        }
    }

    fn advance(&mut self, millis: i64) {
        self.now += millis;
    }

    /// Server-assigned `LastModified`: always later than the previous write, and
    /// the directory stamp moves with it, exactly like a real writer.
    fn write(&mut self, path: &str, stored: Stored) -> i64 {
        let mtime = self.now + SECOND;
        self.now = mtime;
        self.stamps.insert(dir_of(path).to_string(), mtime);
        self.objects
            .insert(path.to_string(), Stored { mtime, ..stored });
        mtime
    }

    fn put(&mut self, path: &str, bytes: &[u8]) -> i64 {
        self.write(
            path,
            Stored {
                bytes: bytes.to_vec(),
                mtime: 0,
                tombstone: false,
            },
        )
    }

    fn tombstone(&mut self, path: &str) -> i64 {
        self.write(
            path,
            Stored {
                bytes: Vec::new(),
                mtime: 0,
                tombstone: true,
            },
        )
    }

    /// A key that disappears without a tombstone, as a lifecycle rule or a
    /// misbehaving client would leave it. The stamp still moves, so devices do
    /// notice the directory — they just get no positive evidence.
    fn hard_delete(&mut self, path: &str) {
        self.objects.remove(path);
        let now = self.now + SECOND;
        self.now = now;
        self.stamps.insert(dir_of(path).to_string(), now);
    }

    fn visible(&self, path: &str) -> Option<&Stored> {
        self.objects
            .get(path)
            .filter(|stored| stored.mtime + self.list_lag <= self.now)
    }

    fn files(&self) -> BTreeMap<String, Vec<u8>> {
        self.objects
            .iter()
            .filter(|(_, stored)| !stored.tombstone)
            .map(|(path, stored)| (path.clone(), stored.bytes.clone()))
            .collect()
    }

    fn listing(&self, device: &mut Device) -> RemoteListing {
        let due = directories_to_scan(
            &device.view(),
            &self.stamps,
            &device.scanned,
            device.force_sweep,
        );
        let mut remote = RemoteListing::default();
        for dir in due {
            let stamp = self.stamps.get(&dir).copied().unwrap_or(self.now);
            for (path, stored) in &self.objects {
                if dir_of(path) != dir || stored.mtime + self.list_lag > self.now {
                    continue;
                }
                remote.observe(stored.to_remote(path));
            }
            // Registered only now, after every key under the prefix was read:
            // that is what turns "absent" into evidence.
            remote.observed_dirs.insert(dir.clone());
            device.scanned.insert(
                dir,
                DirScanRecord {
                    stamp_millis: stamp,
                    scanned_at_millis: self.now,
                },
            );
        }
        remote
    }
}

struct Device {
    name: &'static str,
    files: BTreeMap<String, Vec<u8>>,
    dirty: BTreeSet<String>,
    baseline: BTreeMap<String, i64>,
    pending: BTreeMap<String, i64>,
    scanned: BTreeMap<String, DirScanRecord>,
    allow_deletes: bool,
    force_sweep: bool,
    conflicts: Vec<String>,
}

impl Device {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            files: BTreeMap::new(),
            dirty: BTreeSet::new(),
            baseline: BTreeMap::new(),
            pending: BTreeMap::new(),
            scanned: BTreeMap::new(),
            allow_deletes: true,
            force_sweep: false,
            conflicts: Vec::new(),
        }
    }

    fn view(&self) -> LocalView {
        LocalView {
            files: self
                .files
                .iter()
                .map(|(path, bytes)| LocalFile {
                    path: path.clone(),
                    size: bytes.len() as u64,
                    content_hash: None,
                    dirty: self.dirty.contains(path),
                })
                .collect(),
            last_synced_at: self.baseline.clone(),
            // Every write here lands on its own second (see `Store::write`), so
            // the same-second replacement path is unreachable by construction.
            // The rule itself is covered by the table test in
            // `reconcile_tests::a_same_second_replacement_*`.
            remote_etags: BTreeMap::new(),
            pending_deletions: self.pending.clone(),
            device_id: self.name.to_string(),
            allow_deletes: self.allow_deletes,
        }
    }

    fn edit(&mut self, path: &str, bytes: &[u8]) {
        self.files.insert(path.to_string(), bytes.to_vec());
        self.dirty.insert(path.to_string());
    }

    fn remove(&mut self, path: &str) {
        self.files.remove(path);
        self.baseline.remove(path);
        self.dirty.remove(path);
    }

    /// The user deleted the file on disk.
    ///
    /// The baseline deliberately survives: on a real device the row lives in
    /// SQLite and only the pass may drop it, which is exactly what makes the
    /// disappearance discoverable instead of looking like a brand new remote
    /// file worth downloading.
    fn delete_on_disk(&mut self, path: &str) {
        self.files.remove(path);
        self.dirty.remove(path);
    }

    fn has(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }
}

/// One pass, including the re-reconcile a `probe` demands.
fn pass(device: &mut Device, store: &mut Store) -> usize {
    let mut applied = 0;
    let mut evidence: BTreeMap<String, Option<Stored>> = BTreeMap::new();
    for _ in 0..3 {
        let mut remote = store.listing(device);
        for (path, stored) in &evidence {
            match stored {
                Some(stored) => remote.observe(stored.to_remote(path)),
                None => remote.mark_missing(path),
            }
        }
        let mut plan = reconcile(&device.view(), &remote, store.now);
        // The production planner checks an exact key after a directory listing
        // reports it missing. Model that strong HEAD separately from the
        // eventually consistent listing so the convergence simulation matches
        // the pass orchestrator.
        let missing_from_list: Vec<String> = plan
            .actions
            .iter()
            .filter_map(|action| match action {
                SyncAction::DeleteLocal(item)
                    if !remote.missing_keys.contains(&item.path)
                        && matches!(remote.state_for(&item.path), RemoteState::Missing) =>
                {
                    Some(item.path.clone())
                }
                _ => None,
            })
            .collect();
        for path in missing_from_list {
            match store.objects.get(&path) {
                Some(stored) => remote.observe(stored.to_remote(&path)),
                None => remote.mark_missing(&path),
            }
        }
        if !remote.missing_keys.is_empty() || !remote.observed.is_empty() {
            plan = reconcile(&device.view(), &remote, store.now);
        }
        device.pending = plan.pending_deletions.clone();

        let mut probes = Vec::new();
        for action in &plan.actions {
            match action {
                SyncAction::Probe(probe) => probes.push(probe.path.clone()),
                action => {
                    apply(device, store, action);
                    applied += 1;
                }
            }
        }
        if probes.is_empty() {
            return applied;
        }
        evidence.clear();
        for path in probes {
            evidence.insert(path.clone(), store.visible(&path).cloned());
        }
        // The HEAD itself costs a round trip, and its answer is only as fresh
        // as the moment it was asked.
        store.advance(SECOND);
    }
    applied
}

fn apply(device: &mut Device, store: &mut Store, action: &SyncAction) {
    match action {
        SyncAction::Upload(upload) => {
            let bytes = device
                .files
                .get(&upload.path)
                .cloned()
                .expect("upload needs local bytes");
            let mtime = store.put(&upload.path, &bytes);
            device.baseline.insert(upload.path.clone(), mtime);
            device.dirty.remove(&upload.path);
        }
        SyncAction::Download(download) => {
            let stored = store
                .objects
                .get(&download.path)
                .cloned()
                .expect("download needs an object");
            if download.backup.is_some() {
                device.conflicts.push(download.path.clone());
            }
            device.files.insert(download.path.clone(), stored.bytes);
            device.dirty.remove(&download.path);
            device.baseline.insert(download.path.clone(), stored.mtime);
        }
        SyncAction::DeleteLocal(delete) => device.remove(&delete.path),
        SyncAction::WriteTombstone(tombstone) => {
            // The file is already gone here; the marker is what makes every
            // other device delete it too.
            store.tombstone(&tombstone.path);
            device.remove(&tombstone.path);
        }
        SyncAction::Probe(_) | SyncAction::Defer(_) => {}
    }
}

/// Alternates passes between two devices, as two machines on the same poll
/// interval would. Returns how many IO actions the pair performed.
fn sync(a: &mut Device, b: &mut Device, store: &mut Store, rounds: usize) -> usize {
    let mut total = 0;
    for _ in 0..rounds {
        total += pass(a, store);
        total += pass(b, store);
        store.advance(SECOND);
    }
    total
}

#[test]
fn a_new_note_reaches_the_second_device_and_the_pair_goes_quiet() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");
    let mut b = Device::new("ipad-b");

    a.edit("notes/welcome.md", b"hello");
    assert!(sync(&mut a, &mut b, &mut store, 4) >= 2);

    assert_eq!(
        b.files.get("notes/welcome.md").map(Vec::as_slice),
        Some(&b"hello"[..])
    );
    assert_eq!(store.files(), a.files);
    assert_eq!(store.files(), b.files);
    assert_eq!(
        sync(&mut a, &mut b, &mut store, 3),
        0,
        "a settled pair must be quiet"
    );
    assert!(a.conflicts.is_empty() && b.conflicts.is_empty());
}

#[test]
fn a_directory_the_store_has_never_seen_can_still_receive_files() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");

    // No stamp exists for this prefix, and none ever will until something is
    // written. A stamp-only gate would read the directory as "unknown" forever
    // and never upload.
    a.edit("projects/2026/q4/plan.md", b"plan");
    assert!(pass(&mut a, &mut store) >= 1);
    assert_eq!(
        store
            .files()
            .get("projects/2026/q4/plan.md")
            .map(Vec::as_slice),
        Some(&b"plan"[..])
    );
    assert!(
        a.pending.is_empty(),
        "an absent key in a new folder is not a deletion"
    );
}

#[test]
fn concurrent_edits_converge_and_the_loser_keeps_a_conflict_copy() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");
    let mut b = Device::new("ipad-b");

    a.edit("notes/plan.md", b"v1");
    sync(&mut a, &mut b, &mut store, 3);
    assert_eq!(b.files["notes/plan.md"], b"v1");

    // Both edit while offline; a syncs first, so its write carries the later
    // LastModified.
    a.edit("notes/plan.md", b"from-a");
    b.edit("notes/plan.md", b"from-b-with-a-different-length");
    pass(&mut a, &mut store);
    pass(&mut b, &mut store);

    assert_eq!(b.files["notes/plan.md"], b"from-a", "the later writer wins");
    assert_eq!(
        b.conflicts,
        vec!["notes/plan.md"],
        "the loser's bytes are kept aside"
    );
    assert_eq!(sync(&mut a, &mut b, &mut store, 3), 0);
    assert_eq!(store.files()["notes/plan.md"], b"from-a");
    assert_eq!(a.files, b.files);
}

#[test]
fn an_unsynced_edit_survives_a_deletion_from_another_device() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");
    let mut b = Device::new("ipad-b");

    a.edit("notes/plan.md", b"v1");
    sync(&mut a, &mut b, &mut store, 3);

    // a deletes it the way §5 prescribes, then b edits without having synced.
    store.tombstone("notes/plan.md");
    a.remove("notes/plan.md");
    b.edit("notes/plan.md", b"work-in-progress");

    assert!(pass(&mut b, &mut store) >= 1);
    assert_eq!(
        store.files()["notes/plan.md"],
        b"work-in-progress",
        "a tombstone never destroys an unsynced edit"
    );

    assert!(
        pass(&mut a, &mut store) >= 1,
        "the deleting device learns the file is back"
    );
    assert_eq!(a.files["notes/plan.md"], b"work-in-progress");
    assert!(a.conflicts.is_empty(), "a resurrect is not a conflict");
}

#[test]
fn a_tombstone_deletes_the_other_copy_on_the_first_observation() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");
    let mut b = Device::new("ipad-b");

    a.edit("notes/plan.md", b"v1");
    sync(&mut a, &mut b, &mut store, 3);
    assert!(b.has("notes/plan.md"));

    store.tombstone("notes/plan.md");
    a.remove("notes/plan.md");
    assert!(pass(&mut b, &mut store) >= 1);

    assert!(!b.has("notes/plan.md"));
    assert!(b.pending.is_empty());
    // One pass is enough: a tombstone is positive evidence, not an absence.
    assert_eq!(pass(&mut b, &mut store), 0);
}

#[test]
fn a_key_that_vanishes_without_a_tombstone_is_deleted_immediately() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");
    let mut b = Device::new("ipad-b");

    a.edit("notes/plan.md", b"v1");
    sync(&mut a, &mut b, &mut store, 3);

    store.hard_delete("notes/plan.md");
    pass(&mut b, &mut store);
    assert!(!b.has("notes/plan.md"));
    assert!(b.pending.is_empty());
}

/// Deleting a note on this device while offline must not resurrect it. Without
/// a tombstone the cloud copy is indistinguishable from a file this device has
/// never seen, so the pass would download it back.
#[test]
fn a_local_deletion_propagates_instead_of_downloading_the_file_back() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");
    let mut b = Device::new("ipad-b");

    a.edit("notes/plan.md", b"v1");
    sync(&mut a, &mut b, &mut store, 3);
    assert!(b.has("notes/plan.md"));

    // Offline: the file is gone, no request was made.
    a.delete_on_disk("notes/plan.md");

    pass(&mut a, &mut store);
    assert!(
        !a.has("notes/plan.md"),
        "the first pass must not bring it back"
    );
    assert!(
        store.objects["notes/plan.md"].tombstone,
        "the confirmed deletion becomes a tombstone",
    );
    assert!(a.pending.is_empty());

    // Positive evidence, so the other device needs no window.
    pass(&mut b, &mut store);
    assert!(!b.has("notes/plan.md"));
    assert_eq!(
        sync(&mut a, &mut b, &mut store, 3),
        0,
        "and the pair goes quiet"
    );
    assert!(a.conflicts.is_empty() && b.conflicts.is_empty());
}

/// A rename looks like a delete plus a create. It has to settle with the old
/// path gone, not with both paths present.
#[test]
fn a_rename_settles_without_leaving_the_old_path_behind() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");
    let mut b = Device::new("ipad-b");

    a.edit("notes/old.md", b"v1");
    sync(&mut a, &mut b, &mut store, 3);

    a.delete_on_disk("notes/old.md");
    a.edit("notes/new.md", b"v1");
    pass(&mut a, &mut store);

    assert!(store.files().contains_key("notes/new.md"));
    assert!(
        !store.files().contains_key("notes/old.md"),
        "the old path is tombstoned"
    );

    sync(&mut a, &mut b, &mut store, 3);
    assert!(b.has("notes/new.md"));
    assert!(!b.has("notes/old.md"), "no duplicate on the other device");
    assert!(a.conflicts.is_empty() && b.conflicts.is_empty());
}

#[test]
fn an_eventually_consistent_listing_is_verified_by_head() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");
    let mut b = Device::new("ipad-b");

    a.edit("notes/plan.md", b"v1");
    sync(&mut a, &mut b, &mut store, 3);

    // COS: the write is durable but invisible to list for a few seconds.
    store.list_lag = 10 * SECOND;
    store.put("notes/plan.md", b"v2-from-elsewhere");

    pass(&mut b, &mut store);
    assert_eq!(b.files["notes/plan.md"], b"v2-from-elsewhere");
    assert!(b.pending.is_empty());
}

#[test]
fn the_grace_window_never_deletes_a_local_library() {
    let mut store = Store::new();
    let mut a = Device::new("mac-a");
    a.allow_deletes = false;

    // A device that has synced before, pointed at an empty bucket: without the
    // grace window every path would look deleted.
    for index in 0..20 {
        let path = format!("notes/{index}.md");
        a.edit(&path, b"x");
        a.baseline.insert(path.clone(), START - SECOND);
        a.dirty.remove(&path);
    }

    for _ in 0..3 {
        pass(&mut a, &mut store);
        store.advance(60 * SECOND);
    }
    assert_eq!(a.files.len(), 20, "grace must not delete anything");
    assert!(
        a.pending.is_empty(),
        "and it must not start a window either"
    );
}
