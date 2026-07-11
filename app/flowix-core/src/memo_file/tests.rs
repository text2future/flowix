//! v3 单测 — 围绕 `ops` 原语 + memo index 真源语义。
//!
//! 覆盖:
//! - helpers: `sanitize_filename_component` / `base_filename` / `resolve_filename_conflict` /
//!   `build_md_content`
//! - ops: `create_memo` / `rename_memo` / `write_memo` / `delete_memo` /
//!   `register_existing_file` / `register_unnamed_file` / `reconcile_with_disk` /
//!   `reload_memo_from_disk` / `unregister_memo_by_path` / `sync_metadata_only` /
//!   `find_memo_by_filename` / `find_memo_file_path`
//! - content: `read_all_memos` / `read_all_memos_filtered` / `read_memo_with_body`
//! - memo index schema: 无 `path` 字段, `filename` 直存磁盘文件名

use super::frontmatter::build_md_content;
use super::ops::{
    atomic_write_bytes, base_filename, resolve_filename_conflict, sanitize_filename_component,
};
use super::types::MemoIndexFile;
use super::MemoFile;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

// =====================================================================
// Test fixture
// =====================================================================

/// 测试 fixture: 构造一个 MemoFile 指向 tempdir, 模拟 "default notebook"。
/// `read_notebook_configs` 走磁盘读, 必须先把 notebook.json 写好, 后面
/// `get_memo_base` 才能找到路径。`AtomicUsize` + nanos 后缀防并行 cargo test 撞名。
fn fresh_memo_file() -> (MemoFile, PathBuf) {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let tmp = std::env::temp_dir().join(format!(
        "flowix-memo-file-v3-test-{}-{}-{}",
        std::process::id(),
        n,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    let app_data = tmp.join("app_data");
    let notebook_file = tmp.join("notebook.json");
    fs::create_dir_all(&app_data).unwrap();

    let cfg = super::types::NotebookConfig {
        id: "nb_test".to_string(),
        name: "Test".to_string(),
        icon: Some("📓".to_string()),
        path: format!("{}/", tmp.display()),
        is_default: true,
        created_at: 0,
        updated_at: 0,
    };
    fs::write(
        &notebook_file,
        serde_json::to_string_pretty(&vec![cfg.clone()]).unwrap(),
    )
    .unwrap();

    let mut mf = MemoFile::new(app_data, notebook_file);
    mf.set_current_notebook(Some("nb_test".to_string()));
    (mf, tmp)
}

#[test]
fn create_memo_generates_eight_char_id() {
    let (mf, _tmp) = fresh_memo_file();
    let memo = mf.create_memo("Eight", "body", None).unwrap();

    assert_eq!(memo.id.len(), super::MEMO_ID_LENGTH);
    assert!(memo
        .id
        .chars()
        .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()));

    let content = fs::read_to_string(mf.get_memo_base().join(&memo.filename)).unwrap();
    assert_eq!(
        super::frontmatter::extract_frontmatter_key(&content),
        Some(memo.id)
    );
}

/// 读 memo index 原始 JSON 字符串 (不反序列化, 用于 schema 断言)。
#[test]
fn notebook_json_is_migrated_to_index_db() {
    let (mf, _tmp) = fresh_memo_file();

    let configs = mf.read_notebook_configs().expect("read notebooks");
    assert_eq!(configs.len(), 1);
    assert_eq!(configs[0].id, "nb_test");
    assert!(mf.get_index_db_path().exists());

    let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notebooks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn notebook_configs_are_read_from_index_db_after_write() {
    let (mf, tmp) = fresh_memo_file();
    let notebook_file = mf.get_notebook_file_path();

    let configs = vec![super::types::NotebookConfig {
        id: "nb_db".to_string(),
        name: "DB Notebook".to_string(),
        icon: Some("db".to_string()),
        path: format!("{}/db/", tmp.display()),
        is_default: false,
        created_at: 10,
        updated_at: 20,
    }];
    mf.write_notebook_configs(&configs)
        .expect("write notebooks");

    fs::write(&notebook_file, "{not json").unwrap();
    mf.invalidate_caches();

    let reloaded = mf.read_notebook_configs().expect("read from db");
    assert_eq!(reloaded.len(), 1);
    assert_eq!(reloaded[0].id, "nb_db");
    assert_eq!(reloaded[0].name, "DB Notebook");
}

#[test]
fn legacy_memo_agents_role_key_column_is_renamed_to_agent_type() {
    let (mf, _tmp) = fresh_memo_file();
    let db_path = mf.get_index_db_path();
    let conn = rusqlite::Connection::open(&db_path).unwrap();

    conn.execute_batch(
        r#"
        CREATE TABLE memo_index_state (
            notebook_id TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            last_updated INTEGER NOT NULL,
            migrated_at INTEGER NOT NULL
        );
        CREATE TABLE memos (
            id TEXT PRIMARY KEY,
            notebook_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            preview TEXT NOT NULL,
            thumbnail TEXT,
            thumbnail_checked INTEGER NOT NULL DEFAULT 0,
            agents_checked INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            favorited INTEGER NOT NULL,
            icon TEXT,
            properties TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE memo_agents (
            memo_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            role_key TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL,
            PRIMARY KEY(memo_id, thread_id)
        );
        "#,
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memo_index_state (notebook_id, version, last_updated, migrated_at) VALUES ('nb_test', 1, 10, 10)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memos (id, notebook_id, filename, preview, created_at, updated_at, favorited, properties) VALUES ('memo1', 'nb_test', 'Memo.md', '', 1, 2, 0, '{}')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memo_agents (memo_id, thread_id, title, role_key, position) VALUES ('memo1', 'thread1', 'Thread', 'codex', 0)",
        [],
    )
    .unwrap();
    drop(conn);

    let list = mf.read_index().expect("read migrated memo index");
    assert_eq!(list.memos.len(), 1);
    assert_eq!(list.memos[0].agents.len(), 1);
    assert_eq!(list.memos[0].agents[0].agent_type, "codex");

    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let columns = conn
        .prepare("PRAGMA table_info(memo_agents)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(columns.contains(&"agent_type".to_string()));
    assert!(!columns.contains(&"role_key".to_string()));
}

#[test]
fn writing_notebook_configs_preserves_existing_memo_rows() {
    let (mf, tmp) = fresh_memo_file();
    let memo = mf.create_memo("Keep", "# Keep", None).unwrap();

    let configs = vec![
        super::types::NotebookConfig {
            id: "nb_test".to_string(),
            name: "Test".to_string(),
            icon: Some("test".to_string()),
            path: format!("{}/", tmp.display()),
            is_default: true,
            created_at: 0,
            updated_at: 1,
        },
        super::types::NotebookConfig {
            id: "nb_other".to_string(),
            name: "Other".to_string(),
            icon: Some("other".to_string()),
            path: format!("{}/other/", tmp.display()),
            is_default: false,
            created_at: 2,
            updated_at: 3,
        },
    ];
    mf.write_notebook_configs(&configs)
        .expect("write notebooks");

    let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memos WHERE notebook_id = 'nb_test' AND id = ?1",
            rusqlite::params![memo.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn read_memos_for_notebook_id_does_not_switch_current_notebook() {
    let (mut mf, tmp) = fresh_memo_file();
    let current_memo = mf.create_memo("Current", "# Current", None).unwrap();

    let other_dir = tmp.join("other");
    fs::create_dir_all(&other_dir).unwrap();
    let mut configs = mf.read_notebook_configs().expect("read notebooks");
    configs.push(super::types::NotebookConfig {
        id: "nb_other".to_string(),
        name: "Other".to_string(),
        icon: None,
        path: format!("{}/", other_dir.display()),
        is_default: false,
        created_at: 1,
        updated_at: 1,
    });
    mf.write_notebook_configs(&configs)
        .expect("write notebooks");

    mf.set_current_notebook(Some("nb_other".to_string()));
    let other_memo = mf.create_memo("Other", "# Other", None).unwrap();

    mf.set_current_notebook(Some("nb_test".to_string()));
    let other_memos =
        mf.read_all_memos_filtered_for_notebook_id(Some("nb_other"), "all", "createdAt", None);
    let current_memos = mf.read_all_memos_filtered("all", "createdAt", None);

    assert_eq!(mf.current_notebook_id_value().as_deref(), Some("nb_test"));
    assert_eq!(other_memos.len(), 1);
    assert_eq!(other_memos[0].id, other_memo.id);
    assert_eq!(current_memos.len(), 1);
    assert_eq!(current_memos[0].id, current_memo.id);
}

#[test]
fn register_existing_file_for_other_notebook_does_not_switch_current_notebook() {
    let (mf, tmp) = fresh_memo_file();
    let current_memo = mf.create_memo("Current", "# Current", None).unwrap();

    let other_dir = tmp.join("other-register");
    fs::create_dir_all(&other_dir).unwrap();
    let mut configs = mf.read_notebook_configs().expect("read notebooks");
    configs.push(super::types::NotebookConfig {
        id: "nb_other".to_string(),
        name: "Other".to_string(),
        icon: None,
        path: format!("{}/", other_dir.display()),
        is_default: false,
        created_at: 1,
        updated_at: 1,
    });
    mf.write_notebook_configs(&configs)
        .expect("write notebooks");

    let other_path = other_dir.join("External Agent Note.md");
    fs::write(&other_path, "# External Agent Note\n\ncreated elsewhere").unwrap();

    let registered = mf
        .register_existing_file_for_notebook_id("nb_other", &other_path)
        .expect("register other notebook file");

    assert_eq!(mf.current_notebook_id_value().as_deref(), Some("nb_test"));

    let other_memos = mf.read_all_memos_for_notebook_id(Some("nb_other"));
    assert_eq!(other_memos.len(), 1);
    assert_eq!(other_memos[0].id, registered.id);
    assert_eq!(other_memos[0].filename, "External Agent Note.md");

    let current_memos = mf.read_all_memos_for_notebook_id(Some("nb_test"));
    assert_eq!(current_memos.len(), 1);
    assert_eq!(current_memos[0].id, current_memo.id);

    let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
    let notebook_id: String = conn
        .query_row(
            "SELECT notebook_id FROM memos WHERE id = ?1",
            rusqlite::params![registered.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(notebook_id, "nb_other");
}

#[test]
fn read_memo_by_id_resolves_global_notebook_location() {
    let (mut mf, tmp) = fresh_memo_file();
    let current_memo = mf.create_memo("Current", "# Current", None).unwrap();

    let other_dir = tmp.join("other-global-read");
    fs::create_dir_all(&other_dir).unwrap();
    let mut configs = mf.read_notebook_configs().expect("read notebooks");
    configs.push(super::types::NotebookConfig {
        id: "nb_other".to_string(),
        name: "Other".to_string(),
        icon: None,
        path: format!("{}/", other_dir.display()),
        is_default: false,
        created_at: 1,
        updated_at: 1,
    });
    mf.write_notebook_configs(&configs)
        .expect("write notebooks");

    mf.set_current_notebook(Some("nb_other".to_string()));
    let other_memo = mf.create_memo("Other", "# Other", None).unwrap();
    mf.set_current_notebook(Some("nb_test".to_string()));

    assert!(
        mf.read_memo(&other_memo.id).is_none(),
        "current-local read should not find other notebook memo"
    );
    let resolved = mf
        .read_memo_global(&other_memo.id)
        .expect("global memo found");
    let path = mf
        .find_memo_file_path(&other_memo.id)
        .expect("global path found");
    let (_entry, body) = mf
        .read_memo_with_body_global(&other_memo.id)
        .expect("global body found");

    assert_eq!(mf.current_notebook_id_value().as_deref(), Some("nb_test"));
    assert_eq!(resolved.id, other_memo.id);
    assert_eq!(path, other_dir.join(&other_memo.filename));
    assert!(body.contains("# Other"));
    assert_eq!(
        mf.read_all_memos_filtered("all", "createdAt", None)[0].id,
        current_memo.id
    );
}

#[test]
fn write_memo_by_id_updates_global_notebook_without_switching_current() {
    let (mut mf, tmp) = fresh_memo_file();
    let current_memo = mf.create_memo("Current", "# Current", None).unwrap();

    let other_dir = tmp.join("other-global-write");
    fs::create_dir_all(&other_dir).unwrap();
    let mut configs = mf.read_notebook_configs().expect("read notebooks");
    configs.push(super::types::NotebookConfig {
        id: "nb_other".to_string(),
        name: "Other".to_string(),
        icon: None,
        path: format!("{}/", other_dir.display()),
        is_default: false,
        created_at: 1,
        updated_at: 1,
    });
    mf.write_notebook_configs(&configs)
        .expect("write notebooks");

    mf.set_current_notebook(Some("nb_other".to_string()));
    let other_memo = mf.create_memo("Other", "# Other", None).unwrap();
    mf.set_current_notebook(Some("nb_test".to_string()));

    let updated = mf
        .write_memo_renaming_on_title_change_global(&other_memo.id, "Renamed Other\nBody")
        .expect("global write ok");
    let other_list = mf
        .read_index_for_notebook_id(Some("nb_other"))
        .expect("read other index")
        .expect("other index exists");
    let current_list = mf.read_index().expect("current index exists");
    let final_content = fs::read_to_string(other_dir.join(&updated.filename)).unwrap();

    assert_eq!(mf.current_notebook_id_value().as_deref(), Some("nb_test"));
    assert_eq!(updated.id, other_memo.id);
    assert_eq!(updated.filename, "Renamed Other.md");
    assert!(final_content.contains("Renamed Other"));
    assert!(other_list.memos.iter().any(|memo| memo.id == other_memo.id));
    assert_eq!(current_list.memos.len(), 1);
    assert_eq!(current_list.memos[0].id, current_memo.id);
}

#[test]
fn pasted_file_with_key_from_other_notebook_gets_new_id_in_current_notebook() {
    let (mut mf, tmp) = fresh_memo_file();

    let other_dir = tmp.join("other-paste");
    fs::create_dir_all(&other_dir).unwrap();
    let mut configs = mf.read_notebook_configs().expect("read notebooks");
    configs.push(super::types::NotebookConfig {
        id: "nb_other".to_string(),
        name: "Other".to_string(),
        icon: None,
        path: format!("{}/", other_dir.display()),
        is_default: false,
        created_at: 1,
        updated_at: 1,
    });
    mf.write_notebook_configs(&configs)
        .expect("write notebooks");

    mf.set_current_notebook(Some("nb_other".to_string()));
    let other_memo = mf.create_memo("Other", "# Other", None).unwrap();

    mf.set_current_notebook(Some("nb_test".to_string()));
    let pasted_path = tmp.join("Copied.md");
    fs::write(
        &pasted_path,
        format!("---\nkey: {}\n---\n# Copied\n", other_memo.id),
    )
    .unwrap();
    let copied = mf
        .register_existing_file(&pasted_path)
        .expect("register copied file");
    let copied_content = fs::read_to_string(&pasted_path).unwrap();

    assert_ne!(copied.id, other_memo.id);
    assert_eq!(copied.filename, "Copied.md");
    assert!(mf.read_memo(&other_memo.id).is_none());
    assert!(mf.read_memo_global(&other_memo.id).is_some());
    assert_eq!(
        super::frontmatter::extract_frontmatter_key(&copied_content),
        Some(copied.id)
    );
}

#[test]
fn create_memo_writes_memo_row_to_index_db() {
    let (mf, _tmp) = fresh_memo_file();
    let memo = mf
        .create_memo("DB Note", "# DB Note\n#tag\n- [ ] todo", None)
        .unwrap();

    let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
    let row: (String, String, i64) = conn
        .query_row(
            "SELECT notebook_id, filename, favorited FROM memos WHERE id = ?1",
            rusqlite::params![memo.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(row.0, "nb_test");
    assert_eq!(row.1, memo.filename);
    assert_eq!(row.2, 0);

    let tag_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memo_tags WHERE memo_id = ?1 AND tag = 'tag'",
            rusqlite::params![memo.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tag_count, 1);

    let todo_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memo_todos WHERE memo_id = ?1 AND content = 'todo'",
            rusqlite::params![memo.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(todo_count, 1);
}

#[test]
fn write_index_persists_to_memos_table() {
    let (mf, _tmp) = fresh_memo_file();
    let list = MemoIndexFile {
        version: 1,
        last_updated: 42,
        memos: vec![super::types::MemoIndexEntry {
            id: "abc123".to_string(),
            filename: "Legacy.md".to_string(),
            preview: "Legacy".to_string(),
            thumbnail: Some("https://example.com/legacy.png".to_string()),
            tags: vec!["legacy".to_string()],
            todos: vec![super::types::TodoItem {
                content: "todo".to_string(),
                status: "pending".to_string(),
            }],
            agents: vec![],
            created_at: 1,
            updated_at: 2,
            favorited: true,
            icon: Some("star".to_string()),
            colors: vec![super::types::MemoColor::Blue],
            properties: serde_json::json!({ "key": "abc123", "status": "draft" }),
        }],
    };
    mf.write_index(&list).unwrap();

    let loaded = mf.read_index().expect("migrated index");
    assert_eq!(loaded.memos.len(), 1);
    assert_eq!(loaded.memos[0].id, "abc123");
    assert_eq!(
        loaded.memos[0].thumbnail.as_deref(),
        Some("https://example.com/legacy.png")
    );
    assert_eq!(loaded.memos[0].properties["status"], "draft");

    let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
    let (filename, properties): (String, String) = conn
        .query_row(
            "SELECT filename, properties FROM memos WHERE id = 'abc123'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(filename, "Legacy.md");
    let properties: serde_json::Value = serde_json::from_str(&properties).unwrap();
    assert_eq!(properties["key"], "abc123");
    assert_eq!(properties["status"], "draft");
}

// =====================================================================
// helpers
// =====================================================================

#[test]
fn sanitize_replaces_filesystem_specials() {
    let s = sanitize_filename_component("a/b\\c:d*e?f\"g<h>i|j.");
    assert_eq!(s, "a b c d e f g h i j");
}

#[test]
fn sanitize_truncates_to_200_chars() {
    let raw = "x".repeat(250);
    let s = sanitize_filename_component(&raw);
    assert_eq!(s.chars().count(), 200);
}

#[test]
fn base_filename_falls_back_to_untitled_date() {
    let s = base_filename("");
    assert!(s.starts_with("untitled-"), "got: {s}");
    assert!(s.ends_with(".md"), "should end with .md: {s}");
}

#[test]
fn base_filename_uses_sanitized_title_with_md_suffix() {
    assert_eq!(base_filename("Hello"), "Hello");
    assert_eq!(base_filename("a/b"), "a b");
    assert_eq!(base_filename("name."), "name");
}

#[test]
fn resolve_filename_conflict_picks_first_free() {
    let dir = tempdir();
    // primary 不存在 → 用 primary
    assert_eq!(
        resolve_filename_conflict(&dir, "Foo", &[]),
        "Foo.md".to_string()
    );
    // primary 存在 → -1
    fs::write(dir.join("Foo.md"), b"x").unwrap();
    assert_eq!(
        resolve_filename_conflict(&dir, "Foo", &[]),
        "Foo-1.md".to_string()
    );
    // -1 也存在 → -2
    fs::write(dir.join("Foo-1.md"), b"x").unwrap();
    assert_eq!(
        resolve_filename_conflict(&dir, "Foo", &[]),
        "Foo-2.md".to_string()
    );
}

#[test]
fn build_md_content_writes_frontmatter_then_body() {
    let content = build_md_content("abc123", "world\n");
    assert_eq!(content, "---\nkey: abc123\n---\nworld\n");
}

// =====================================================================
// ops: create
// =====================================================================

#[test]
fn create_memo_writes_file_and_entry() {
    let (mf, base) = fresh_memo_file();
    let memo = mf
        .create_memo("Hello", "body content", None)
        .expect("create ok");

    // 物理文件存在
    let path = base.join(&memo.filename);
    assert!(path.exists(), "file should exist at {}", path.display());
    // entry 跟磁盘文件名一致, 含 .md
    assert_eq!(memo.filename, "Hello.md");
    assert!(!memo.id.is_empty());
    assert_eq!(memo.id.len(), super::MEMO_ID_LENGTH);
    // memo index 已注册
    let queried = mf.read_memo(&memo.id).expect("memo in list");
    assert_eq!(queried.filename, "Hello.md");
    // preview = 派生第二行 body, 单行 body 时为空
}

#[test]
fn create_memo_merges_key_into_existing_frontmatter() {
    let (mf, _base) = fresh_memo_file();
    let body = concat!(
        "---\n",
        "name: guizang-ppt-skill\n",
        "description: deck generator\n",
        "---\n",
        "# Body\n"
    );
    let memo = mf.create_memo("Imported", body, None).expect("create ok");
    let content = fs::read_to_string(memo.filename_full_path(&mf)).unwrap();

    assert!(content.starts_with("---\nkey: "));
    assert!(content.contains("\nname: guizang-ppt-skill\n"));
    assert!(content.contains("\ndescription: deck generator\n"));
    assert_eq!(
        content.matches("\n---").count(),
        1,
        "content must have one closing frontmatter fence: {content}"
    );
    assert_eq!(
        super::frontmatter::extract_frontmatter_key(&content),
        Some(memo.id)
    );
}

#[test]
fn create_memo_persists_frontmatter_properties_to_index_db() {
    let (mf, _base) = fresh_memo_file();
    let body = concat!(
        "---\n",
        "name: guizang-ppt-skill\n",
        "status: draft\n",
        "tags: [ppt, skill]\n",
        "---\n",
        "# Body\n"
    );
    let memo = mf.create_memo("Imported", body, None).expect("create ok");

    let from_index = mf.read_memo(&memo.id).expect("memo in index");
    assert_eq!(from_index.properties["key"], memo.id);
    assert_eq!(from_index.properties["name"], "guizang-ppt-skill");
    assert_eq!(from_index.properties["status"], "draft");
    assert_eq!(from_index.properties["tags"][0], "ppt");

    let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
    let properties: String = conn
        .query_row(
            "SELECT properties FROM memos WHERE id = ?1",
            rusqlite::params![memo.id],
            |row| row.get(0),
        )
        .unwrap();
    let properties: serde_json::Value = serde_json::from_str(&properties).unwrap();
    assert_eq!(properties["name"], "guizang-ppt-skill");
    assert_eq!(properties["status"], "draft");
    assert_eq!(properties["tags"][1], "skill");
}

#[test]
fn read_index_backfills_missing_properties_from_frontmatter() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf
        .create_memo("Backfill", "---\nstatus: review\n---\n# Backfill\n", None)
        .expect("create ok");

    {
        let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
        conn.execute(
            "UPDATE memos SET properties = '{}' WHERE id = ?1",
            rusqlite::params![memo.id],
        )
        .unwrap();
    }
    mf.invalidate_caches();

    let from_index = mf.read_memo(&memo.id).expect("memo in index");
    assert_eq!(from_index.properties["status"], "review");

    let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
    let properties: String = conn
        .query_row(
            "SELECT properties FROM memos WHERE id = ?1",
            rusqlite::params![memo.id],
            |row| row.get(0),
        )
        .unwrap();
    let properties: serde_json::Value = serde_json::from_str(&properties).unwrap();
    assert_eq!(properties["status"], "review");
}

#[test]
fn create_memo_handles_title_conflict() {
    let (mf, base) = fresh_memo_file();
    let a = mf.create_memo("Hello", "x", None).unwrap();
    let b = mf.create_memo("Hello", "y", None).unwrap();
    assert_eq!(a.filename, "Hello.md");
    assert_eq!(b.filename, "Hello-1.md");
    assert_ne!(a.id, b.id);
    assert!(base.join("Hello.md").exists());
    assert!(base.join("Hello-1.md").exists());
}

#[test]
fn create_memo_with_tag_appends_to_body() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf.create_memo("Tagged", "intro\n", Some("work")).unwrap();
    let content = fs::read_to_string(memo.filename_full_path(&mf)).unwrap();
    assert!(content.contains("#work"));
    assert!(content.contains("intro"));
}

#[test]
fn create_memo_with_empty_tag_does_not_append() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf.create_memo("Tagged", "intro\n", Some("")).unwrap();
    let content = fs::read_to_string(memo.filename_full_path(&mf)).unwrap();
    assert!(!content.contains("#"));
}

#[test]
fn create_memo_sanitizes_title_for_filesystem() {
    let (mf, _base) = fresh_memo_file();
    let raw = "  a/b\\c:d*e?f\"g<h>i|j.  ";
    let memo = mf.create_memo(raw, "body", None).unwrap();
    assert_eq!(memo.filename, "a b c d e f g h i j.md");
}

#[test]
fn create_memo_empty_title_uses_untitled_date() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf.create_memo("", "body", None).unwrap();
    assert!(
        memo.filename.starts_with("untitled-"),
        "got: {}",
        memo.filename
    );
    // ends_with .md 已在 fallback_filename 保证
}

// =====================================================================
// ops: rename
// =====================================================================

#[test]
fn rename_memo_renames_file_and_updates_list() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Old", "body", None).unwrap();
    assert!(base.join("Old.md").exists());

    let updated = mf.rename_memo(&memo.id, "New").expect("rename ok");
    assert_eq!(updated.filename, "New.md");
    assert!(!base.join("Old.md").exists(), "old file should be gone");
    assert!(base.join("New.md").exists());
    let queried = mf.read_memo(&memo.id).expect("still in list");
    assert_eq!(queried.filename, "New.md");
}

#[test]
fn rename_memo_handles_conflict() {
    let (mf, base) = fresh_memo_file();
    let a = mf.create_memo("First", "a", None).unwrap();
    let _b = mf.create_memo("Second", "b", None).unwrap();
    // 把 a 改名为 "Second" → 冲突 → 用 Second-1.md
    let updated = mf.rename_memo(&a.id, "Second").unwrap();
    assert_eq!(updated.filename, "Second-1.md");
    assert!(base.join("Second-1.md").exists());
}

#[test]
fn rename_memo_renames_disk_file_and_keeps_key_in_frontmatter() {
    // 新 frontmatter 语义: rename 只改磁盘文件名 + memo index.filename,
    // frontmatter 块内 `key` 保持与 memo index id 一致, 不再有 `filename` 字段。
    let (mf, _base) = fresh_memo_file();
    let memo = mf.create_memo("First", "body\n", None).unwrap();
    let original_id = memo.id.clone();
    let _ = mf.rename_memo(&memo.id, "Second").unwrap();
    let content = fs::read_to_string(_base.join("Second.md")).unwrap();
    assert!(
        content.contains(&format!("key: {}", original_id)),
        "frontmatter key must equal memo id after rename: {content}"
    );
    assert!(
        !content.contains("filename:"),
        "frontmatter should no longer carry filename field: {content}"
    );
}

#[test]
fn rename_memo_unchanged_title_is_noop() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Same", "body", None).unwrap();
    let updated = mf.rename_memo(&memo.id, "Same").unwrap();
    assert_eq!(updated.filename, "Same.md");
    assert!(base.join("Same.md").exists());
}

#[test]
fn rename_memo_not_found_returns_io_error() {
    let (mf, _base) = fresh_memo_file();
    let result = mf.rename_memo("zzzzzz", "New");
    assert!(result.is_err());
}

// =====================================================================
// ops: write
// =====================================================================

#[test]
fn write_memo_updates_body_and_keeps_filename() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Title", "old\n", None).unwrap();
    let updated = mf.write_memo(&memo.id, "new\n").expect("write ok");
    assert_eq!(updated.filename, "Title.md");
    // single-line body → preview empty
    let content = fs::read_to_string(base.join("Title.md")).unwrap();
    assert!(content.contains("new"));
    assert!(!content.contains("old"));
}

#[test]
fn write_memo_preserves_key_in_frontmatter() {
    // 新 frontmatter 语义: write_memo 走 merge_frontmatter, 注入 key=id,
    // body 透传 caller 内容, 不再有 `filename` 字段。
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Stable", "body\n", None).unwrap();
    let original_id = memo.id.clone();
    let _ = mf.write_memo(&memo.id, "more\n").unwrap();
    // filename 不冲突时保持不变, 直接读 Stable.md
    let content = fs::read_to_string(base.join("Stable.md")).unwrap();
    assert!(
        content.contains(&format!("key: {}", original_id)),
        "frontmatter key must equal memo id after write: {content}"
    );
    assert!(
        content.contains("more"),
        "body must reflect caller content: {content}"
    );
}

#[test]
fn write_memo_not_found_returns_io_error() {
    let (mf, _base) = fresh_memo_file();
    let result = mf.write_memo("zzzzzz", "body");
    assert!(result.is_err());
}

// =====================================================================
// ops: write_memo_renaming_on_title_change
// =====================================================================

#[test]
fn write_rename_changes_disk_when_first_line_changes() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Old", "Old body\n", None).unwrap();
    assert!(base.join("Old.md").exists());

    let updated = mf
        .write_memo_renaming_on_title_change(&memo.id, "Renamed\nbody line 2\n")
        .expect("write+rename ok");

    // 派生 title = 整行 "Renamed" (经 strip_markdown 清洗, 无装饰), filename = "Renamed.md"
    assert_eq!(updated.filename, "Renamed.md");
    assert!(!base.join("Old.md").exists(), "old file should be gone");
    assert!(base.join("Renamed.md").exists());
    let queried = mf.read_memo(&memo.id).expect("still in list");
    assert_eq!(queried.filename, "Renamed.md");
}

#[test]
fn write_rename_noop_when_first_line_unchanged() {
    // 首行未变 → 走完 write_memo 后比对 new_candidate == old_base,
    // 不 fs::rename, 不改 memo index.filename。
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Stable", "old body\n", None).unwrap();
    // 首行仍是 "Stable" (加新行不影响派生 title)
    let new_body = "Stable\nnew line 2\nnew line 3\n";
    let _ = mf
        .write_memo_renaming_on_title_change(&memo.id, new_body)
        .expect("write ok");
    assert!(base.join("Stable.md").exists());
    let queried = mf.read_memo(&memo.id).expect("still in list");
    assert_eq!(queried.filename, "Stable.md");
}

#[test]
fn write_rename_handles_conflict_with_dash_suffix() {
    // 首行变化触发的 rename 跟普通 rename_memo 走同一 resolve_filename_conflict
    // 逻辑, 冲突时自动追加 -1。
    let (mf, base) = fresh_memo_file();
    let _a = mf.create_memo("First", "a\n", None).unwrap();
    let b = mf.create_memo("Second", "b\n", None).unwrap();
    // 把 b 的首行改成 "First" → 跟 a 冲突 → 走 First-1.md
    let updated = mf
        .write_memo_renaming_on_title_change(&b.id, "First\nnew body\n")
        .expect("write+rename ok");
    assert_eq!(updated.filename, "First-1.md");
    assert!(base.join("First-1.md").exists());
    // 原 a 仍在 First.md
    assert!(base.join("First.md").exists());
}

#[test]
fn write_rename_keeps_key_in_frontmatter() {
    // rename 后磁盘 frontmatter 的 key 仍 == memo id, 跟前方案契约一致。
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Start", "Start\n", None).unwrap();
    let original_id = memo.id.clone();
    let _ = mf
        .write_memo_renaming_on_title_change(&memo.id, "End\nnew body\n")
        .expect("write+rename ok");
    let content = fs::read_to_string(base.join("End.md")).unwrap();
    assert!(
        content.contains(&format!("key: {}", original_id)),
        "frontmatter key must equal memo id: {content}"
    );
    assert!(!content.contains("filename:"));
}

#[test]
fn write_rename_empty_body_uses_untitled_memo() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Keep", "body\n", None).unwrap();
    let updated = mf
        .write_memo_renaming_on_title_change(&memo.id, "")
        .expect("write ok");

    assert_eq!(updated.filename, "Untitled Memo.md");
    assert!(!base.join("Keep.md").exists());
    assert!(base.join("Untitled Memo.md").exists());
    let queried = mf.read_memo(&memo.id).expect("still in list");
    assert_eq!(queried.filename, "Untitled Memo.md");
    assert_eq!(queried.preview, "");
}

#[test]
fn write_rename_empty_body_uses_untitled_memo_dash_suffix_on_conflict() {
    let (mf, base) = fresh_memo_file();
    let _existing = mf.create_memo("Untitled Memo", "existing\n", None).unwrap();
    let memo = mf.create_memo("Keep", "body\n", None).unwrap();
    let updated = mf
        .write_memo_renaming_on_title_change(&memo.id, "")
        .expect("write ok");

    assert_eq!(updated.filename, "Untitled Memo-1.md");
    assert!(base.join("Untitled Memo.md").exists());
    assert!(base.join("Untitled Memo-1.md").exists());
}

// =====================================================================
// ops: delete
// =====================================================================

#[test]
fn delete_memo_removes_file_and_index_entry() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Del", "x", None).unwrap();
    assert!(base.join("Del.md").exists());

    let removed = mf.delete_memo(&memo.id);
    assert!(removed);
    assert!(!base.join("Del.md").exists());
    assert!(mf.read_memo(&memo.id).is_none());
}

#[test]
fn delete_memo_handles_orphan_index_entry() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Orphan", "x", None).unwrap();
    // 模拟外部 rm: 物理文件先没
    fs::remove_file(base.join("Orphan.md")).unwrap();
    let removed = mf.delete_memo(&memo.id);
    assert!(removed, "should clear memo index orphan entry");
    assert!(mf.read_memo(&memo.id).is_none());
}

#[test]
fn delete_memo_returns_false_when_unknown() {
    let (mf, _base) = fresh_memo_file();
    assert!(!mf.delete_memo("zzzzzz"));
}

// =====================================================================
// ops: register
// =====================================================================

#[test]
fn register_existing_file_injects_key_and_preserves_body() {
    // 新 frontmatter 语义: 外部 .md 被注册时, 后端走 merge_frontmatter
    // 在文件头注入 frontmatter 块 (`key: <新id>`), 原 body 字节级保留。
    let (mf, base) = fresh_memo_file();
    let abs = base.join("PreExisting.md");
    fs::write(&abs, "user original content").unwrap();

    let memo = mf.register_existing_file(&abs).expect("register ok");
    assert_eq!(memo.filename, "PreExisting.md");
    assert!(!memo.id.is_empty());
    // 磁盘文件被改写: frontmatter 块注入 + 原 body 保留
    let content = fs::read_to_string(&abs).unwrap();
    assert!(
        content.contains(&format!("key: {}", memo.id)),
        "frontmatter must contain injected key: {content}"
    );
    assert!(
        content.contains("user original content"),
        "original body must be preserved: {content}"
    );
    // memo index 已注册
    let queried = mf.find_memo_by_filename("PreExisting.md").expect("in list");
    assert_eq!(queried.id, memo.id);
}

#[test]
fn register_existing_file_rejects_non_markdown() {
    let (mf, base) = fresh_memo_file();
    let abs = base.join("photo.png");
    fs::write(&abs, b"fake").unwrap();
    let result = mf.register_existing_file(&abs);
    assert!(result.is_err());
}

#[test]
fn register_existing_file_rejects_missing() {
    let (mf, base) = fresh_memo_file();
    let abs = base.join("does_not_exist.md");
    let result = mf.register_existing_file(&abs);
    assert!(result.is_err());
}

#[test]
fn register_existing_file_reload_when_already_in_list() {
    let (mf, base) = fresh_memo_file();
    let abs = base.join("Note.md");
    fs::write(&abs, "# title\nv1 body\n").unwrap();
    let memo1 = mf.register_existing_file(&abs).unwrap();
    // 改盘 + 再次 register → 应走 reload, 不重复 push
    fs::write(&abs, "# title\nv2 body\n").unwrap();
    let memo2 = mf.register_existing_file(&abs).unwrap();
    assert_eq!(memo1.id, memo2.id);
    let list = mf.read_index().expect("list");
    assert_eq!(list.memos.len(), 1);
    assert_eq!(memo2.preview, "v2 body"); // 第二行=
}

#[test]
fn register_unnamed_file_does_not_rename_disk() {
    let (mf, base) = fresh_memo_file();
    let abs = base.join("random-name.md");
    fs::write(&abs, "# 我的笔记\nbody").unwrap();
    let (memo, new_abs) = mf.register_unnamed_file(&abs).expect("register ok");
    // v3: 物理文件**不**重命名
    assert!(abs.exists(), "original file should remain on disk");
    assert_eq!(new_abs, abs);
    assert_eq!(memo.filename, "random-name.md");
}

#[test]
fn reconcile_picks_up_orphan_files() {
    let (mf, base) = fresh_memo_file();
    // 模拟应用关闭期间, 用户在外部新建了 2 个 .md
    fs::write(base.join("外部新增1.md"), "body1").unwrap();
    fs::write(base.join("外部新增2.md"), "body2").unwrap();
    let added = mf.reconcile_with_disk().expect("reconcile ok");
    assert_eq!(added, 2);
    assert!(mf.find_memo_by_filename("外部新增1.md").is_some());
    assert!(mf.find_memo_by_filename("外部新增2.md").is_some());
    // 物理文件名没动
    assert!(base.join("外部新增1.md").exists());
    assert!(base.join("外部新增2.md").exists());
}

#[test]
fn reconcile_skips_metadata_dir() {
    let (mf, base) = fresh_memo_file();
    let metadata = base.join(".metadata");
    fs::create_dir_all(&metadata).unwrap();
    fs::write(metadata.join("memo index"), "{}").unwrap();
    fs::write(metadata.join("todo metadata"), "{}").unwrap();
    let added = mf.reconcile_with_disk().expect("reconcile ok");
    assert_eq!(added, 0, ".metadata/ should be skipped");
}

#[test]
fn reconcile_is_idempotent() {
    let (mf, base) = fresh_memo_file();
    fs::write(base.join("once.md"), "x").unwrap();
    let first = mf.reconcile_with_disk().unwrap();
    let second = mf.reconcile_with_disk().unwrap();
    assert_eq!(first, 1);
    assert_eq!(second, 0, "second run should find nothing new");
}

// =====================================================================
// reconcile_with_disk_bidirectional: 同时注册新文件 + 清幽灵条目
// =====================================================================

#[test]
fn reconcile_bidirectional_adds_orphans_and_removes_ghosts() {
    // 场景: memo index 里有一条已存在的 entry (Ghost.md), 物理文件已被外部 rm;
    // 盘上有一个新的 .md (NewOnDisk.md) 不在 memo index 里。一次双向 sweep
    // 应该: (1) 注册 NewOnDisk.md → +1; (2) 清 Ghost.md entry → -1。
    let (mf, base) = fresh_memo_file();

    // 准备: 建 Ghost.md → 注册 (memo index 有 entry, 物理文件随后外部删)
    let ghost = mf.create_memo("Ghost", "old", None).unwrap();
    let ghost_path = base.join(&ghost.filename);
    assert!(ghost_path.exists());
    fs::remove_file(&ghost_path).unwrap();
    assert!(!ghost_path.exists(), "外部 rm 删了物理文件");
    // memo index 仍残留 ghost entry
    assert!(mf.read_memo(&ghost.id).is_some());

    // 准备: 在盘上建 NewOnDisk.md, 不通过 API 注册 (模拟外部 drop)
    fs::write(base.join("NewOnDisk.md"), "fresh content").unwrap();
    assert!(mf.find_memo_by_filename("NewOnDisk.md").is_none());

    // sweep
    let report = mf
        .reconcile_with_disk_bidirectional()
        .expect("reconcile ok");

    assert_eq!(report.added, 1, "应注册 NewOnDisk.md");
    assert_eq!(report.removed, 1, "应清 Ghost.md 幽灵条目");

    // memo index: Ghost entry 已清, NewOnDisk 已注册
    assert!(mf.read_memo(&ghost.id).is_none(), "ghost entry 应被清");
    assert!(
        mf.find_memo_by_filename("NewOnDisk.md").is_some(),
        "新文件应被注册"
    );
    // 物理文件状态: ghost 已删 (没变), new 仍在
    assert!(!ghost_path.exists());
    assert!(base.join("NewOnDisk.md").exists());
}

#[test]
fn reconcile_bidirectional_is_idempotent() {
    let (mf, base) = fresh_memo_file();
    // 建一个正常 memo + 模拟一个 ghost + 一个新文件
    let ghost = mf.create_memo("G", "x", None).unwrap();
    fs::remove_file(base.join("G.md")).unwrap();
    fs::write(base.join("N.md"), "new").unwrap();

    let first = mf.reconcile_with_disk_bidirectional().unwrap();
    assert_eq!(first.added, 1);
    assert_eq!(first.removed, 1);

    let second = mf.reconcile_with_disk_bidirectional().unwrap();
    assert_eq!(second.added, 0);
    assert_eq!(second.removed, 0);
    assert!(mf.read_memo(&ghost.id).is_none());
}

#[test]
fn reconcile_bidirectional_empty_dir_clears_all_entries() {
    // 空目录场景: memo index 有 N 条 entry, 盘上一个文件都没有。
    // sweep 后 memo index 应被清空 (用户视角: 删空了文件夹, app 应该反映)。
    let (mf, base) = fresh_memo_file();
    let _a = mf.create_memo("A", "x", None).unwrap();
    let _b = mf.create_memo("B", "y", None).unwrap();
    assert_eq!(mf.read_all_memos().len(), 2);

    // 用户把 base 下所有 .md 删空 (含 .metadata/ 不算 — 我们用物理删除 + 绕过目录)
    fs::remove_file(base.join("A.md")).unwrap();
    fs::remove_file(base.join("B.md")).unwrap();

    let report = mf.reconcile_with_disk_bidirectional().unwrap();
    assert_eq!(report.added, 0);
    assert_eq!(report.removed, 2, "空目录应清空 memo index");
    assert_eq!(mf.read_all_memos().len(), 0);
}

#[test]
fn reconcile_bidirectional_preserves_id_on_inode_rename() {
    // inode-tracker 漏命中场景: 磁盘文件 frontmatter key 命中 memo index 已有 id,
    // 但 filename 不同 (说明 inode 改了名, memo index 还没跟上)。
    // 期望: 走 rename_memo_file 路径保留 id, 把 entry.filename 改为新值;
    // 然后 prune 阶段不会把它当幽灵删掉 (因为新 filename 已在 disk_filenames)。
    let (mf, base) = fresh_memo_file();

    // 1. register 原始文件, 记下 id
    let old_path = base.join("Original.md");
    fs::write(&old_path, "# Hello\nbody\n").unwrap();
    let initial = mf.register_existing_file(&old_path).expect("register");
    let original_id = initial.id.clone();
    assert_eq!(initial.filename, "Original.md");

    // 2. 物理 rename (外部 mv), memo index 还没更新
    let new_path = base.join("Renamed.md");
    fs::rename(&old_path, &new_path).unwrap();

    // 3. sweep 双向:
    //    - disk_filenames = {"Renamed.md"}
    //    - list_filenames = {"Original.md"}
    //    - to_register = {"Renamed.md"}
    //    - to_remove = [original_id] (因为 Original.md 不在盘上)
    //    注册阶段: frontmatter key=original_id 命中 memo index 已有 entry,
    //              走 rename_memo_file → entry.filename 改为 "Renamed.md"
    //    prune 阶段: 新 entry 的 filename = "Renamed.md" ∈ disk_filenames,
    //                所以不被删
    let report = mf.reconcile_with_disk_bidirectional().unwrap();
    assert_eq!(report.added, 1, "Renamed.md 被注册");
    assert_eq!(report.removed, 0, "rename 路径保留的 entry 不应被 prune");

    // 关键断言: id 保留, 只有一条 entry, filename 已是新值
    let list = mf.read_index().expect("list");
    assert_eq!(list.memos.len(), 1, "exactly one entry");
    assert_eq!(list.memos[0].id, original_id, "id preserved");
    assert_eq!(list.memos[0].filename, "Renamed.md", "filename updated");
}

#[test]
fn reconcile_bidirectional_no_op_when_consistent() {
    // 状态一致: memo index 里所有 entry 都对应盘上文件 → (0, 0)
    let (mf, _base) = fresh_memo_file();
    let _a = mf.create_memo("A", "x", None).unwrap();
    let _b = mf.create_memo("B", "y", None).unwrap();
    let report = mf.reconcile_with_disk_bidirectional().unwrap();
    assert_eq!(report.added, 0);
    assert_eq!(report.removed, 0);
    assert_eq!(mf.read_all_memos().len(), 2);
}

#[test]
fn reconcile_bidirectional_skips_metadata_dir() {
    // .metadata/ 里的 memo index / todo metadata 不应被当成 .md 注册
    let (mf, base) = fresh_memo_file();
    let metadata = base.join(".metadata");
    fs::create_dir_all(&metadata).unwrap();
    fs::write(metadata.join("memo index"), "{}").unwrap();
    fs::write(metadata.join("todo metadata"), "{}").unwrap();
    // memo index 里没任何 entry, 也不应该被注册 (不是 .md)
    let report = mf.reconcile_with_disk_bidirectional().unwrap();
    assert_eq!(report.added, 0);
    assert_eq!(report.removed, 0);
}

// =====================================================================
// unregister_memo_by_path (lazy defense 单条兜底)
// =====================================================================

#[test]
fn reconcile_bidirectional_as_new_rekeys_existing_markdown() {
    let (mf, base) = fresh_memo_file();
    let original = mf.create_memo("Original", "# Original\n", None).unwrap();
    let imported_path = base.join("Imported.md");
    let original_content = fs::read_to_string(base.join(&original.filename)).unwrap();
    fs::write(&imported_path, original_content).unwrap();

    let report = mf.reconcile_with_disk_bidirectional_as_new().unwrap();

    assert_eq!(report.added, 1);
    let imported = mf.find_memo_by_filename("Imported.md").unwrap();
    assert_ne!(imported.id, original.id);

    let imported_content = fs::read_to_string(imported_path).unwrap();
    assert_eq!(
        super::frontmatter::extract_frontmatter_key(&imported_content),
        Some(imported.id)
    );
}

#[test]
fn unregister_clears_ghost_entry_when_file_gone() {
    // 模拟 lazy defense 触发场景: memo index 有 entry, 物理文件已 rm,
    // 用户点开了这条 → IPC read_memo 应清掉 entry。
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Ghost", "x", None).unwrap();
    fs::remove_file(base.join("Ghost.md")).unwrap();
    assert!(
        mf.read_memo(&memo.id).is_some(),
        "memo index 仍有 ghost entry"
    );

    // 模拟 IPC handler 内部: 拿到 memo 后 stat 文件, 文件不在 → 调 unregister
    let abs = base.join("Ghost.md");
    let removed = mf.unregister_memo_by_path(&abs);
    assert!(removed);
    assert!(mf.read_memo(&memo.id).is_none(), "ghost entry 已清");
}

#[test]
fn unregister_refuses_when_filename_differs() {
    // invariant guard: memo index entry.filename 拼出的绝对路径 ≠ abs_path 时拒绝删,
    // 防止 rename 旧文件 Remove 事件误删 entry。
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Hello", "x", None).unwrap();
    // 构造一个 abs_path 跟 memo index entry 不一致的请求
    let bogus_abs = base.join("Bogus.md");
    let removed = mf.unregister_memo_by_path(&bogus_abs);
    assert!(!removed, "filename 不匹配应拒绝");
    assert!(mf.read_memo(&memo.id).is_some(), "entry 仍保留");
}

// =====================================================================
// ops: reload
// =====================================================================

#[test]
fn reload_refreshes_preview_after_external_edit() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Reload", "original body\n", None).unwrap();
    fs::write(
        base.join("Reload.md"),
        "---\nfilename: Reload\n---\n# title\nchanged body\n",
    )
    .unwrap();
    let updated = mf.reload_memo_from_disk(&memo.id).expect("reload ok");
    assert_eq!(updated.filename, "Reload.md");
    assert!(updated.preview.contains("changed"));
}

