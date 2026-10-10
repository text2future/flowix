use super::*;
use flowix_core::memo_file::NotebookConfig;

fn fixture() -> (tempfile::TempDir, MemoFile) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = MemoFile::new(directory.path().join("config"));
    let notebooks = ["first", "second"]
        .into_iter()
        .map(|id| {
            let root = directory.path().join(id);
            fs::create_dir(&root).unwrap();
            NotebookConfig {
                id: id.to_string(),
                name: id.to_string(),
                icon: None,
                path: root.to_string_lossy().into_owned(),
                is_default: id == "first",
                sort: 0,
                created_at: 1,
                updated_at: 1,
            }
        })
        .collect::<Vec<_>>();
    store.write_notebook_configs(&notebooks).unwrap();
    store.set_current_notebook(Some("first".to_string()));
    (directory, store)
}

#[test]
fn explicit_destination_does_not_switch_current_notebook() {
    let (directory, store) = fixture();
    let saved = save(&store, Some("second"), "data.bin", &mut &b"\0\xff"[..]).unwrap();
    assert!(saved.starts_with(dunce::canonicalize(directory.path().join("second")).unwrap()));
    assert_eq!(store.current_notebook_id_value().as_deref(), Some("first"));
    assert_eq!(fs::read(saved).unwrap(), b"\0\xff");
    assert!(!directory.path().join("first/attachments").exists());
}

#[test]
fn note_owner_resolves_notebook_from_absolute_path() {
    let (directory, store) = fixture();
    let created = flowix_core::MemoService::new(&store)
        .create_memo_named_with_tag_in_directory(Some("second"), None, "Untitled", "# Note\nbody\n", None)
        .unwrap();
    let note = directory.path().join("second").join(&created.memo.relative_path);
    assert_eq!(
        resolve_note_owner(&store, None, Some(note.to_str().unwrap())).unwrap(),
        ("second".to_string(), Some("Untitled.md".to_string()))
    );
    assert_eq!(store.current_notebook_id_value().as_deref(), Some("first"));
    assert!(resolve_note_owner(&store, Some("first"), Some(note.to_str().unwrap())).is_err());
}

#[test]
fn missing_or_unknown_owner_never_falls_back_to_current_notebook() {
    let (_directory, store) = fixture();
    assert!(resolve_note_owner(&store, None, None).is_err());
    assert!(resolve_note_owner(&store, Some(""), None).is_err());
    assert!(resolve_note_owner(&store, Some("first"), Some("missing.md")).is_err());
    assert!(resolve_note_owner(&store, Some("missing"), None).is_err());
    assert_eq!(
        resolve_note_owner(&store, Some("second"), None).unwrap(),
        ("second".to_string(), None)
    );
}

#[test]
fn owned_save_validates_identity_before_creating_attachments() {
    let (directory, store) = fixture();
    assert!(save_for_owner(&store, None, None, "data", &mut &b"data"[..]).is_err());
    let created = flowix_core::MemoService::new(&store)
        .create_memo_named_with_tag_in_directory(Some("second"), None, "Untitled", "# Owner\nbody\n", None)
        .unwrap();
    let note = directory.path().join("second").join(&created.memo.relative_path);
    assert!(save_for_owner(
        &store,
        Some("first"),
        Some(note.to_str().unwrap()),
        "data",
        &mut &b"data"[..]
    )
    .is_err());
    assert!(!directory.path().join("first/attachments").exists());
    let saved = save_for_owner(
        &store,
        None,
        Some(note.to_str().unwrap()),
        "data",
        &mut &b"data"[..],
    )
    .unwrap();
    assert!(saved.starts_with(dunce::canonicalize(directory.path().join("second")).unwrap()));
    assert_eq!(fs::read(saved).unwrap(), b"data");
}

#[test]
fn invalid_notebook_does_not_fall_back_or_create_files() {
    let (directory, store) = fixture();
    assert!(save(&store, Some("missing"), "data", &mut &b"data"[..]).is_err());
    assert!(!directory.path().join("first/attachments").exists());
    assert_eq!(store.current_notebook_id_value().as_deref(), Some("first"));
}

#[test]
fn omitted_notebook_uses_current_without_mutation() {
    let (directory, store) = fixture();
    let saved = save(&store, None, "data", &mut &b"data"[..]).unwrap();
    assert!(saved.starts_with(dunce::canonicalize(directory.path().join("first")).unwrap()));
}

