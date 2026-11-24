//! `note_index` 的回归测试。
//!
//! 拆成独立文件不是为了绕过行数上限：这个模块的测试要造真实 SQLite 文件、
//! 真实 notebook 注册表，和索引实现本身是两种读法。放一起时，改一个查询要在
//! 700 行测试里翻；分开后两边都只看自己那一半。
//!
//! 断言的都是外部可观察的行为（哪些笔记能被搜到、排序键怎么变、重建后的行数），
//! 不涉及私有函数调用形态。

use super::*;
use crate::memo_file::NotebookConfig;

fn background_fixture() -> (tempfile::TempDir, MemoFile, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(&root).unwrap();
    let memo = MemoFile::new(temp.path().join("config"));
    memo.initialize_current_registry_storage().unwrap();
    memo.write_notebook_configs(&[NotebookConfig {
        id: "background".into(),
        name: "Background".into(),
        icon: None,
        path: root.to_string_lossy().into_owned(),
        is_default: true,
        sort: 0,
        created_at: 0,
        updated_at: 0,
    }])
    .unwrap();
    (temp, memo, root)
}

#[test]
fn table_database_notes_survive_reconciliation_without_exposing_internals() {
    let (_temp, memo, root) = background_fixture();
    let path = memo
        .create_note_by_path(
            "background",
            Some(".flowix/database/col_test"),
            "Table note",
            "hello",
        )
        .unwrap();
    assert_eq!(path, ".flowix/database/col_test/Table note.md");
    fs::create_dir_all(root.join(".flowix/versions")).unwrap();
    fs::write(root.join(".flowix/versions/secret.md"), "internal").unwrap();
    fs::create_dir_all(root.join("nested/.flowix/database/col_test")).unwrap();
    fs::write(
        root.join("nested/.flowix/database/col_test/ignored.md"),
        "internal",
    )
    .unwrap();
    memo.reconcile_note_index("background").unwrap();
    assert_eq!(
        memo.list_note_paths_from_disk("background").unwrap(),
        vec![path.clone()]
    );
    let conn = memo.open_note_index_connection("background").unwrap();
    let paths: Vec<String> = conn
        .prepare("SELECT relative_path FROM notes")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(paths, vec![path]);
    assert!(memo
        .create_note_by_path("background", Some(".flowix/versions"), "bad", "")
        .is_err());
}

#[cfg(unix)]
#[test]
fn table_database_rejects_symlinked_directories() {
    let (_temp, memo, root) = background_fixture();
    fs::create_dir_all(root.join(".flowix/versions")).unwrap();
    fs::write(root.join(".flowix/versions/secret.md"), "internal").unwrap();
    std::os::unix::fs::symlink(root.join(".flowix/versions"), root.join(".flowix/database"))
        .unwrap();
    assert!(memo
        .create_note_by_path("background", Some(".flowix/database/col_test"), "bad", "")
        .is_err());
    assert!(memo
        .refresh_note_path("background", ".flowix/database/secret.md")
        .is_err());
    assert!(memo
        .list_note_paths_from_disk("background")
        .unwrap()
        .is_empty());
}

#[test]
fn tree_metadata_reads_only_requested_paths_in_bounded_batches() {
    let (_temp, memo, root) = background_fixture();
    fs::write(root.join("a.md"), "original body").unwrap();
    memo.reconcile_note_index("background").unwrap();
    let conn = memo.open_note_index_connection("background").unwrap();
    // A malformed field unrelated to tree rows must not break this query.
    conn.execute("UPDATE notes SET properties_json='invalid', favorited=1, icon='star', colors_json='[\"red\"]' WHERE relative_path='a.md'", []).unwrap();
    conn.execute("INSERT INTO notes SELECT 'nested/a.md', size_bytes, modified_ns, content_hash, title, preview, thumbnail, properties_json, indexed_at, created_at, updated_at, favorited, icon, colors_json, filename, filename_lower, tags, todos, agents FROM notes WHERE relative_path='a.md'", []).unwrap();
    fs::remove_file(root.join("a.md")).unwrap();
    let mut paths: Vec<String> = (0..650).map(|i| format!("missing-{i}.md")).collect();
    paths.push("a.md".into());
    paths.push("quote'%_?.md".into());
    let result = memo
        .read_note_tree_metadata_for_paths("background", &paths)
        .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].relative_path, "a.md");
    assert!(result[0].favorited);
    assert_eq!(result[0].icon.as_deref(), Some("star"));
    assert_eq!(result[0].colors, vec![NoteColor::Red]);
}