// =====================================================================
// ops: unregister
// =====================================================================

#[test]
fn unregister_by_path_removes_index_entry() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Del", "x", None).unwrap();
    let abs = base.join("Del.md");
    let removed = mf.unregister_memo_by_path(&abs);
    assert!(removed);
    assert!(mf.read_memo(&memo.id).is_none());
}

#[test]
fn unregister_unknown_path_returns_false() {
    let (mf, base) = fresh_memo_file();
    let abs = base.join("NotInList.md");
    let removed = mf.unregister_memo_by_path(&abs);
    assert!(!removed);
}

// =====================================================================
// ops: sync_metadata_only
// =====================================================================

#[test]
fn sync_metadata_only_updates_list_without_disk_write() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Meta", "body\n", None).unwrap();
    let before = fs::read_to_string(base.join("Meta.md")).unwrap();

    let mut updated = memo.clone();
    updated.favorited = true;
    updated.colors = vec![super::types::MemoColor::Red];
    mf.sync_metadata_only(&updated).expect("sync ok");

    // memo index 字段已更新
    let queried = mf.read_memo(&memo.id).unwrap();
    assert!(queried.favorited);
    assert_eq!(queried.colors, vec![super::types::MemoColor::Red]);
    // 物理文件没动
    let after = fs::read_to_string(base.join("Meta.md")).unwrap();
    assert_eq!(before, after);
}

