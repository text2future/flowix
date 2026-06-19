//! v3 单测 — 围绕 `ops` 原语 + index.json 真源语义。
//!
//! 覆盖:
//! - helpers: `sanitize_filename_component` / `base_filename` / `resolve_filename_conflict` /
//!   `build_md_content`
//! - ops: `create_memo` / `rename_memo` / `write_memo` / `delete_memo` /
//!   `register_existing_file` / `register_unnamed_file` / `reconcile_with_disk` /
//!   `reload_memo_from_disk` / `unregister_memo_by_path` / `sync_metadata_only` /
//!   `find_memo_by_filename` / `find_memo_file_path`
//! - content: `read_all_memos` / `read_all_memos_filtered` / `read_memo_with_body`
//! - index.json schema: 无 `path` 字段, `filename` 直存磁盘文件名

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

/// 读 index.json 原始 JSON 字符串 (不反序列化, 用于 schema 断言)。
fn read_index_raw(mf: &MemoFile) -> String {
    fs::read_to_string(mf.get_index_path()).unwrap()
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
    assert_eq!(memo.id.len(), 6);
    // index.json 已注册
    let queried = mf.read_memo(&memo.id).expect("memo in list");
    assert_eq!(queried.filename, "Hello.md");
    // preview = 派生第二行 body, 单行 body 时为空
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
    // 新 frontmatter 语义: rename 只改磁盘文件名 + index.json.filename,
    // frontmatter 块内 `key` 保持与 index.json id 一致, 不再有 `filename` 字段。
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
    // 不 fs::rename, 不改 index.json.filename。
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
fn write_rename_empty_body_skips_rename() {
    // 空 body / 派生 title 为空时跳过改名, 行为退化为普通 write_memo。
    // 避免把已有 title 改回 untitled- 兜底。
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Keep", "body\n", None).unwrap();
    let _ = mf
        .write_memo_renaming_on_title_change(&memo.id, "")
        .expect("write ok");
    // filename 不变
    let queried = mf.read_memo(&memo.id).expect("still in list");
    assert_eq!(queried.filename, "Keep.md");
    assert!(base.join("Keep.md").exists());
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
    assert!(removed, "should clear index.json orphan entry");
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
    // index.json 已注册
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
    fs::write(metadata.join("index.json"), "{}").unwrap();
    fs::write(metadata.join("memo.json"), "{}").unwrap();
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
    // 场景: index.json 里有一条已存在的 entry (Ghost.md), 物理文件已被外部 rm;
    // 盘上有一个新的 .md (NewOnDisk.md) 不在 index.json 里。一次双向 sweep
    // 应该: (1) 注册 NewOnDisk.md → +1; (2) 清 Ghost.md entry → -1。
    let (mf, base) = fresh_memo_file();

    // 准备: 建 Ghost.md → 注册 (index.json 有 entry, 物理文件随后外部删)
    let ghost = mf.create_memo("Ghost", "old", None).unwrap();
    let ghost_path = base.join(&ghost.filename);
    assert!(ghost_path.exists());
    fs::remove_file(&ghost_path).unwrap();
    assert!(!ghost_path.exists(), "外部 rm 删了物理文件");
    // index.json 仍残留 ghost entry
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

    // index.json: Ghost entry 已清, NewOnDisk 已注册
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
    // 空目录场景: index.json 有 N 条 entry, 盘上一个文件都没有。
    // sweep 后 index.json 应被清空 (用户视角: 删空了文件夹, app 应该反映)。
    let (mf, base) = fresh_memo_file();
    let _a = mf.create_memo("A", "x", None).unwrap();
    let _b = mf.create_memo("B", "y", None).unwrap();
    assert_eq!(mf.read_all_memos().len(), 2);

    // 用户把 base 下所有 .md 删空 (含 .metadata/ 不算 — 我们用物理删除 + 绕过目录)
    fs::remove_file(base.join("A.md")).unwrap();
    fs::remove_file(base.join("B.md")).unwrap();

    let report = mf.reconcile_with_disk_bidirectional().unwrap();
    assert_eq!(report.added, 0);
    assert_eq!(report.removed, 2, "空目录应清空 index.json");
    assert_eq!(mf.read_all_memos().len(), 0);
}

#[test]
fn reconcile_bidirectional_preserves_id_on_inode_rename() {
    // inode-tracker 漏命中场景: 磁盘文件 frontmatter key 命中 index.json 已有 id,
    // 但 filename 不同 (说明 inode 改了名, index.json 还没跟上)。
    // 期望: 走 rename_memo_file 路径保留 id, 把 entry.filename 改为新值;
    // 然后 prune 阶段不会把它当幽灵删掉 (因为新 filename 已在 disk_filenames)。
    let (mf, base) = fresh_memo_file();

    // 1. register 原始文件, 记下 id
    let old_path = base.join("Original.md");
    fs::write(&old_path, "# Hello\nbody\n").unwrap();
    let initial = mf.register_existing_file(&old_path).expect("register");
    let original_id = initial.id.clone();
    assert_eq!(initial.filename, "Original.md");

    // 2. 物理 rename (外部 mv), index.json 还没更新
    let new_path = base.join("Renamed.md");
    fs::rename(&old_path, &new_path).unwrap();

    // 3. sweep 双向:
    //    - disk_filenames = {"Renamed.md"}
    //    - list_filenames = {"Original.md"}
    //    - to_register = {"Renamed.md"}
    //    - to_remove = [original_id] (因为 Original.md 不在盘上)
    //    注册阶段: frontmatter key=original_id 命中 index.json 已有 entry,
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
    // 状态一致: index.json 里所有 entry 都对应盘上文件 → (0, 0)
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
    // .metadata/ 里的 index.json / memo.json 不应被当成 .md 注册
    let (mf, base) = fresh_memo_file();
    let metadata = base.join(".metadata");
    fs::create_dir_all(&metadata).unwrap();
    fs::write(metadata.join("index.json"), "{}").unwrap();
    fs::write(metadata.join("memo.json"), "{}").unwrap();
    // index.json 里没任何 entry, 也不应该被注册 (不是 .md)
    let report = mf.reconcile_with_disk_bidirectional().unwrap();
    assert_eq!(report.added, 0);
    assert_eq!(report.removed, 0);
}

// =====================================================================
// unregister_memo_by_path (lazy defense 单条兜底)
// =====================================================================

#[test]
fn unregister_clears_ghost_entry_when_file_gone() {
    // 模拟 lazy defense 触发场景: index.json 有 entry, 物理文件已 rm,
    // 用户点开了这条 → IPC read_memo 应清掉 entry。
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Ghost", "x", None).unwrap();
    fs::remove_file(base.join("Ghost.md")).unwrap();
    assert!(
        mf.read_memo(&memo.id).is_some(),
        "index.json 仍有 ghost entry"
    );

    // 模拟 IPC handler 内部: 拿到 memo 后 stat 文件, 文件不在 → 调 unregister
    let abs = base.join("Ghost.md");
    let removed = mf.unregister_memo_by_path(&abs);
    assert!(removed);
    assert!(mf.read_memo(&memo.id).is_none(), "ghost entry 已清");
}

#[test]
fn unregister_refuses_when_filename_differs() {
    // invariant guard: index.json entry.filename 拼出的绝对路径 ≠ abs_path 时拒绝删,
    // 防止 rename 旧文件 Remove 事件误删 entry。
    let (mf, base) = fresh_memo_file();
    let memo = mf.create_memo("Hello", "x", None).unwrap();
    // 构造一个 abs_path 跟 index.json entry 不一致的请求
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

    // index.json 字段已更新
    let queried = mf.read_memo(&memo.id).unwrap();
    assert!(queried.favorited);
    assert_eq!(queried.colors, vec![super::types::MemoColor::Red]);
    // 物理文件没动
    let after = fs::read_to_string(base.join("Meta.md")).unwrap();
    assert_eq!(before, after);
}

// =====================================================================
// index.json schema assertions
// =====================================================================

#[test]
fn index_does_not_persist_path_field() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.create_memo("Schema", "x", None).unwrap();
    let raw = read_index_raw(&mf);
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(
        v["memos"][0].get("path").is_none(),
        "index.json must not persist path: {raw}"
    );
    assert!(v["memos"][0]["filename"].is_string());
}