#[test]
fn note_refresh_can_reuse_a_watcher_content_snapshot() {
    let (_temp, memo, root) = background_fixture();
    let snapshot = "body read by the watcher\nsecond line";
    fs::write(root.join("snapshot.md"), "previous body").unwrap();
    memo.reconcile_note_index("background").unwrap();
    fs::write(root.join("snapshot.md"), snapshot).unwrap();

    memo.refresh_note_path_with_content("background", "snapshot.md", snapshot)
        .unwrap();

    let entries = memo.read_note_entries("background").unwrap();
    let entry = entries
        .iter()
        .find(|entry| entry.relative_path == "snapshot.md")
        .unwrap();
    assert_eq!(entry.preview, "body read by the watcher");
}

#[test]
fn schema_fast_path_opens_while_another_connection_holds_the_writer_lock() {
    let (_temp, memo, _root) = background_fixture();
    let writer = memo.open_note_index_connection("background").unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    // Authoritative warm schema requires no CREATE/INSERT operations.
    let reader = memo.open_note_index_connection("background").unwrap();
    assert!(note_schema_is_current(&reader, "background").unwrap());
    writer.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn schema_fast_path_checks_missing_objects_and_replaced_database() {
    let (_temp, memo, _root) = background_fixture();
    let conn = memo.open_note_index_connection("background").unwrap();
    conn.execute_batch("DROP TABLE note_content_revisions")
        .unwrap();
    assert!(!note_schema_is_current(&conn, "background").unwrap());
    drop(conn);
    assert!(note_schema_is_current(
        &memo.open_note_index_connection("background").unwrap(),
        "background"
    )
    .unwrap());
    let path = memo.notebook_db_path("background").unwrap();
    fs::remove_file(path).unwrap();
    // A newly opened file must initialize even in the same process.
    assert!(note_schema_is_current(
        &memo.open_note_index_connection("background").unwrap(),
        "background"
    )
    .unwrap());
}

#[test]
fn schema_fast_path_rejects_wrong_notebook_and_version() {
    let (_temp, memo, _root) = background_fixture();
    let conn = memo.open_note_index_connection("background").unwrap();
    assert!(note_schema_is_current(&conn, "another").is_err());
    conn.execute(
        "UPDATE note_index_meta SET value='999' WHERE key='schema_version'",
        [],
    )
    .unwrap();
    assert!(memo.open_note_index_connection("background").is_err());
    let version: String = conn
        .query_row(
            "SELECT value FROM note_index_meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, "999");
}

#[test]
fn note_page_reads_projection_without_repairing_or_opening_markdown() {
    let (_temp, memo, root) = background_fixture();
    fs::write(root.join("a.md"), "# Indexed\nOriginal body").unwrap();
    memo.reconcile_note_index("background").unwrap();
    let before = memo
        .read_indexed_note_entry_by_path("background", "a.md")
        .unwrap()
        .unwrap();
    // The watcher has not processed this external change yet. A list query
    // must keep the index snapshot rather than repairing the selected rows.
    fs::write(root.join("a.md"), "# Changed\nDifferent body").unwrap();
    let page = memo
        .read_note_page(
            "background",
            "all",
            None,
            None,
            "updatedAt",
            i64::MAX,
            0,
            0,
            None,
            51,
        )
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].preview, before.preview);
    assert_eq!(page[0].updated_at, before.updated_at);
    // Even a temporarily missing source file cannot break the index query.
    fs::remove_file(root.join("a.md")).unwrap();
    assert_eq!(
        memo.read_note_page(
            "background",
            "all",
            None,
            None,
            "createdAt",
            i64::MAX,
            0,
            0,
            None,
            51
        )
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn cached_counts_do_not_create_or_scan_a_cold_notebook() {
    let (_temp, memo, root) = background_fixture();
    fs::write(root.join("a.md"), "untouched").unwrap();
    assert_eq!(memo.cached_note_count("background").unwrap(), None);
    assert!(!root.join(".flowix/notebook.db").exists());
}

#[test]
fn cached_counts_treat_an_old_database_without_projection_as_unknown() {
    let (_temp, memo, _root) = background_fixture();
    let path = memo.notebook_db_path("background").unwrap();
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE legacy_data (value TEXT); INSERT INTO legacy_data VALUES ('keep');",
    )
    .unwrap();
    assert_eq!(memo.cached_note_count("background").unwrap(), None);
    let value: String = conn
        .query_row("SELECT value FROM legacy_data", [], |row| row.get(0))
        .unwrap();
    assert_eq!(value, "keep");
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='notes'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
}

#[test]
fn background_scan_reports_busy_instead_of_claiming_completion() {
    let (_temp, memo, _root) = background_fixture();
    let _guard = memo
        .operation_locks()
        .notebook_maintenance("background", "test_busy")
        .unwrap();
    assert_eq!(
        memo.reconcile_note_index_background("background", &|| true)
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    // Preserve the older passive API's documented skip behavior.
    assert_eq!(
        memo.reconcile_note_index("background").unwrap(),
        NoteIndexReconcileReport::default()
    );
}

#[test]
fn cold_tag_queries_request_preparation_without_scanning() {
    let (_temp, memo, root) = background_fixture();
    fs::write(root.join("a.md"), "#tag\nbody").unwrap();
    assert_eq!(
        memo.read_tag_usage_summary_for_notebook_id(Some("background"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    assert_eq!(
        memo.read_tag_prefix_counts_for_notebook_id(Some("background"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    assert_eq!(memo.note_count("background").unwrap(), 0);
    assert_eq!(memo.cached_note_count("background").unwrap(), None);
}

#[test]
fn cancelled_cold_index_can_resume_without_changing_source_files() {
    let (_temp, memo, root) = background_fixture();
    fs::write(root.join("a.md"), "# Keep\nbody").unwrap();
    assert_eq!(
        memo.reconcile_note_index_background("background", &|| false)
            .unwrap_err()
            .kind(),
        io::ErrorKind::Interrupted
    );
    assert_eq!(memo.cached_note_count("background").unwrap(), None);
    memo.reconcile_note_index_background("background", &|| true)
        .unwrap();
    assert_eq!(memo.cached_note_count("background").unwrap(), Some(1));
    assert_eq!(
        fs::read_to_string(root.join("a.md")).unwrap(),
        "# Keep\nbody"
    );
}

#[test]
fn cancelled_warm_refresh_keeps_the_previous_projection_readable() {
    let (_temp, memo, root) = background_fixture();
    fs::write(root.join("a.md"), "a").unwrap();
    memo.reconcile_note_index_background("background", &|| true)
        .unwrap();
    fs::write(root.join("b.md"), "b").unwrap();
    assert!(memo
        .reconcile_note_index_background("background", &|| false)
        .is_err());
    assert_eq!(memo.read_note_entries("background").unwrap().len(), 1);
    memo.reconcile_note_index_background("background", &|| true)
        .unwrap();
    assert_eq!(memo.read_note_entries("background").unwrap().len(), 2);
}

#[test]
fn parser_upgrade_refreshes_preview_without_html_comments() {
    let (_temp, memo, root) = background_fixture();
    let content = "<!-- hidden metadata -->\nVisible text";
    fs::write(root.join("a.md"), content).unwrap();
    memo.reconcile_note_index("background").unwrap();
    let conn = memo.open_note_index_connection("background").unwrap();
    conn.execute("UPDATE notes SET preview='<!-- hidden metadata -->'", [])
        .unwrap();
    conn.execute(
        "UPDATE note_index_meta SET value='10' WHERE key='parser_version'",
        [],
    )
    .unwrap();
    drop(conn);

    assert!(!memo.note_index_is_ready("background").unwrap());
    assert_eq!(memo.reconcile_note_index("background").unwrap().updated, 1);
    assert_eq!(
        memo.read_note_entries("background").unwrap()[0].preview,
        "Visible text"
    );
    assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), content);
}

#[test]
fn parser_upgrade_refreshes_wiki_previews_without_changing_markdown() {
    let (_temp, memo, root) = background_fixture();
    let content = "[[./target.md]]\nVisible text";
    fs::write(root.join("a.md"), content).unwrap();
    memo.reconcile_note_index("background").unwrap();
    let conn = memo.open_note_index_connection("background").unwrap();
    conn.execute("UPDATE notes SET preview='[[./target.md]]'", [])
        .unwrap();
    conn.execute(
        "UPDATE note_index_meta SET value='11' WHERE key='parser_version'",
        [],
    )
    .unwrap();
    drop(conn);

    assert!(!memo.note_index_is_ready("background").unwrap());
    assert_eq!(memo.reconcile_note_index("background").unwrap().updated, 1);
    assert_eq!(
        memo.read_note_entries("background").unwrap()[0].preview,
        "Visible text"
    );
    assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), content);
}

#[test]
fn parser_upgrade_repairs_null_tag_properties_without_changing_note() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(&root).unwrap();
    let content =
        "---\ntags: null\n哈哈哈: \"111\"\n测试111日起: 2026-10-13\ntest: hhhhh\n---\nbody\n";
    let path = root.join("哈哈-1哈哈哈.md");
    fs::write(&path, content).unwrap();
    let store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "nb_null_tags".into(),
            name: "Null tags".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
    store.reconcile_note_index("nb_null_tags").unwrap();
    // Reproduce a version-7 projection: the hash is current but parsing
    // null tags discarded every frontmatter property.
    let conn = store.open_note_index_connection("nb_null_tags").unwrap();
    conn.execute("UPDATE notes SET properties_json='{}'", [])
        .unwrap();
    conn.execute(
        "UPDATE note_index_meta SET value='7' WHERE key='parser_version'",
        [],
    )
    .unwrap();
    drop(conn);

    assert!(!store.note_index_is_ready("nb_null_tags").unwrap());
    let report = store.reconcile_note_index("nb_null_tags").unwrap();
    assert_eq!(report.updated, 1);
    let note = store.read_note_entries("nb_null_tags").unwrap().remove(0);
    assert_eq!(note.properties["哈哈哈"], "111");
    assert_eq!(note.properties["测试111日起"], "2026-10-13");
    assert_eq!(note.properties["test"], "hhhhh");
    assert_eq!(fs::read_to_string(path).unwrap(), content);
    assert_eq!(
        store
            .reconcile_note_index("nb_null_tags")
            .unwrap()
            .unchanged,
        1
    );
}

#[test]
fn mixed_v2_and_note_tables_keep_current_note_rows() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(&root).unwrap();
    let store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "nb_test".into(),
            name: "Test".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
    let conn = store.open_note_index_connection("nb_test").unwrap();
    conn.execute("INSERT INTO notes (relative_path, size_bytes, content_hash, title, preview, properties_json, indexed_at) VALUES ('current.md', 1, 'hash', 'Current', '', '{}', 1)", []).unwrap();
    conn.execute_batch(
        "CREATE TABLE v2_index_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE v2_notes (relative_path TEXT PRIMARY KEY);
        INSERT INTO v2_notes VALUES ('old.md');
        CREATE VIRTUAL TABLE v2_note_search USING fts5(body);
        INSERT INTO v2_note_search (body) VALUES ('old');
        CREATE TABLE memos (relative_path TEXT PRIMARY KEY);
        INSERT INTO memos VALUES ('legacy-note.md');",
    )
    .unwrap();
    drop(conn);

    // Legacy projection cleanup is part of startup schema initialization,
    // while ordinary reads keep the common connection path lightweight.
    store.initialize_note_index_schema("nb_test").unwrap();
    let conn = store.open_note_index_connection("nb_test").unwrap();
    let note: String = conn
        .query_row("SELECT relative_path FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(note, "current.md");
    let memo_path: String = conn
        .query_row("SELECT relative_path FROM memos", [], |row| row.get(0))
        .unwrap();
    assert_eq!(memo_path, "legacy-note.md");
    let old_tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'v2_%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old_tables, 0);
}

#[test]
fn v2_only_projection_rebuilds_from_markdown() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(root.join(".flowix")).unwrap();
    fs::write(root.join("new.md"), "# New note\n").unwrap();
    let store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "nb_test".into(),
            name: "Test".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
    let conn = Connection::open(root.join(".flowix/notebook.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE v2_index_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE v2_notes (relative_path TEXT PRIMARY KEY);
        INSERT INTO v2_notes VALUES ('stale.md');",
    )
    .unwrap();
    drop(conn);

    assert!(!store.note_index_is_ready("nb_test").unwrap());
    store.reconcile_note_index("nb_test").unwrap();
    let entries = store.read_note_entries("nb_test").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].relative_path, "new.md");
    let expected_size = fs::metadata(root.join("new.md")).unwrap().len();
    assert_eq!(entries[0].size_bytes, expected_size);
    assert_eq!(
        store
            .read_indexed_note_entry_by_path("nb_test", "new.md")
            .unwrap()
            .unwrap()
            .size_bytes,
        expected_size
    );
    assert_eq!(
        store
            .derive_note_entry_from_disk("nb_test", "new.md")
            .unwrap()
            .size_bytes,
        expected_size
    );
}

#[test]
fn search_backfills_old_notebooks_and_tracks_path_changes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(&root).unwrap();
    let note = root.join("检索.md");
    fs::write(&note, "---\ntags: [项目]\n---\n这里有苹果香蕉。\n").unwrap();
    let mut store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "nb_search".into(),
            name: "Search".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
    store.set_current_notebook(Some("nb_search".into()));
    store.reconcile_note_index("nb_search").unwrap();

    // Simulate a notebook database written before the search projection.
    let conn = store.open_note_index_connection("nb_search").unwrap();
    conn.execute("DELETE FROM note_search_fts", []).unwrap();
    conn.execute(
        "DELETE FROM note_index_meta WHERE key='note_search_fts_version'",
        [],
    )
    .unwrap();
    drop(conn);

    assert_eq!(
        store
            .search_notes("nb_search", "苹果香蕉", 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.search_notes("nb_search", "苹果", 10).unwrap().len(),
        1
    );
    assert_eq!(
        store.search_notes("nb_search", "项目", 10).unwrap()[0].matched_in,
        "tag"
    );

    fs::write(&note, "新的搜索内容。\n").unwrap();
    store.refresh_note_path("nb_search", "检索.md").unwrap();
    assert!(store
        .search_notes("nb_search", "苹果香蕉", 10)
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .search_notes("nb_search", "搜索内容", 10)
            .unwrap()
            .len(),
        1
    );

    fs::remove_file(&note).unwrap();
    store.refresh_note_path("nb_search", "检索.md").unwrap();
    assert!(store
        .search_notes("nb_search", "搜索内容", 10)
        .unwrap()
        .is_empty());
}

#[test]
fn builds_and_reconciles_from_markdown_without_memo_ids() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(
        root.join("sub/a.md"),
        "---\ntags: [work]\n---\n# A\nFirst\n",
    )
    .unwrap();
    let mut store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "nb_test".into(),
            name: "Test".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
    store.set_current_notebook(Some("nb_test".into()));

    let first = store.reconcile_note_index("nb_test").unwrap();
    assert_eq!(first.added, 1);
    assert_eq!(store.reconcile_note_index("nb_test").unwrap().unchanged, 1);
    let conn = store.open_note_index_connection("nb_test").unwrap();
    let path: String = conn
        .query_row("SELECT relative_path FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(path, "sub/a.md");
    let legacy_tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memos'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(legacy_tables, 0);
    let path_entries = store.read_note_entries("nb_test").unwrap();
    assert_eq!(path_entries.len(), 1);
    assert_eq!(path_entries[0].relative_path, "sub/a.md");
    assert_eq!(path_entries[0].title, "a");
    assert_eq!(path_entries[0].tags, vec!["work"]);
    let mut service = crate::service::NoteService::new(&store);
    assert_eq!(
        service.list_notes_by_path("nb_test").unwrap()[0].relative_path,
        "sub/a.md"
    );
    let opened = service.get_note_by_path("nb_test", "sub/a.md").unwrap();
    assert_eq!(opened.body, "---\ntags: [work]\n---\n# A\nFirst\n");
    conn.execute("DELETE FROM notes WHERE relative_path='sub/a.md'", [])
        .unwrap();
    assert_eq!(
        service
            .get_note_by_path("nb_test", "sub/a.md")
            .unwrap()
            .entry
            .title,
        "a"
    );
    let tags: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notes n, json_each(n.tags) t WHERE t.value = 'work'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tags, 1);
    drop(conn);
    assert_eq!(store.cached_note_count("nb_test").unwrap(), Some(1));
    assert_eq!(
        store
            .occupied_filenames_in_directory("nb_test", Some("sub"))
            .unwrap(),
        vec!["a.md"]
    );
    let summary = store
        .read_tag_usage_summary_for_notebook_id(Some("nb_test"))
        .unwrap();
    assert_eq!(summary.0, vec!["work"]);
    assert_eq!(summary.2, 1);
    assert_eq!(
        store
            .read_tag_prefix_counts_for_notebook_id(Some("nb_test"))
            .unwrap()["work"],
        1
    );

    fs::write(root.join("sub/a.md"), "# A\nChanged\n").unwrap();
    assert_eq!(store.reconcile_note_index("nb_test").unwrap().updated, 1);
    fs::remove_file(root.join("sub/a.md")).unwrap();
    assert_eq!(store.reconcile_note_index("nb_test").unwrap().removed, 1);
}