// =====================================================================
// memo index schema assertions
// =====================================================================

#[test]
fn index_does_not_persist_path_field() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.create_memo("Schema", "x", None).unwrap();
    let list = mf.read_index().unwrap();
    let v = serde_json::to_value(&list.memos[0]).unwrap();
    assert!(
        v.get("path").is_none(),
        "memo index entry must not persist path: {v}"
    );
    assert!(v["filename"].is_string());
}

#[test]
fn index_filename_is_disk_filename_with_md_suffix() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.create_memo("Hello", "x", None).unwrap();
    let list = mf.read_index().unwrap();
    assert_eq!(list.memos[0].filename, "Hello.md");
}

#[test]
fn memo_struct_has_no_path_field() {
    // 编译期保证: types::Memo 不应有 path 字段。本测试若通过, 表明 schema 正确。
    let memo: super::types::Memo = serde_json::from_value(serde_json::json!({
        "id": "abc",
        "filename": "X.md",
        "preview": "",
        "tags": [],
        "todos": [],
        "createdAt": 0,
        "updatedAt": 0,
        "favorited": false,
        "icon": null,
        "colors": []
    }))
    .unwrap();
    assert_eq!(memo.filename, "X.md");
}

// =====================================================================
// read path
// =====================================================================

#[test]
fn read_all_memos_returns_list_entries_sorted_by_created_desc() {
    let (mf, _base) = fresh_memo_file();
    let a = mf.create_memo("A", "x", None).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let b = mf.create_memo("B", "x", None).unwrap();
    let memos = mf.read_all_memos();
    assert_eq!(memos.len(), 2);
    // 后建的排前
    assert_eq!(memos[0].id, b.id);
    assert_eq!(memos[1].id, a.id);
}

