use super::*;
use std::sync::{Arc, Barrier};

#[test]
fn creating_an_existing_file_preserves_its_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("note.md");
    let store = MemoFile::new(directory.path().join("config"));
    fs::write(&path, b"important content").unwrap();
    let error = store.create_file(&path, b"").unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(&path).unwrap(), b"important content");
}

#[test]
fn concurrent_creates_publish_exactly_one_complete_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("note.md");
    let barrier = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|index| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let content = format!("writer-{index}").repeat(100);
                barrier.wait();
                (atomic_create_bytes(&path, content.as_bytes()), content)
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        results.iter().filter(|(result, _)| result.is_ok()).count(),
        1
    );
    for (result, content) in results {
        match result {
            Ok(()) => assert_eq!(fs::read_to_string(&path).unwrap(), content),
            Err(error) => assert_eq!(error.kind(), io::ErrorKind::AlreadyExists),
        }
    }
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn rename_preserves_binary_content_without_overwriting_targets() {
    let directory = tempfile::tempdir().unwrap();
    let store = MemoFile::new(directory.path().join("config"));
    let source = directory.path().join("image.bin");
    let target = directory.path().join("renamed.bin");
    let occupied = directory.path().join("occupied.bin");
    let bytes = [0, 255, 128, 3, 0, 254];
    fs::write(&source, bytes).unwrap();
    fs::write(&occupied, b"keep target").unwrap();
    assert_eq!(
        store.rename_file(&source, &occupied).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(fs::read(&source).unwrap(), bytes);
    assert_eq!(fs::read(&occupied).unwrap(), b"keep target");
    store.rename_file(&source, &target).unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(&target).unwrap(), bytes);
}

#[test]
fn concurrent_renames_never_replace_the_winner() {
    let directory = tempfile::tempdir().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let target = directory.path().join("target.bin");
    let workers: Vec<_> = (0..2)
        .map(|index| {
            let source = directory.path().join(format!("source-{index}.bin"));
            let content = vec![index as u8, 255, 0];
            fs::write(&source, &content).unwrap();
            let target = target.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (rename_file_noclobber(&source, &target), source, content)
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        results
            .iter()
            .filter(|(result, _, _)| result.is_ok())
            .count(),
        1
    );
    for (result, source, content) in results {
        if result.is_ok() {
            assert!(!source.exists());
            assert_eq!(fs::read(&target).unwrap(), content);
        } else {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
            assert_eq!(fs::read(&source).unwrap(), content);
        }
    }
}

#[test]
fn failed_rename_keeps_source_and_does_not_create_target() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.bin");
    let target = directory.path().join("missing/target.bin");
    fs::write(&source, b"preserve").unwrap();
    assert!(rename_file_noclobber(&source, &target).is_err());
    assert_eq!(fs::read(&source).unwrap(), b"preserve");
    assert!(!target.exists());
}

#[test]
fn failed_atomic_replace_cleans_up_temporary_file() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("folder");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), b"existing").unwrap();
    assert!(atomic_write_bytes(&target, b"replacement").is_err());
    assert_eq!(fs::read(target.join("keep")).unwrap(), b"existing");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn external_cas_conflict_preserves_the_current_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("document.txt");
    let store = MemoFile::new(directory.path().join("config"));
    fs::write(&path, "disk").unwrap();
    for expected in ["stale", ""] {
        assert_eq!(
            store
                .write_file_if_matches(&path, "replacement", Some(expected))
                .unwrap(),
            FileWriteOutcome::Conflict {
                disk_content: "disk".to_string()
            }
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "disk");
    }
    assert_eq!(
        store
            .write_file_if_matches(&path, "next", Some("disk"))
            .unwrap(),
        FileWriteOutcome::Saved
    );
    assert_eq!(
        store
            .write_file_if_matches(&path, "unconditional", None)
            .unwrap(),
        FileWriteOutcome::Saved
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "unconditional");
}

#[test]
fn markdown_write_merges_independent_edits_and_keeps_overlaps_for_review() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("document.md");
    let store = MemoFile::new(directory.path().join("config"));
    let base = "# Notes\nleft: old\nright: old\n";
    fs::write(&path, "# Notes\nleft: old\nright: disk\n").unwrap();
    assert_eq!(
        store
            .write_markdown_merging(&path, "# Notes\nleft: editor\nright: old\n", Some(base))
            .unwrap(),
        MergedFileWriteOutcome::Saved {
            content: "# Notes\nleft: editor\nright: disk\n".into(),
            merged: true,
        },
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "# Notes\nleft: editor\nright: disk\n"
    );

    let disk = "# Notes\nleft: disk again\nright: disk\n";
    fs::write(&path, disk).unwrap();
    assert_eq!(
        store
            .write_markdown_merging(
                &path,
                "# Notes\nleft: editor again\nright: disk\n",
                Some("# Notes\nleft: editor\nright: disk\n")
            )
            .unwrap(),
        MergedFileWriteOutcome::Conflict {
            disk_content: disk.into()
        },
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), disk);
}

#[test]
fn external_cas_does_not_recreate_a_deleted_document() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("missing.txt");
    let store = MemoFile::new(directory.path().join("config"));
    assert_eq!(
        store
            .write_file_if_matches(&path, "new", Some("old"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotFound
    );
    assert!(!path.exists());
}

#[test]
fn separate_stores_cannot_both_save_from_the_same_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("document.txt");
    let config = directory.path().join("config");
    fs::write(&path, "original").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = ["first", "second"]
        .into_iter()
        .map(|content| {
            let store = MemoFile::new(config.clone());
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (
                    store
                        .write_file_if_matches(&path, content, Some("original"))
                        .unwrap(),
                    content,
                )
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        results
            .iter()
            .filter(|(outcome, _)| *outcome == FileWriteOutcome::Saved)
            .count(),
        1
    );
    let winner = results
        .iter()
        .find(|(outcome, _)| *outcome == FileWriteOutcome::Saved)
        .unwrap()
        .1;
    assert_eq!(fs::read_to_string(&path).unwrap(), winner);
    assert!(results.iter().any(|(outcome, _)| matches!(outcome, FileWriteOutcome::Conflict { disk_content } if disk_content == winner)));
}

#[cfg(unix)]
#[test]
fn atomic_replace_preserves_existing_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("script.sh");
    fs::write(&path, "old").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
    atomic_write_bytes(&path, b"new").unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o750
    );
}

#[cfg(unix)]
#[test]
fn create_and_rename_do_not_follow_a_dangling_target_symlink() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let target = directory.path().join("target");
    let missing = directory.path().join("missing");
    fs::write(&source, b"source").unwrap();
    symlink(&missing, &target).unwrap();
    assert_eq!(
        atomic_create_bytes(&target, b"new").unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        rename_file_noclobber(&source, &target).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert!(fs::symlink_metadata(&target)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(&source).unwrap(), b"source");
    assert!(!missing.exists());
}