#[test]
fn repeated_names_preserve_previous_files() {
    let (_directory, store) = fixture();
    let first = save(&store, None, "note.txt", &mut &b"first"[..]).unwrap();
    let second = save(&store, None, "note.txt", &mut &b"second"[..]).unwrap();
    assert_ne!(first, second);
    assert_eq!(fs::read(first).unwrap(), b"first");
    assert_eq!(fs::read(second).unwrap(), b"second");
}

#[test]
fn concurrent_imports_have_distinct_complete_targets() {
    let (directory, _store) = fixture();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|index| {
            let store = MemoFile::new(directory.path().join("config"));
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let content = format!("content-{index}");
                barrier.wait();
                let path =
                    save(&store, Some("second"), "same.txt", &mut content.as_bytes()).unwrap();
                (path, content)
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    let paths: std::collections::HashSet<_> = results.iter().map(|(path, _)| path).collect();
    assert_eq!(paths.len(), 4);
    for (path, content) in results {
        assert_eq!(fs::read_to_string(path).unwrap(), content);
    }
}

#[test]
fn failed_reader_leaves_no_partial_attachment() {
    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("read failed"))
        }
    }
    let (directory, store) = fixture();
    assert!(save(&store, None, "partial", &mut Broken).is_err());
    assert_eq!(
        fs::read_dir(directory.path().join("first/attachments"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn native_stream_limits_are_checked_without_silently_truncating() {
    let mut output = Vec::new();
    assert!(copy_bounded(&mut &b"abcd"[..], &mut output, 3).is_err());
    assert!(output.len() <= 4);
    let mut exact = Vec::new();
    assert_eq!(copy_bounded(&mut &b"abc"[..], &mut exact, 3).unwrap(), 3);
    assert_eq!(exact, b"abc");
}

#[test]
fn malformed_base64_stream_preserves_existing_attachment() {
    let (directory, store) = fixture();
    let original = save(&store, None, "data.bin", &mut &b"original"[..]).unwrap();
    let input = format!("{}!", "YWJj".repeat(4096));
    let mut decoder = super::super::base64_input::reader(&input).unwrap();
    assert!(save(&store, None, "data.bin", &mut decoder).is_err());
    assert_eq!(fs::read(original).unwrap(), b"original");
    assert_eq!(
        fs::read_dir(directory.path().join("first/attachments"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn names_are_portable_and_cannot_escape_directory() {
    for (input, expected) in [
        ("../../note.txt", "note.txt"),
        ("C:\\folder\\note.txt", "note.txt"),
        ("..", "attachment"),
        ("CON.txt", "_CON.txt"),
        ("LPT1", "_LPT1"),
        ("a:b?.txt", "a_b_.txt"),
    ] {
        assert_eq!(safe_name(input), expected);
    }
}

#[test]
fn attachment_access_is_not_tied_to_current_notebook() {
    let (directory, store) = fixture();
    let saved = save(&store, Some("second"), "data", &mut &b"data"[..]).unwrap();
    assert_eq!(authorized_attachment(&store, &saved).unwrap(), saved);
    let ordinary = directory.path().join("second/not-attachment.txt");
    fs::write(&ordinary, "private").unwrap();
    assert!(authorized_attachment(&store, &ordinary).is_err());
}

#[cfg(unix)]
#[test]
fn escaped_attachment_directory_is_rejected() {
    let (directory, store) = fixture();
    let outside = directory.path().join("outside");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, directory.path().join("first/attachments")).unwrap();
    assert!(save(&store, None, "data", &mut &b"data"[..]).is_err());
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn dangling_name_collision_is_preserved() {
    let (directory, store) = fixture();
    let attachments = directory.path().join("first/attachments");
    fs::create_dir(&attachments).unwrap();
    std::os::unix::fs::symlink(
        directory.path().join("missing"),
        attachments.join("data.txt"),
    )
    .unwrap();
    let saved = save(&store, None, "data.txt", &mut &b"data"[..]).unwrap();
    assert_eq!(saved.file_name().unwrap(), "data_1.txt");
    assert!(fs::symlink_metadata(attachments.join("data.txt"))
        .unwrap()
        .file_type()
        .is_symlink());
}