#[test]
fn read_all_memos_with_body_returns_bodies() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.create_memo("X", "body-of-x\n", None).unwrap();
    let pairs = mf.read_all_memos_with_body();
    assert_eq!(pairs.len(), 1);
    assert!(pairs[0].1.contains("body-of-x"));
}

#[test]
fn read_memo_with_body_returns_full_content() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf.create_memo("Y", "body-of-y\n", None).unwrap();
    let (entry, body) = mf.read_memo_with_body(&memo.id).unwrap();
    assert_eq!(entry.filename, "Y.md");
    assert!(body.contains("body-of-y"));
}

#[test]
fn find_memo_file_path_returns_disk_path() {
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Find", "x", None).unwrap();
    let p = mf.find_memo_file_path(&memo.id).expect("path found");
    assert_eq!(p, base.join("Find.md"));
}

#[test]
fn read_all_memos_filtered_favorited() {
    let (mf, _base) = fresh_memo_file();
    let a = mf.create_memo("A", "x", None).unwrap();
    let b = mf.create_memo("B", "x", None).unwrap();
    let mut updated = b.clone();
    updated.favorited = true;
    mf.sync_metadata_only(&updated).unwrap();

    let only_fav = mf.read_all_memos_filtered("favorited", "createdAt", None);
    assert_eq!(only_fav.len(), 1);
    assert_eq!(only_fav[0].id, b.id);

    let all = mf.read_all_memos_filtered("all", "createdAt", None);
    assert_eq!(all.len(), 2);
    // favorited 置顶
    assert_eq!(all[0].id, b.id);
    assert_eq!(all[1].id, a.id);
}