#[test]
fn content_revisions_survive_a_path_rename() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("a.md"), "# A\nbody\n").unwrap();
    let mut store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "nb_test".into(),
            name: "Test".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
    store.set_current_notebook(Some("nb_test".into()));

    store
        .commit_note_content_revision("nb_test", "a.md", "hash-1", "change-1")
        .unwrap();
    let moved = store.move_note_by_path("nb_test", "a.md", "sub").unwrap();

    let revision = store
        .read_note_content_revision_for_notebook("nb_test", &moved)
        .unwrap()
        .expect("revision must follow the rename");
    assert_eq!(revision.revision, 1);
    assert_eq!(revision.change_id, "change-1");
    assert!(store
        .read_note_content_revision_for_notebook("nb_test", "a.md")
        .unwrap()
        .is_none());
}

#[test]
fn moves_note_by_path_without_a_legacy_memo_row() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("a.md"), "# A\nbody\n").unwrap();
    let mut store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "nb_test".into(),
            name: "Test".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
    store.set_current_notebook(Some("nb_test".into()));
    store.reconcile_note_index("nb_test").unwrap();
    let created_at = store
        .read_note_entry_by_path("nb_test", "a.md")
        .unwrap()
        .unwrap()
        .created_at;

    let moved = store.move_note_by_path("nb_test", "a.md", "sub").unwrap();

    assert_eq!(moved, "sub/a.md");
    assert!(!root.join("a.md").exists());
    assert_eq!(
        fs::read_to_string(root.join("sub/a.md")).unwrap(),
        "# A\nbody\n"
    );
    let entries = store.read_note_entries("nb_test").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].relative_path, "sub/a.md");
    assert_eq!(entries[0].created_at, created_at);
    let conn = store.open_note_index_connection("nb_test").unwrap();
    let legacy_tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memos'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(legacy_tables, 0);
}

