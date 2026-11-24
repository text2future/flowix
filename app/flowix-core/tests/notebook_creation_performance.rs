use flowix_core::memo_file::{MemoFile, NotebookConfig};
use std::fs;

fn fixture(count: usize) -> (tempfile::TempDir, MemoFile, Vec<NotebookConfig>) {
    let dir = tempfile::tempdir().unwrap();
    let store = MemoFile::new(dir.path().join("config"));
    let notebooks: Vec<_> = (0..count)
        .map(|index| {
            let path = dir.path().join(format!("notebook-{index}"));
            fs::create_dir_all(&path).unwrap();
            NotebookConfig {
                id: format!("nb_{index}"),
                name: format!("Notebook {index}"),
                icon: None,
                path: path.to_string_lossy().into_owned(),
                is_default: index == 0,
                sort: index as i64 * 10,
                created_at: 1,
                updated_at: 1,
            }
        })
        .collect();
    store.write_notebook_configs(&notebooks).unwrap();
    for notebook in &notebooks {
        store
            .read_index_for_notebook_id(Some(&notebook.id))
            .unwrap();
    }
    (dir, store, notebooks)
}

#[test]
fn scoped_revision_preserves_cas_and_notebook_isolation() {
    let (_dir, store, notebooks) = fixture(2);
    let a = &notebooks[0].id;
    let b = &notebooks[1].id;
    assert!(store
        .read_note_content_revision_for_notebook(a, "new-note")
        .unwrap()
        .is_none());
    let first = store
        .commit_note_content_revision(a, "new-note", "hash-a", "first")
        .unwrap();
    let expected = store
        .read_note_content_revision_for_notebook(a, "new-note")
        .unwrap()
        .unwrap();
    assert_eq!(expected, first.state);
    assert!(store
        .read_note_content_revision_for_notebook(b, "new-note")
        .unwrap()
        .is_none());
    let next = store
        .commit_note_content_revision_if_current(a, "new-note", "hash-b", "next", Some(&expected))
        .unwrap()
        .unwrap();
    assert_eq!(next.state.revision, 2);
    assert!(store
        .commit_note_content_revision_if_current(a, "new-note", "stale", "late", Some(&expected))
        .unwrap()
        .is_none());
}

#[test]
fn scoped_revision_does_not_open_an_unrelated_broken_notebook() {
    let (_dir, store, notebooks) = fixture(2);
    let target = &notebooks[1].id;
    let expected = store
        .commit_note_content_revision(target, "note", "hash", "change")
        .unwrap();
    fs::write(
        std::path::Path::new(&notebooks[0].path).join(".flowix/notebook.db"),
        b"broken database",
    )
    .unwrap();
    assert_eq!(
        store
            .read_note_content_revision_for_notebook(target, "note")
            .unwrap(),
        Some(expected.state)
    );
    assert!(store
        .read_note_content_revision_for_notebook(target, "fresh")
        .unwrap()
        .is_none());
}