// 回归测试: 带标签筛选时 (filter == "tagged"), 置顶 memo 仍需靠前.
// 之前 comparator 只在 filter == "all" 时把 favorited 放最前, 导致在
// 标签视图下设置置顶"看起来没生效". 现在任何 filter 下都应保留置顶优先.
#[test]
fn read_all_memos_filtered_tagged_pins_favorited() {
    let (mf, _base) = fresh_memo_file();
    let older = mf.create_memo("Older", "x", None).unwrap();
    let newer = mf.create_memo("Newer", "x", None).unwrap();

    // 给两条 memo 都贴同一个 tag — "newer" 写入时间更晚, 默认排序会在最前.
    let mut older = older;
    older.tags = vec!["t1".to_string()];
    let mut newer = newer;
    newer.tags = vec!["t1".to_string()];
    // 让 "older" 置顶: 置顶应压过其更老的 created_at / updated_at.
    older.favorited = true;
    mf.sync_metadata_only(&older).unwrap();
    mf.sync_metadata_only(&newer).unwrap();

    let tagged = mf.read_all_memos_filtered("tagged", "createdAt", Some("t1"));
    assert_eq!(tagged.len(), 2);
    assert_eq!(
        tagged[0].id, older.id,
        "favorited tag 必须在 tagged 视图最前"
    );
    assert_eq!(tagged[1].id, newer.id);

    let tagged_by_updated = mf.read_all_memos_filtered("tagged", "updatedAt", Some("t1"));
    assert_eq!(tagged_by_updated.len(), 2);
    assert_eq!(tagged_by_updated[0].id, older.id);
    assert_eq!(tagged_by_updated[1].id, newer.id);
}

// =====================================================================
// concurrent RMW
// =====================================================================

#[test]
fn concurrent_creates_do_not_lose_entries() {
    use std::sync::{Arc, Barrier, RwLock};
    use std::thread;

    let (mf, _base) = fresh_memo_file();
    let mf = Arc::new(RwLock::new(mf));

    const N: usize = 6;
    let barrier = Arc::new(Barrier::new(N));
    let mut handles = Vec::with_capacity(N);
    for i in 0..N {
        let mf = mf.clone();
        let barrier = barrier.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            let guard = mf.read().unwrap();
            guard
                .create_memo(&format!("Race{i}"), &format!("body {i}"), None)
                .expect("create ok");
        }));
    }
    for h in handles {
        h.join().expect("join");
    }
    let list = mf.read().unwrap().read_index().expect("list");
    assert_eq!(
        list.memos.len(),
        N,
        "all N concurrent creates should land in memo index"
    );
}

#[test]
fn no_duplicate_ids_after_concurrent_creates() {
    use std::sync::{Arc, Barrier, RwLock};
    use std::thread;

    let (mf, _base) = fresh_memo_file();
    let mf = Arc::new(RwLock::new(mf));

    const N: usize = 20;
    let barrier = Arc::new(Barrier::new(N));
    let mut handles = Vec::with_capacity(N);
    for i in 0..N {
        let mf = mf.clone();
        let barrier = barrier.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            let guard = mf.read().unwrap();
            guard
                .create_memo(&format!("X{i}"), "body", None)
                .expect("create ok");
        }));
    }
    for h in handles {
        h.join().expect("join");
    }
    let list = mf.read().unwrap().read_index().expect("list");
    let mut ids: Vec<String> = list.memos.iter().map(|e| e.id.clone()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), N, "all ids unique");
}

// =====================================================================
// helper trait
// =====================================================================

trait FullPath {
    fn filename_full_path(&self, mf: &MemoFile) -> std::path::PathBuf;
}
impl FullPath for super::types::Memo {
    fn filename_full_path(&self, mf: &MemoFile) -> std::path::PathBuf {
        mf.get_memo_base().join(&self.filename)
    }
}

// =====================================================================
// helper
// =====================================================================

fn tempdir() -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!(
        "flowix-v3-tmpdir-{}-{}-{}",
        std::process::id(),
        n,
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}

// 把测试 helper 函数 unused 抑制
#[allow(dead_code)]
fn _dummy_memo_list_file() -> MemoIndexFile {
    MemoIndexFile::default()
}

// =====================================================================
// rename_memo_file (v2 物理 rename 入口) 测试
// =====================================================================

#[test]
fn rename_memo_file_updates_list_json_filename_preserves_id() {
    // 场景: memo index 里有一条 entry { id, filename: "Hello.md" },
    // 物理文件被外部 mv 成 "Hello-renamed.md"。rename_memo_file 应该:
    // 1. 改 entry.filename → "Hello-renamed.md"
    // 2. 保留 entry.id (register 时生成的)
    // 3. 返回新的 Memo, 字段一致
    let (mf, _tmp) = fresh_memo_file();

    // 先 register 一个文件。 register_existing_file 会自己生成 6 位 id 并注入
    // frontmatter, 我们记下这个 id 用作断言。
    let old_path = mf.get_memo_base().join("Hello.md");
    fs::write(&old_path, "# body content\n").unwrap();
    let initial = mf.register_existing_file(&old_path).expect("register ok");
    let original_id = initial.id.clone();
    assert_eq!(initial.filename, "Hello.md");
    assert!(!original_id.is_empty());

    // 模拟物理 mv (外部工具 rename)
    let new_path = mf.get_memo_base().join("Hello-renamed.md");
    fs::rename(&old_path, &new_path).unwrap();
    assert!(!old_path.exists());
    assert!(new_path.exists());

    // 调 rename_memo_file — 这是 v2 inode rename 路径的唯一同步入口
    let updated = mf
        .rename_memo_file(&old_path, &new_path)
        .expect("rename_memo_file should succeed");
    assert_eq!(
        updated.id, original_id,
        "id must be preserved across physical rename"
    );
    assert_eq!(updated.filename, "Hello-renamed.md");

    // memo index 已经被同步: 旧 filename 不应再出现在 list 里
    let list = mf.read_index().expect("memo index should exist");
    let entry = list
        .memos
        .iter()
        .find(|e| e.id == original_id)
        .expect("entry still in list under original id");
    assert_eq!(entry.filename, "Hello-renamed.md");
    assert!(
        list.memos.iter().all(|e| e.filename != "Hello.md"),
        "old filename must be gone from memo index"
    );

    // 按 id 读 memo 仍能读到, filename 已是新值
    let by_id = mf.read_memo(&original_id).expect("read by id");
    assert_eq!(by_id.filename, "Hello-renamed.md");
}

#[test]
fn rename_memo_file_rejects_old_filename_not_in_list() {
    let (mf, _tmp) = fresh_memo_file();
    let old_path = mf.get_memo_base().join("NotInList.md");
    let new_path = mf.get_memo_base().join("AlsoNotInList.md");
    fs::write(&old_path, "x").unwrap();
    fs::rename(&old_path, &new_path).unwrap();
    let result = mf.rename_memo_file(&old_path, &new_path);
    assert!(result.is_err(), "old not in memo index should error");
}

#[test]
fn rename_memo_file_rejects_when_new_filename_occupied() {
    let (mf, _tmp) = fresh_memo_file();

    // 准备两个文件都注册进 memo index
    let a = mf.get_memo_base().join("A.md");
    let b = mf.get_memo_base().join("B.md");
    fs::write(&a, "---\nkey: aaa\n---\n# a\n").unwrap();
    fs::write(&b, "---\nkey: bbb\n---\n# b\n").unwrap();
    mf.register_existing_file(&a).expect("register a");
    mf.register_existing_file(&b).expect("register b");

    // 物理 rename A.md → 占 B.md 位置 (b 文件先临时挪走避免 OS 冲突)
    let b_tmp = mf.get_memo_base().join("B-tmp.md");
    fs::rename(&b, &b_tmp).unwrap();
    fs::rename(&a, &b).unwrap();

    // rename_memo_file 应当拒绝: new filename "B.md" 已被另一条 entry (id=bbb) 占用
    let result = mf.rename_memo_file(&a, &b);
    assert!(
        result.is_err(),
        "should refuse to overwrite another memo's filename"
    );

    // 清理
    fs::rename(&b_tmp, &b).ok();
}

// =====================================================================
// 物理 rename 后 inode tracker 漏命中 场景的复现测试
// =====================================================================
//
// 场景: 外部 mv Hello.md Hello-renamed.md, 但 inode tracker 没记录到
// (例如重启后第一次 notify, 或 Windows 上没有稳定 inode)。processor
// 走原 Create 分支, 调 `register_existing_file(new_path)`。
//
// 期望: memo index 里应该仍然是原来 id=abc123 的那条 entry, 仅仅
// filename 字段从 "Hello.md" 变成 "Hello-renamed.md"。
//
// 实际 (用户报告 bug): memo index 出现 id=xyz789 的新 entry, 旧的
// abc123 还在但 filename 还是 "Hello.md" (指向不存在的文件)。