#[test]
fn index_filename_is_disk_filename_with_md_suffix() {
    let (mf, _base) = fresh_memo_file();
    let _ = mf.create_memo("Hello", "x", None).unwrap();
    let raw = read_index_raw(&mf);
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["memos"][0]["filename"], "Hello.md");
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
    // "all" 视图下 favorited 置顶
    assert_eq!(all[0].id, b.id);
    assert_eq!(all[1].id, a.id);
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
        "all N concurrent creates should land in index.json"
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
    // 场景: index.json 里有一条 entry { id, filename: "Hello.md" },
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

    // index.json 已经被同步: 旧 filename 不应再出现在 list 里
    let list = mf.read_index().expect("index.json should exist");
    let entry = list
        .memos
        .iter()
        .find(|e| e.id == original_id)
        .expect("entry still in list under original id");
    assert_eq!(entry.filename, "Hello-renamed.md");
    assert!(
        list.memos.iter().all(|e| e.filename != "Hello.md"),
        "old filename must be gone from index.json"
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
    assert!(result.is_err(), "old not in index.json should error");
}

#[test]
fn rename_memo_file_rejects_when_new_filename_occupied() {
    let (mf, _tmp) = fresh_memo_file();

    // 准备两个文件都注册进 index.json
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
// 期望: index.json 里应该仍然是原来 id=abc123 的那条 entry, 仅仅
// filename 字段从 "Hello.md" 变成 "Hello-renamed.md"。
//
// 实际 (用户报告 bug): index.json 出现 id=xyz789 的新 entry, 旧的
// abc123 还在但 filename 还是 "Hello.md" (指向不存在的文件)。

#[test]
fn register_existing_file_should_preserve_id_from_frontmatter_key() {
    // 模拟场景: index.json 里有一条 entry (id=abc123, filename="Hello.md"),
    // 但 disk 上的 "Hello.md" 已经被外部 mv 到 "Hello-renamed.md"。
    // index.json 现在跟磁盘不一致 — 这是 rename 后的 race window。
    //
    // 1. 先 register "Hello.md" 建立 index.json entry
    // 2. 物理 rename 磁盘文件
    // 3. 用 frontmatter 里的 key 字段反查 index.json, 找到 id=abc123
    //    那条 entry, 改它的 filename 到 "Hello-renamed.md"
    let (mf, _tmp) = fresh_memo_file();

    // 1. register 原始文件
    let old_path = mf.get_memo_base().join("Hello.md");
    fs::write(&old_path, "# Hello\nworld\n").unwrap();
    let initial = mf.register_existing_file(&old_path).expect("register ok");
    let original_id = initial.id.clone();
    assert_eq!(initial.filename, "Hello.md");

    // 模拟 inode tracker 漏命中 — 外部 mv 后 index.json 还没更新。
    // 我们手工把 index.json 的 entry.filename 改成 "Hello-renamed.md"
    // (模拟 rename_memo_file 已经走过) — 不, 实际场景是 inode tracker
    // 漏命中, rename_memo_file 没被调, index.json 里仍是 "Hello.md"。
    // 但磁盘上已经没 "Hello.md" 了。
    //
    // 重新设计: 模拟 inode tracker 漏命中意味着 processor 把这个事件
    // 当 Create 走。 此时 index.json 里还是旧 filename "Hello.md",
    // 但磁盘上是 "Hello-renamed.md"。
    // 走 register_existing_file("Hello-renamed.md") 时:
    //   - find_memo_by_filename("Hello-renamed.md") → None (index.json 还没改)
    //   - 生成新 id, 用新 id 覆盖磁盘 frontmatter key
    //   - 写 index.json, 出现 entry { id=new_id, filename="Hello-renamed.md" }
    //   - 旧 entry { id=original_id, filename="Hello.md" } 仍残留, 指向不存在的文件
    let new_path = mf.get_memo_base().join("Hello-renamed.md");
    fs::rename(&old_path, &new_path).unwrap();
    let rereg = mf.register_existing_file(&new_path).expect("register ok");

    // v2 修复: id 必须保留, 不生成新 id。
    // 修复前 register_existing_file 走 "filename 不在 index.json → 生成新 id" 路径,
    // 物理 rename 后旧 entry 残留, 新 entry 出现, 同一份磁盘内容被注册成两条 memo。
    assert_eq!(
        rereg.id, original_id,
        "register_existing_file must preserve id from disk frontmatter key"
    );
    assert_eq!(rereg.filename, "Hello-renamed.md");

    // 关键: index.json 里**只剩一条** entry, 没有 id 漂移
    let list = mf.read_index().expect("index.json");
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
// 验证 index.json 的 entry 仍然只有 1 条, id 保留。
// =====================================================================
#[test]
fn rename_via_remove_create_pair_preserves_id() {
    // 这测的是 inode tracker 命中时 Remove 事件被拦截 + Create 走 rename 配对的
    // 协同行为, 但 MemoFile 层不直接持有 inode tracker, 测的是 index.json
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
    //    - Create(new_path) 事件调 rename_memo_file(old, new) 同步 index.json
    mf.rename_memo_file(&old_path, &new_path)
        .expect("rename should succeed");

    // 4. 关键断言: index.json 只有一条 entry, id 保留
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
    // key 反查 → rename_memo_file 重建 index.json (保留 id)。

    let (mf, _tmp) = fresh_memo_file();
    let old_path = mf.get_memo_base().join("Hello.md");
    fs::write(&old_path, "# Hello\nworld\n").unwrap();
    let initial = mf.register_existing_file(&old_path).expect("register ok");
    let original_id = initial.id.clone();

    let new_path = mf.get_memo_base().join("Hello-renamed.md");
    fs::rename(&old_path, &new_path).unwrap();

    // 模拟 Remove 事件先到, 已经把 index.json 的 entry 删了
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
// - 失效: `set_current_notebook` 改 id 时清空 (index.json 路径变了)
// - 同步: `write_index` / `write_notebook_configs` 落盘成功后回填 cache,
//         落盘失败时 cache 保持旧值 (回看 `index_store.rs` 顺序约定)
//
// 用法上跟其他 ops 测试一样用 `fresh_memo_file` 起 tempdir + notebook.json。

#[test]
fn index_cache_populated_on_first_read() {
    let (mf, _base) = fresh_memo_file();
    // cache 起始为空: 第一次 read_index 走磁盘, 然后回填
    assert!(mf.index_cache.read().unwrap().is_none());
    let _ = mf.create_memo("Hello", "x", None).unwrap(); // 写 index.json + 填 cache
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

    // cache 内容跟磁盘文件一致
    let cached = mf.read_index().expect("cached list");
    let raw = fs::read_to_string(mf.get_index_path()).unwrap();
    let from_disk: MemoIndexFile = serde_json::from_str(&raw).unwrap();
    assert_eq!(cached.memos.len(), from_disk.memos.len());
    assert_eq!(cached.memos[0].filename, from_disk.memos[0].filename);
    assert_eq!(cached.memos[0].updated_at, from_disk.memos[0].updated_at);
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
    // fresh_memo_file 没建 index.json, get_index_path() 指向一个不存在的路径
    assert!(!mf.get_index_path().exists());

    let result = mf.read_index();
    assert!(result.is_none());
    // 文件不存在 → 不写 cache (避免一次写锁, 下次 save 路径自然会建 cache)
    assert!(
        mf.index_cache.read().unwrap().is_none(),
        "missing file should not populate cache with empty/None"
    );
}
