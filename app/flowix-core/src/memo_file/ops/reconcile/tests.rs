use super::*;
use crate::memo_file::NotebookConfig;

fn notebook(id: &str, root: &Path) -> NotebookConfig {
    NotebookConfig {
        id: id.into(),
        name: id.into(),
        icon: None,
        path: format!("{}/", root.display()),
        is_default: false,
        sort: 0,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn moving_a_registered_child_notebook_keeps_its_identity_and_relative_index() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("人物档案");
    let source = root.join("文章");
    let nested = source.join("附录");
    let destination = root.join("图库");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(&destination).unwrap();
    let store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[
            notebook("parent", &root),
            notebook("article", &source),
            notebook("nested", &nested),
        ])
        .unwrap();
    fs::write(source.join("note.md"), "# 保留内容\n").unwrap();
    fs::write(nested.join("nested.md"), "# 附录\n").unwrap();
    store.refresh_note_path("parent", "文章/note.md").unwrap();
    store.refresh_note_path("article", "note.md").unwrap();
    store.refresh_note_path("nested", "nested.md").unwrap();
    let manifest_before = fs::read(source.join(".flowix/notebook.json")).unwrap();
    let target = destination.join("文章");

    store.rename_indexed_path(&source, &target).unwrap();

    assert!(!source.exists());
    assert_eq!(
        fs::read_to_string(target.join("note.md")).unwrap(),
        "# 保留内容\n"
    );
    assert_eq!(
        fs::read(target.join(".flowix/notebook.json")).unwrap(),
        manifest_before
    );
    assert_eq!(
        Path::new(&store.get_notebook_config_by_id("article").unwrap().path),
        target
    );
    assert_eq!(
        Path::new(&store.get_notebook_config_by_id("nested").unwrap().path),
        target.join("附录")
    );
    assert!(store
        .read_indexed_note_entry_by_path("article", "note.md")
        .unwrap()
        .is_some());
    assert!(store
        .read_indexed_note_entry_by_path("nested", "nested.md")
        .unwrap()
        .is_some());
    assert!(store
        .read_indexed_note_entry_by_path("parent", "图库/文章/note.md")
        .unwrap()
        .is_some());
    assert!(store
        .read_indexed_note_entry_by_path("parent", "文章/note.md")
        .unwrap()
        .is_none());
    assert!(store.notebook_db_path("article").unwrap().is_file());
}

#[test]
fn moving_an_ordinary_folder_also_relocates_notebooks_nested_inside_it() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("parent");
    let source = root.join("bundle");
    let nested = source.join("child");
    fs::create_dir_all(&nested).unwrap();
    let store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[notebook("parent", &root), notebook("child", &nested)])
        .unwrap();
    fs::write(nested.join("note.md"), "child content").unwrap();
    let target = root.join("moved");
    store.rename_indexed_path(&source, &target).unwrap();
    assert_eq!(
        Path::new(&store.get_notebook_config_by_id("child").unwrap().path),
        target.join("child")
    );
    assert_eq!(
        fs::read_to_string(target.join("child/note.md")).unwrap(),
        "child content"
    );
}

#[test]
fn occupied_destination_preserves_the_source_and_notebook_registration() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("parent");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(source.join("note.md"), "source").unwrap();
    fs::write(target.join("keep.md"), "keep").unwrap();
    let store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[notebook("parent", &root), notebook("child", &source)])
        .unwrap();
    assert!(store.rename_indexed_path(&source, &target).is_err());
    assert_eq!(
        Path::new(&store.get_notebook_config_by_id("child").unwrap().path),
        source
    );
    assert_eq!(
        fs::read_to_string(source.join("note.md")).unwrap(),
        "source"
    );
    assert_eq!(fs::read_to_string(target.join("keep.md")).unwrap(), "keep");
}

#[test]
fn registry_update_failure_does_not_move_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("parent");
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("note.md"), "keep").unwrap();
    let store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[notebook("parent", &root), notebook("child", &source)])
        .unwrap();
    store.refresh_note_path("parent", "source/note.md").unwrap();
    store.open_registry_db().unwrap().execute_batch(
        "CREATE TRIGGER reject_path_update BEFORE UPDATE OF path ON notebooks BEGIN SELECT RAISE(ABORT, 'test registry failure'); END;"
    ).unwrap();
    let target = root.join("target");
    assert!(store.rename_indexed_path(&source, &target).is_err());
    assert!(!target.exists());
    assert_eq!(fs::read_to_string(source.join("note.md")).unwrap(), "keep");
    assert_eq!(
        Path::new(&store.get_notebook_config_by_id("child").unwrap().path),
        source
    );
    assert!(store
        .read_indexed_note_entry_by_path("parent", "source/note.md")
        .unwrap()
        .is_some());
    assert!(store
        .read_indexed_note_entry_by_path("parent", "target/note.md")
        .unwrap()
        .is_none());
}