#[test]
fn register_existing_file_should_preserve_id_from_frontmatter_key() {
    // 模拟场景: memo index 里有一条 entry (id=abc123, filename="Hello.md"),
    // 但 disk 上的 "Hello.md" 已经被外部 mv 到 "Hello-renamed.md"。
    // memo index 现在跟磁盘不一致 — 这是 rename 后的 race window。
    //
    // 1. 先 register "Hello.md" 建立 memo index entry
    // 2. 物理 rename 磁盘文件
    // 3. 用 frontmatter 里的 key 字段反查 memo index, 找到 id=abc123
    //    那条 entry, 改它的 filename 到 "Hello-renamed.md"
    let (mf, _tmp) = fresh_memo_file();

    // 1. register 原始文件
    let old_path = mf.get_memo_base().join("Hello.md");
    fs::write(&old_path, "# Hello\nworld\n").unwrap();
    let initial = mf.register_existing_file(&old_path).expect("register ok");
    let original_id = initial.id.clone();
    assert_eq!(initial.filename, "Hello.md");

    // 模拟 inode tracker 漏命中 — 外部 mv 后 memo index 还没更新。
    // 我们手工把 memo index 的 entry.filename 改成 "Hello-renamed.md"
    // (模拟 rename_memo_file 已经走过) — 不, 实际场景是 inode tracker
    // 漏命中, rename_memo_file 没被调, memo index 里仍是 "Hello.md"。
    // 但磁盘上已经没 "Hello.md" 了。
    //
    // 重新设计: 模拟 inode tracker 漏命中意味着 processor 把这个事件
    // 当 Create 走。 此时 memo index 里还是旧 filename "Hello.md",
    // 但磁盘上是 "Hello-renamed.md"。
    // 走 register_existing_file("Hello-renamed.md") 时:
    //   - find_memo_by_filename("Hello-renamed.md") → None (memo index 还没改)
    //   - 生成新 id, 用新 id 覆盖磁盘 frontmatter key
    //   - 写 memo index, 出现 entry { id=new_id, filename="Hello-renamed.md" }
    //   - 旧 entry { id=original_id, filename="Hello.md" } 仍残留, 指向不存在的文件
    let new_path = mf.get_memo_base().join("Hello-renamed.md");
    fs::rename(&old_path, &new_path).unwrap();
    let rereg = mf.register_existing_file(&new_path).expect("register ok");

    // v2 修复: id 必须保留, 不生成新 id。
    // 修复前 register_existing_file 走 "filename 不在 memo index → 生成新 id" 路径,
    // 物理 rename 后旧 entry 残留, 新 entry 出现, 同一份磁盘内容被注册成两条 memo。
    assert_eq!(
        rereg.id, original_id,
        "register_existing_file must preserve id from disk frontmatter key"
    );
    assert_eq!(rereg.filename, "Hello-renamed.md");

    // 关键: memo index 里**只剩一条** entry, 没有 id 漂移
    let list = mf.read_index().expect("memo index");
    let with_id = list.memos.iter().filter(|e| e.id == original_id).count();
    assert_eq!(with_id, 1, "exactly one entry with original id");
    // 且这条 entry 的 filename 已经是新值
    let entry = list.memos.iter().find(|e| e.id == original_id).unwrap();
    assert_eq!(entry.filename, "Hello-renamed.md");
}

// =====================================================================
// 端到端: 物理 rename 后磁盘 frontmatter 的 key 是否真的保持不变
// =====================================================================
#[test]
fn physical_rename_does_not_change_frontmatter_key_on_disk() {
    let (mf, _tmp) = fresh_memo_file();
    // 1. register
    let old_path = mf.get_memo_base().join("Hello.md");
    fs::write(&old_path, "# Hello\nworld\n").unwrap();
    let m = mf.register_existing_file(&old_path).expect("register");
    let original_id = m.id.clone();
    let key_after_register = read_key_from_disk(&old_path);
    assert_eq!(
        key_after_register.as_deref(),
        Some(original_id.as_str()),
        "after register, key on disk should match id"
    );

    // 2. physical rename
    let new_path = mf.get_memo_base().join("Hello-renamed.md");
    fs::rename(&old_path, &new_path).unwrap();
    let key_after_rename = read_key_from_disk(&new_path);
    assert_eq!(
        key_after_rename.as_deref(),
        Some(original_id.as_str()),
        "after physical rename, key on disk should still be the original id"
    );

    // 3. what does rename_memo_file do to the disk?
    mf.rename_memo_file(&old_path, &new_path).expect("rename");
    let key_after_rename_memo_file = read_key_from_disk(&new_path);
    eprintln!("original_id={:?}", original_id);
    eprintln!(
        "key on disk after rename_memo_file = {:?}",
        key_after_rename_memo_file
    );
    // 这个断言**会失败**如果 rename_memo_file 把 disk key 改了
    assert_eq!(
        key_after_rename_memo_file.as_deref(),
        Some(original_id.as_str()),
        "rename_memo_file must NOT change frontmatter key on disk (it's id-bound)"
    );
}

fn read_key_from_disk(path: &Path) -> Option<String> {
    use super::frontmatter::extract_frontmatter_key;
    let content = std::fs::read_to_string(path).ok()?;
    extract_frontmatter_key(&content)
}

// =====================================================================
// v2 inode-rename: 模拟 Remove(old) + Create(new) 事件序列 (不通过 notify)
// 验证 memo index 的 entry 仍然只有 1 条, id 保留。
// =====================================================================
#[test]
fn rename_via_remove_create_pair_preserves_id() {
    // 这测的是 inode tracker 命中时 Remove 事件被拦截 + Create 走 rename 配对的
    // 协同行为, 但 MemoFile 层不直接持有 inode tracker, 测的是 memo index
    // 同步结果。 processor 层的 inode 检查是 desktop 端。

    // 替代方案: 直接测 register_existing_file + unregister_memo_by_path 在
    // inode 命中 (即 tracker 里有该 inode) 时的等价行为: 不 unregister,
    // 让 register_existing_file 抽 frontmatter key 反查保留 id。
    let (mf, _tmp) = fresh_memo_file();

    // 1. 原始文件
    let old_path = mf.get_memo_base().join("Hello.md");
    fs::write(&old_path, "# Hello\nworld\n").unwrap();
    let initial = mf.register_existing_file(&old_path).expect("register ok");
    let original_id = initial.id.clone();

    // 2. 物理 rename
    let new_path = mf.get_memo_base().join("Hello-renamed.md");
    fs::rename(&old_path, &new_path).unwrap();

    // 3. 模拟 processor 在 inode 命中时:
    //    - Remove(old_path) 事件被 inode tracker 拦截, 不调 unregister
    //    - Create(new_path) 事件调 rename_memo_file(old, new) 同步 memo index
    mf.rename_memo_file(&old_path, &new_path)
        .expect("rename should succeed");

    // 4. 关键断言: memo index 只有一条 entry, id 保留
    let list = mf.read_index().expect("list");
    assert_eq!(list.memos.len(), 1, "exactly one entry remains");
    assert_eq!(list.memos[0].id, original_id, "id preserved");
    assert_eq!(
        list.memos[0].filename, "Hello-renamed.md",
        "filename updated"
    );
}

#[test]
fn rename_via_remove_create_pair_id_preserved_even_if_remove_already_called() {
    // 兜底测试: 即便 Remove 事件**已经**调了 unregister (tracker 漏命中
    // 或 Windows), Create 事件的 register_existing_file 走 frontmatter
    // key 反查 → rename_memo_file 重建 memo index (保留 id)。

    let (mf, _tmp) = fresh_memo_file();
    let old_path = mf.get_memo_base().join("Hello.md");
    fs::write(&old_path, "# Hello\nworld\n").unwrap();
    let initial = mf.register_existing_file(&old_path).expect("register ok");
    let original_id = initial.id.clone();

    let new_path = mf.get_memo_base().join("Hello-renamed.md");
    fs::rename(&old_path, &new_path).unwrap();

    // 模拟 Remove 事件先到, 已经把 memo index 的 entry 删了
    let removed = mf.unregister_memo_by_path(&old_path);
    assert!(removed, "should remove the entry");
    let list = mf.read_index().expect("list");
    assert_eq!(list.memos.len(), 0, "list is empty after remove");

    // 模拟 Create 事件到, register_existing_file 走 frontmatter key 反查
    let rereg = mf
        .register_existing_file(&new_path)
        .expect("register should succeed via frontmatter key fallback");
    assert_eq!(
        rereg.id, original_id,
        "id must be preserved via frontmatter key"
    );
    assert_eq!(rereg.filename, "Hello-renamed.md");

    let list = mf.read_index().expect("list");
    assert_eq!(list.memos.len(), 1, "exactly one entry restored");
    assert_eq!(list.memos[0].id, original_id);
    assert_eq!(list.memos[0].filename, "Hello-renamed.md");
}

// =====================================================================
// atomic_write_bytes
// =====================================================================
//
// 核心契约:
//   1. 调用前 final 路径是旧内容 → 写完后磁盘上是新内容 (基本写)
//   2. 调用前 final 路径不存在 → 写完后是新内容, tmp 不残留
//   3. 多次连续调用 → 每次落盘都是完整新内容, 没有截断窗口
//   4. 跟 read 路径一致 ── 即 `read_to_string` 拿回的内容跟写入 bytes 相同
//
// 掉电模拟 (`panic!` 注入到 helper 内部) 单元测试难以在稳定条件下复现 ──
// 真正的"无截断"保证由 temp + fsync + rename 的实现模式提供, 在 Linux 上
// rename(2) 跟 Windows 上 MoveFileExW 都是原子; 这里只断言"能正确写完整内容"。

#[test]
fn atomic_write_bytes_writes_complete_content() {
    let (_mf, tmp) = fresh_memo_file();
    let target = tmp.join("note.md");
    let body = "---\nkey: abc123\n---\n# Hello\n\nbody content\n";
    atomic_write_bytes(&target, body.as_bytes()).unwrap();
    let on_disk = fs::read_to_string(&target).unwrap();
    assert_eq!(on_disk, body);
}

#[test]
fn atomic_write_bytes_creates_parent_dirs() {
    let (_mf, tmp) = fresh_memo_file();
    let nested = tmp.join("a").join("b").join("note.md");
    let body = "x";
    atomic_write_bytes(&nested, body.as_bytes()).unwrap();
    assert_eq!(fs::read_to_string(&nested).unwrap(), body);
}

#[test]
fn atomic_write_bytes_overwrites_existing_file() {
    let (_mf, tmp) = fresh_memo_file();
    let target = tmp.join("note.md");
    fs::write(&target, "old content").unwrap();
    let new_body = "new content\n---\nkey: z9y8x7\n";
    atomic_write_bytes(&target, new_body.as_bytes()).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), new_body);
}

#[test]
fn atomic_write_bytes_no_tmp_file_leaks() {
    let (_mf, tmp) = fresh_memo_file();
    let target = tmp.join("note.md");
    atomic_write_bytes(&target, b"x").unwrap();
    atomic_write_bytes(&target, b"yy").unwrap();
    atomic_write_bytes(&target, b"zzz").unwrap();
    // 多次连续写, 不应留下任何 .tmp.<pid>.<nanos> 残留
    let stale: Vec<_> = fs::read_dir(&tmp)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
        .collect();
    assert!(stale.is_empty(), "tmp files leaked: {:?}", stale);
}

// =====================================================================
// 内存缓存 (P0 性能修复后新增)
// =====================================================================
//
// 覆盖 `MemoFile` 内 `index_cache` / `notebook_configs_cache` 的语义:
// - 命中: 走内存, 不读盘
// - 失效: `set_current_notebook` 改 id 时清空 (memo index 路径变了)
// - 同步: `write_index` / `write_notebook_configs` 落盘成功后回填 cache,
//         落盘失败时 cache 保持旧值 (回看 `index_store.rs` 顺序约定)
//
// 用法上跟其他 ops 测试一样用 `fresh_memo_file` 起 tempdir + notebook.json。