#[test]
fn note_projection_coexists_with_path_keyed_memo_rows_in_the_same_notebook_db() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(&root).unwrap();
    let mut store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "nb_test".into(),
            name: "Test".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
    store.set_current_notebook(Some("nb_test".into()));
    let created = store
        .create_memo("Legacy and Note", "# Legacy and Note\n", None)
        .unwrap();
    let conn = store.open_note_index_connection("nb_test").unwrap();
    let immediate_path: String = conn
        .query_row("SELECT relative_path FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(immediate_path, created.relative_path);
    drop(conn);
    // Creation already writes the current parsed projection, so a full scan
    // sees it as unchanged.
    assert_eq!(store.reconcile_note_index("nb_test").unwrap().unchanged, 1);
    let conn = store.open_note_index_connection("nb_test").unwrap();
    let memo_path: String = conn
        .query_row("SELECT relative_path FROM memos", [], |row| row.get(0))
        .unwrap();
    assert_eq!(memo_path, created.relative_path);
    let note_path: String = conn
        .query_row("SELECT relative_path FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(note_path, created.relative_path);
    drop(conn);
    let conn = store.open_memo_index_db_for_notebook_id("nb_test").unwrap();
    conn.execute(
        "UPDATE memos SET preview='stale memo preview' WHERE relative_path=?1",
        params![created.relative_path],
    )
    .unwrap();
    drop(conn);
    let mut service = crate::service::NoteService::new(&store);
    let service_list = service.list("nb_test").unwrap();
    assert_ne!(service_list[0].preview, "stale memo preview");
    store
        .write_memo(&created.relative_path, "# Changed\nnew body\n")
        .unwrap();
    let conn = store.open_note_index_connection("nb_test").unwrap();
    let title: String = conn
        .query_row("SELECT title FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(title, "Legacy and Note");
    drop(conn);
    store
        .delete_memo_result_global(&created.relative_path)
        .unwrap();
    let conn = store.open_note_index_connection("nb_test").unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn summaries_carry_the_same_path_title_and_recency_as_the_full_projection() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notebook");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("一.md"), "# 第一篇\n\n正文\n").unwrap();
    fs::create_dir_all(root.join("子目录")).unwrap();
    fs::write(root.join("子目录").join("二.md"), "# 第二篇\n\n正文\n").unwrap();
    let mut store = MemoFile::new(temp.path().join("config"));
    store
        .write_notebook_configs(&[NotebookConfig {
            id: "nb_summary".into(),
            name: "Summary".into(),
            icon: None,
            path: root.to_string_lossy().into_owned(),
            is_default: true,
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }])
        .unwrap();
    store.reconcile_note_index("nb_summary").unwrap();

    let summaries = store.read_note_summaries("nb_summary").unwrap();
    let entries = store.read_note_entries("nb_summary").unwrap();
    assert_eq!(summaries.len(), entries.len());
    assert_eq!(summaries.len(), 2);
    for entry in &entries {
        let summary = summaries
            .iter()
            .find(|summary| summary.relative_path == entry.relative_path)
            .expect("every projection row has a summary");
        assert_eq!(summary.title, entry.title);
        assert_eq!(summary.updated_at, entry.updated_at);
    }
    assert!(summaries
        .windows(2)
        .all(|pair| pair[0].updated_at >= pair[1].updated_at));
}