#[test]
fn index_cache_populated_on_first_read() {
    let (mf, _base) = fresh_memo_file();
    // cache 起始为空: 第一次 read_index 走磁盘, 然后回填
    assert!(mf.index_cache.read().unwrap().is_none());
    let _ = mf.create_memo("Hello", "x", None).unwrap(); // 写 memo index + 填 cache
                                                         // write_index 已经回填 cache, 下次 read_index 不应该重新 parse
    let cached_before = mf.index_cache.read().unwrap().clone();
    assert!(
        cached_before.is_some(),
        "cache should be populated after write"
    );

    // 第二次读: 内部走 cache, 返回数据应跟首次一致
    let list_via_cache = mf.read_index().expect("list");
    assert_eq!(list_via_cache.memos.len(), 1);
    assert_eq!(list_via_cache.memos[0].filename, "Hello.md");
    // 缓存仍持有原引用 (read_index 在 cache 命中时走 clone, 不更新内部状态)
    assert!(
        mf.index_cache.read().unwrap().is_some(),
        "cache should remain populated"
    );
}

#[test]
fn index_cache_invalidation_on_notebook_switch() {
    let (mut mf, _base) = fresh_memo_file();
    mf.create_memo("A", "x", None).unwrap();
    assert!(mf.index_cache.read().unwrap().is_some(), "cache populated");

    // 改 current_notebook_id → cache 应清空
    mf.set_current_notebook(Some("nb_other".to_string()));
    assert!(
        mf.index_cache.read().unwrap().is_none(),
        "cache should be cleared on notebook switch"
    );

    // 切回原 id → cache 仍然为空 (因为同 id 重复设置时不清),
    // 但 set_current_notebook 不重读盘 ── 下次 read_index 才会加载。
    mf.set_current_notebook(Some("nb_test".to_string()));
    let list = mf.read_index().expect("list re-loads from new disk state");
    assert_eq!(
        list.memos.len(),
        1,
        "should reload original notebook's data"
    );
}

#[test]
fn index_cache_invalidation_same_id_is_noop() {
    let (mf, _base) = fresh_memo_file();
    mf.create_memo("A", "x", None).unwrap();
    assert!(mf.index_cache.read().unwrap().is_some());

    // 同 id 重复设置 → cache 保留
    let mut mf = mf;
    mf.set_current_notebook(Some("nb_test".to_string()));
    assert!(
        mf.index_cache.read().unwrap().is_some(),
        "same-id set_current_notebook should not invalidate cache"
    );
}

#[test]
fn index_cache_disk_and_memory_coherent_after_write() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf.create_memo("Hello", "body1", None).unwrap();

    // write_memo 内部走 sync_index_on_write_locked → write_index (cache 同步)
    let _ = mf.write_memo(&memo.id, "body2\n").expect("write ok");

    // cache 内容跟 index.db 一致
    let cached = mf.read_index().expect("cached list");
    mf.invalidate_caches();
    let from_db = mf.read_index().expect("db list");
    assert_eq!(cached.memos.len(), from_db.memos.len());
    assert_eq!(cached.memos[0].filename, from_db.memos[0].filename);
    assert_eq!(cached.memos[0].updated_at, from_db.memos[0].updated_at);
}

#[test]
fn notebook_configs_cache_populated_on_first_read() {
    let (mf, _base) = fresh_memo_file();
    // fresh_memo_file 写过一次 notebook.json 到磁盘, 但 cache 此时还是 None
    // (cache 不会在 new() 自动加载, 等首次 read 触发)。
    let configs = mf.read_notebook_configs().expect("read ok");
    assert_eq!(configs.len(), 1);
    assert!(
        mf.notebook_configs_cache.read().unwrap().is_some(),
        "cache should be populated after first read"
    );
}

#[test]
fn corrupt_notebook_config_returns_error_without_caching() {
    let (mf, _base) = fresh_memo_file();
    fs::write(mf.get_notebook_file_path(), "{not json").unwrap();

    let err = mf.read_notebook_configs().unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    assert!(
        mf.notebook_configs_cache.read().unwrap().is_none(),
        "corrupt config must not populate cache"
    );
}

#[test]
fn notebook_configs_cache_updates_on_write() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.read_notebook_configs().expect("read ok");

    let new_nb = super::types::NotebookConfig {
        id: "nb_extra".to_string(),
        name: "Extra".to_string(),
        icon: None,
        path: "/tmp/extra/".to_string(),
        is_default: false,
        created_at: 1,
        updated_at: 1,
    };
    let mut configs = mf.read_notebook_configs().unwrap();
    configs.push(new_nb);
    mf.write_notebook_configs(&configs).expect("write ok");

    // cache 已经被 write 路径回填
    let cached = mf.read_notebook_configs().expect("read ok");
    assert_eq!(cached.len(), 2, "cache should reflect new entry");
    assert!(cached.iter().any(|c| c.id == "nb_extra"));
}

#[test]
fn notebook_configs_cache_survives_notebook_switch() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.read_notebook_configs().expect("read ok");
    assert!(mf.notebook_configs_cache.read().unwrap().is_some());

    // notebook.json 位置固定, 切 notebook 不应清 cache
    let mut mf = mf;
    mf.set_current_notebook(Some("nb_test".to_string()));
    mf.set_current_notebook(Some("nb_other".to_string()));
    assert!(
        mf.notebook_configs_cache.read().unwrap().is_some(),
        "notebook_configs_cache should survive notebook switch (path is fixed)"
    );
}

#[test]
fn invalidate_caches_clears_both() {
    let (mf, _base) = fresh_memo_file();
    mf.create_memo("A", "x", None).unwrap();
    let _ = mf.read_notebook_configs().expect("read ok");
    assert!(mf.index_cache.read().unwrap().is_some());
    assert!(mf.notebook_configs_cache.read().unwrap().is_some());

    mf.invalidate_caches();
    assert!(mf.index_cache.read().unwrap().is_none());
    assert!(mf.notebook_configs_cache.read().unwrap().is_none());
}

#[test]
fn read_index_returns_none_for_missing_file_without_caching() {
    let (mf, _base) = fresh_memo_file();

    let result = mf.read_index();
    assert!(result.is_none());
    // 文件不存在 → 不写 cache (避免一次写锁, 下次 save 路径自然会建 cache)
    assert!(
        mf.index_cache.read().unwrap().is_none(),
        "missing file should not populate cache with empty/None"
    );
}

// =====================================================================
// rederive 迁移测试 — 旧 regex 提取的扁平 tag 在升级到 path-style regex
// 后批量重派生, 不需要逐条手动 re-save。
// =====================================================================

/// 在 `fresh_memo_file` 基础上, 把 memo 的 memo_tags 直接改写成"旧
/// 提取"形态 (e.g. `["中国"]`), 模拟存量数据。
fn force_memo_tags(mf: &MemoFile, memo_id: &str, tags: &[&str]) {
    let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    tx.execute("DELETE FROM memo_tags WHERE memo_id = ?1", [memo_id])
        .unwrap();
    for tag in tags {
        tx.execute(
            "INSERT INTO memo_tags (memo_id, tag) VALUES (?1, ?2)",
            (memo_id, *tag),
        )
        .unwrap();
    }
    tx.commit().unwrap();
}

fn read_memo_tags(mf: &MemoFile, memo_id: &str) -> Vec<String> {
    let conn = rusqlite::Connection::open(mf.get_index_db_path()).unwrap();
    let mut stmt = conn
        .prepare("SELECT tag FROM memo_tags WHERE memo_id = ?1 ORDER BY rowid ASC")
        .unwrap();
    stmt.query_map([memo_id], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn rederive_migration_upgrades_path_style_tag() {
    // 准备: 创建一个 memo, body 包含 `#中国/台湾` (path-style)。
    let (mf, _base) = fresh_memo_file();
    let memo = mf
        .create_memo("Travel note", "正文 #中国/台湾", None)
        .unwrap();
    // 模拟"旧 regex 提取"留下的扁平 tags (这是用户当前数据库的实际状态)
    force_memo_tags(&mf, &memo.id, &["中国"]);

    // 跑迁移
    let rewritten = mf
        .rederive_all_memos_for_notebook_id_locked("nb_test")
        .unwrap();
    assert_eq!(rewritten, 1, "应识别一条 memo 的 tags 变化并写回");

    // 验证: memo_tags 现在是 ["中国/台湾"]
    let tags = read_memo_tags(&mf, &memo.id);
    assert_eq!(tags, vec!["中国/台湾".to_string()]);
}

#[test]
fn rederive_migration_is_idempotent_for_unchanged_tags() {
    // 准备: 创建 memo, body 包含 `#simple` (扁平 tag, 旧/新 regex 都提这一个)
    let (mf, _base) = fresh_memo_file();
    let memo = mf.create_memo("Flat", "正文 #simple", None).unwrap();

    // 跑一次迁移 (第一次, 应当 no-op 因为 tags 没变)
    let first = mf
        .rederive_all_memos_for_notebook_id_locked("nb_test")
        .unwrap();
    assert_eq!(first, 0, "tags 已正确, 迁移应 no-op");

    // 再跑一次还是 no-op
    let second = mf
        .rederive_all_memos_for_notebook_id_locked("nb_test")
        .unwrap();
    assert_eq!(second, 0, "idempotent: 第二次仍应 no-op");

    let tags = read_memo_tags(&mf, &memo.id);
    assert_eq!(tags, vec!["simple".to_string()]);
}

#[test]
fn rederive_migration_handles_multiple_path_tags() {
    // body 含多个 path-style tag, 旧 regex 全部截断成第一段。
    // 旧 regex 提取结果: ["旅行", "简单"] (去重后) — `旅行/泰国/曼谷` 和
    // `旅行/日本` 在旧 regex 下都被截成 `旅行`, SQLite UNIQUE 约束
    // (memo_id, tag) 自然去重为单条 `旅行`。
    let (mf, _base) = fresh_memo_file();
    let memo = mf
        .create_memo("Multi", "正文 #旅行/泰国/曼谷 #旅行/日本 #简单", None)
        .unwrap();
    // 模拟旧提取: 扁平值 (去重后)
    force_memo_tags(&mf, &memo.id, &["旅行", "简单"]);

    let rewritten = mf
        .rederive_all_memos_for_notebook_id_locked("nb_test")
        .unwrap();
    assert_eq!(rewritten, 1, "该 memo 的 tags 整体变化, 应算一条迁移");

    let tags = read_memo_tags(&mf, &memo.id);
    // 三个 path 全部升级
    assert!(tags.contains(&"旅行/泰国/曼谷".to_string()));
    assert!(tags.contains(&"旅行/日本".to_string()));
    assert!(tags.contains(&"简单".to_string()));
    // 旧的扁平 "旅行" 不应再存在
    assert!(!tags.contains(&"旅行".to_string()));
}

#[test]
fn rederive_migration_skips_missing_disk_file() {
    // 准备: 注册一个 memo, 但磁盘文件已被删
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Ghost", "正文 #foo", None).unwrap();
    force_memo_tags(&mf, &memo.id, &["foo"]);
    // 删磁盘文件
    fs::remove_file(base.join(&memo.filename)).unwrap();
    // 注册表仍有 entry (通过 register_existing_file 重建 memo index)
    // 这里直接调用 rederive ── 必须跳过 (read 失败 → continue)
    let rewritten = mf
        .rederive_all_memos_for_notebook_id_locked("nb_test")
        .unwrap();
    // 跳过 = 没写回
    assert_eq!(rewritten, 0, "缺失磁盘文件应跳过, 不应 panic");
}

// =====================================================================
// move_memo_tag_locked 单测 — Step 3 的核心 IPC 后端。
// =====================================================================

fn read_body(mf: &MemoFile, filename: &str) -> String {
    let path = mf.get_memo_base().join(filename);
    fs::read_to_string(path).unwrap()
}

#[test]
fn move_tag_rewrites_exact_match_in_body() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf
        .create_memo("Move exact", "正文 #旅行/曼谷 末尾", None)
        .unwrap();

    let report = mf
        .move_memo_tag_locked(Some("nb_test"), "旅行/曼谷", "中国/曼谷")
        .unwrap();
    assert_eq!(report.affected_memos, 1);
    assert!(
        report
            .renamed_tags
            .iter()
            .any(|(o, n)| o == "旅行/曼谷" && n == "中国/曼谷"),
        "renamed_tags 应包含 (旅行/曼谷, 中国/曼谷): {:?}",
        report.renamed_tags
    );

    // 验证 body 改写
    let body = read_body(&mf, &memo.filename);
    assert!(body.contains("#中国/曼谷"), "body 应含新路径: {body}");
    assert!(!body.contains("#旅行/曼谷"), "body 不应再含旧路径: {body}");

    // 验证 memo_tags 同步
    let tags = read_memo_tags(&mf, &memo.id);
    assert_eq!(tags, vec!["中国/曼谷".to_string()]);
}

#[test]
fn move_tag_rewrites_subtree_in_body() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf
        .create_memo(
            "Move subtree",
            "见 #旅行/曼谷 和 #旅行/曼谷/住 和 #旅行/曼谷/吃/路边摊",
            None,
        )
        .unwrap();

    let report = mf
        .move_memo_tag_locked(Some("nb_test"), "旅行/曼谷", "中国/曼谷")
        .unwrap();
    assert_eq!(report.affected_memos, 1);

    let body = read_body(&mf, &memo.filename);
    assert!(body.contains("#中国/曼谷"));
    assert!(body.contains("#中国/曼谷/住"));
    assert!(body.contains("#中国/曼谷/吃/路边摊"));
    assert!(!body.contains("#旅行/曼谷/"));
    assert!(
        !body.contains("#旅行/曼谷 "),
        "单空格的 #旅行/曼谷 也不应残留"
    );

    let tags = read_memo_tags(&mf, &memo.id);
    assert!(tags.contains(&"中国/曼谷".to_string()));
    assert!(tags.contains(&"中国/曼谷/住".to_string()));
    assert!(tags.contains(&"中国/曼谷/吃/路边摊".to_string()));
}

#[test]
fn move_tag_leaves_unrelated_tags_intact() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf
        .create_memo("Unrelated", "#旅行/曼谷 正文 #旅行 正文 #泰国/曼谷", None)
        .unwrap();

    mf.move_memo_tag_locked(Some("nb_test"), "旅行/曼谷", "中国/曼谷")
        .unwrap();

    let body = read_body(&mf, &memo.filename);
    // #旅行 不变 (不是 #旅行/曼谷 的子树)
    assert!(body.contains("#旅行 "), "#旅行 不应被改: {body}");
    // #泰国/曼谷 不变 (前缀不匹配)
    assert!(body.contains("#泰国/曼谷"), "#泰国/曼谷 不应被改: {body}");
    // #旅行/曼谷 被改
    assert!(body.contains("#中国/曼谷"));
    assert!(!body.contains("#旅行/曼谷/") && !body.contains("#旅行/曼谷 "));

    let tags = read_memo_tags(&mf, &memo.id);
    assert!(tags.contains(&"中国/曼谷".to_string()));
    assert!(tags.contains(&"旅行".to_string()));
    assert!(tags.contains(&"泰国/曼谷".to_string()));
}

#[test]
fn move_tag_rejects_invalid_paths() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.create_memo("Any", "#x", None).unwrap();

    // 含 //
    assert!(mf
        .move_memo_tag_locked(Some("nb_test"), "a//b", "c")
        .is_err());
    // 末尾 /
    assert!(mf
        .move_memo_tag_locked(Some("nb_test"), "a/b/", "c")
        .is_err());
    // 首字符 /
    assert!(mf.move_memo_tag_locked(Some("nb_test"), "/a", "c").is_err());
}

#[test]
fn move_tag_rejects_target_conflict() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.create_memo("A", "#旅行/曼谷", None).unwrap();
    let _ = mf.create_memo("B", "#中国/曼谷", None).unwrap();

    // 已有 "中国/曼谷" → 移动 "旅行/曼谷" → "中国/曼谷" 冲突
    let err = mf
        .move_memo_tag_locked(Some("nb_test"), "旅行/曼谷", "中国/曼谷")
        .unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
}

#[test]
fn move_tag_same_path_is_noop() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.create_memo("Same", "#旅行/曼谷", None).unwrap();

    let report = mf
        .move_memo_tag_locked(Some("nb_test"), "旅行/曼谷", "旅行/曼谷")
        .unwrap();
    assert_eq!(report.affected_memos, 0);
    assert!(report.renamed_tags.is_empty());
}

#[test]
fn move_tag_handles_multiple_memos() {
    let (mf, _base) = fresh_memo_file();
    let a = mf.create_memo("A", "#旅行/曼谷", None).unwrap();
    let b = mf
        .create_memo("B", "#旅行 正文 #旅行/曼谷/住", None)
        .unwrap();
    let _c = mf.create_memo("C", "#不相关", None).unwrap(); // 不应被影响

    let report = mf
        .move_memo_tag_locked(Some("nb_test"), "旅行/曼谷", "中国/曼谷")
        .unwrap();
    // A 和 B 都有 #旅行/曼谷 或其子树, 都被改
    assert_eq!(report.affected_memos, 2);

    // 验证 C 完全没动
    let c_tags = read_memo_tags(&mf, &_c.id);
    assert_eq!(c_tags, vec!["不相关".to_string()]);

    // 验证 A, B
    let a_tags = read_memo_tags(&mf, &a.id);
    let b_tags = read_memo_tags(&mf, &b.id);
    assert!(a_tags.contains(&"中国/曼谷".to_string()));
    assert!(b_tags.contains(&"中国/曼谷/住".to_string()));
    assert!(b_tags.contains(&"旅行".to_string()), "#旅行 不应被改");
}

#[test]
fn move_tag_preserves_frontmatter_key() {
    let (mf, _base) = fresh_memo_file();
    let memo = mf.create_memo("FM", "正文 #旅行/曼谷", None).unwrap();
    let original_key = memo.id.clone();

    mf.move_memo_tag_locked(Some("nb_test"), "旅行/曼谷", "中国/曼谷")
        .unwrap();

    let body = read_body(&mf, &memo.filename);
    // frontmatter key 必须保留 (跟原 memo id 一致)
    let key = super::frontmatter::extract_frontmatter_key(&body);
    assert_eq!(
        key,
        Some(original_key),
        "frontmatter key 必须在改写后保留: body = {body}"
    );
}

#[test]
fn move_tag_no_match_returns_zero_affected() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.create_memo("Empty", "正文 no tags", None).unwrap();

    let report = mf
        .move_memo_tag_locked(Some("nb_test"), "旅行/曼谷", "中国/曼谷")
        .unwrap();
    assert_eq!(report.affected_memos, 0);
    assert!(report.renamed_tags.is_empty());
}

// Step 3+: 路径式 tag 选中某 segment 时 (e.g. `中国`), filter 应
// 包含所有前缀匹配的 memo (`中国` / `中国/湖南` / `中国/湖南/长沙` 都命中)。
#[test]
fn read_all_memos_filtered_tagged_with_path_prefix() {
    let (mf, _base) = fresh_memo_file();
    let m_china = mf.create_memo("CN", "x", None).unwrap();
    let m_hunan = mf.create_memo("HN", "x", None).unwrap();
    let m_changsha = mf.create_memo("CS", "x", None).unwrap();
    let m_thailand = mf.create_memo("TH", "x", None).unwrap();
    let m_unrelated = mf.create_memo("X", "x", None).unwrap();

    let mut assign = |memo: super::types::Memo, tags: &[&str]| {
        let mut memo = memo;
        memo.tags = tags.iter().map(|s| s.to_string()).collect();
        mf.sync_metadata_only(&memo).unwrap();
    };
    assign(m_china.clone(), &["中国"]);
    assign(m_hunan.clone(), &["中国/湖南"]);
    assign(m_changsha.clone(), &["中国/湖南/长沙"]);
    assign(m_thailand.clone(), &["泰国"]);
    assign(m_unrelated.clone(), &["不相关"]);

    // 选 `中国` → 命中 3 条 (中国, 中国/湖南, 中国/湖南/长沙)
    let hit = mf.read_all_memos_filtered("tagged", "createdAt", Some("中国"));
    let hit_ids: Vec<_> = hit.iter().map(|m| m.id.clone()).collect();
    assert_eq!(hit_ids.len(), 3, "中国 prefix 应命中 3 条: {hit_ids:?}");
    assert!(hit_ids.contains(&m_china.id));
    assert!(hit_ids.contains(&m_hunan.id));
    assert!(hit_ids.contains(&m_changsha.id));
    assert!(
        !hit_ids.contains(&m_thailand.id),
        "泰国 不应被中国 prefix 命中"
    );
    assert!(!hit_ids.contains(&m_unrelated.id));

    // 选 `中国/湖南` → 命中 2 条 (中国/湖南, 中国/湖南/长沙)
    let hit = mf.read_all_memos_filtered("tagged", "createdAt", Some("中国/湖南"));
    let hit_ids: Vec<_> = hit.iter().map(|m| m.id.clone()).collect();
    assert_eq!(
        hit_ids.len(),
        2,
        "中国/湖南 prefix 应命中 2 条: {hit_ids:?}"
    );
    assert!(hit_ids.contains(&m_hunan.id));
    assert!(hit_ids.contains(&m_changsha.id));
    assert!(
        !hit_ids.contains(&m_china.id),
        "中国 自身不应被 中国/湖南 命中"
    );

    // 选 `中国/湖南/长沙` → 命中 1 条 (精确匹配)
    let hit = mf.read_all_memos_filtered("tagged", "createdAt", Some("中国/湖南/长沙"));
    let hit_ids: Vec<_> = hit.iter().map(|m| m.id.clone()).collect();
    assert_eq!(hit_ids.len(), 1);
    assert_eq!(hit_ids[0], m_changsha.id);

    // 子串不命中: 选 `中` 不应匹配任何 (整段前缀, 不做 contains 模糊)
    let hit = mf.read_all_memos_filtered("tagged", "createdAt", Some("中"));
    assert!(hit.is_empty(), "子串 `中` 不应命中任何 memo");
}

// =====================================================================
// read_tag_prefix_counts_for_notebook_id — 侧栏树节点数显示
// (按 distinct memo 数, 不按 tag 数累加)
// =====================================================================

#[test]
fn tag_prefix_counts_use_distinct_memos_not_tag_sum() {
    let (mf, _base) = fresh_memo_file();
    let a = mf.create_memo("A", "x", None).unwrap();
    let b = mf.create_memo("B", "x", None).unwrap();
    let c = mf.create_memo("C", "x", None).unwrap();

    // A: 中国/湖南, 中国/广东 (2 个子 tag)
    // B: 中国/湖南 (1 个子 tag)
    // C: 中国/湖南/长沙 (1 个孙 tag)
    //
    // 期望 (按 distinct memo 数):
    //   中国         = 3 (A, B, C)
    //   中国/湖南     = 3 (A, B, C)
    //   中国/广东     = 1 (A only)
    //   中国/湖南/长沙 = 1 (C only)
    let mut assign = |memo: super::types::Memo, tags: &[&str]| {
        let mut memo = memo;
        memo.tags = tags.iter().map(|s| s.to_string()).collect();
        mf.sync_metadata_only(&memo).unwrap();
    };
    assign(a.clone(), &["中国/湖南", "中国/广东"]);
    assign(b.clone(), &["中国/湖南"]);
    assign(c.clone(), &["中国/湖南/长沙"]);

    let counts = mf
        .read_tag_prefix_counts_for_notebook_id(Some("nb_test"))
        .unwrap();

    assert_eq!(counts.get("中国").copied(), Some(3), "中国 应有 3 个 memo");
    assert_eq!(
        counts.get("中国/湖南").copied(),
        Some(3),
        "中国/湖南 应有 3 个 memo (A, B, C)"
    );
    assert_eq!(
        counts.get("中国/广东").copied(),
        Some(1),
        "中国/广东 应有 1 个 memo (A only)"
    );
    assert_eq!(
        counts.get("中国/湖南/长沙").copied(),
        Some(1),
        "中国/湖南/长沙 应有 1 个 memo (C only)"
    );
    // 不在 schema 里的 prefix 不应出现
    assert!(counts.get("泰国").is_none());
}

#[test]
fn tag_prefix_counts_empty_notebook_returns_empty_map() {
    let (mf, _base) = fresh_memo_file();
    let counts = mf
        .read_tag_prefix_counts_for_notebook_id(Some("nb_test"))
        .unwrap();
    assert!(counts.is_empty());
}

#[test]
fn tag_prefix_counts_single_segment_works() {
    // 单段 tag 也应入 prefix counts map
    let (mf, _base) = fresh_memo_file();
    let m = mf.create_memo("M", "x", None).unwrap();
    let mut m = m;
    m.tags = vec!["中国".to_string()];
    mf.sync_metadata_only(&m).unwrap();

    let counts = mf
        .read_tag_prefix_counts_for_notebook_id(Some("nb_test"))
        .unwrap();
    assert_eq!(counts.get("中国").copied(), Some(1));
}
