//! `file` 模块的回归测试：列举口径、名字校验、偏好 rebase、导入冲突。
//!
//! 断言的都是「离开这个模块就会被破坏」的约定，不是实现细节 —— 例如点目录在
//! 树里隐藏但仍可读写、导入同名文件绝不覆盖。
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, RwLock};

use super::mutate::{
    create_new_dir, file_mutation_error, notebook_folder_target, validate_file_name,
};
use super::transfer::resolve_import_file_paths;
use super::tree::{
    canonical_path, populate_memo_tree_metadata, read_dir_single_level,
    read_dir_single_level_with_policy, DocTreeMemoMeta, MemoTreeMetadata,
};
use super::view::rebase_notebook_default_create_folder;
use flowix_core::memo_file::{FileManagementPolicy, MemoFile, NoteColor, TreeVisibility};

#[test]
fn notebook_folder_target_preserves_paths_and_rejects_traversal() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    assert_eq!(notebook_folder_target(root, "").unwrap(), root);
    assert_eq!(
        notebook_folder_target(root, ".hidden/Project").unwrap(),
        root.join(".hidden/Project"),
    );
    for invalid in [
        "../outside", "a/../../outside", "a/./b", "/outside", "a\\b", "a\0b",
    ] {
        assert!(notebook_folder_target(root, invalid).is_err(), "{invalid:?}");
    }
}

#[cfg(unix)]
#[test]
fn notebook_folder_target_rejects_symlinks_leaving_the_notebook() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("notebook");
    let outside = directory.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("alias")).unwrap();
    assert!(notebook_folder_target(&root, "alias/new-folder").is_err());
    assert!(!outside.join("new-folder").exists());
}

#[cfg(unix)]
#[test]
fn import_paths_reuse_the_same_file_through_a_symlinked_notebook_root() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("notebook");
    fs::create_dir(&root).unwrap();
    let source = root.join("document.pdf");
    fs::write(&source, [0_u8, 255, 1]).unwrap();
    let alias = directory.path().join("alias");
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    let (resolved_source, target) = resolve_import_file_paths(&source, &alias).unwrap();
    assert_eq!(resolved_source, target);
    assert_eq!(fs::read(&target).unwrap(), vec![0_u8, 255, 1]);

    let outside = directory.path().join("outside.pdf");
    fs::write(&outside, b"outside").unwrap();
    let (_, target) = resolve_import_file_paths(&outside, &alias).unwrap();
    assert_eq!(target.parent().unwrap(), dunce::canonicalize(&root).unwrap());
}

#[test]
fn import_paths_reject_distinct_files_with_the_same_name_without_overwriting() {
    let directory = tempfile::tempdir().unwrap();
    let source_root = directory.path().join("source");
    let target_root = directory.path().join("target");
    fs::create_dir(&source_root).unwrap();
    fs::create_dir(&target_root).unwrap();
    fs::write(source_root.join("a.pdf"), b"source").unwrap();
    fs::write(target_root.join("a.pdf"), b"target").unwrap();
    assert!(resolve_import_file_paths(&source_root.join("a.pdf"), &target_root).is_err());
    assert_eq!(fs::read(target_root.join("a.pdf")).unwrap(), b"target");
}

#[test]
fn create_new_dir_rejects_duplicate_folders_and_files_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().join("parent");
    fs::create_dir(&parent).unwrap();

    create_new_dir(&parent.join("folder")).unwrap();
    assert!(parent.join("folder").is_dir());
    let duplicate = create_new_dir(&parent.join("folder")).unwrap_err();
    assert_eq!(duplicate.kind(), std::io::ErrorKind::AlreadyExists);

    // An existing file at the target path conflicts as well — never overwrite.
    fs::write(parent.join("note.md"), b"body").unwrap();
    let file_conflict = create_new_dir(&parent.join("note.md")).unwrap_err();
    assert_eq!(file_conflict.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(parent.join("note.md")).unwrap(), b"body");

    // Missing parents are still created, matching the old create_dir_all behavior.
    create_new_dir(&parent.join("nested/deep")).unwrap();
    assert!(parent.join("nested/deep").is_dir());
}

#[test]
fn directory_listing_preserves_regular_files_and_folders() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("note.md"), "body").unwrap();
    fs::write(directory.path().join("photo.png.yaml"), "title: Reference").unwrap();
    fs::write(directory.path().join("AGENTS.md"), "agent rules").unwrap();
    fs::create_dir(directory.path().join("folder")).unwrap();
    fs::create_dir(directory.path().join(".flowix")).unwrap();
    fs::write(directory.path().join(".hidden.md"), "hidden").unwrap();
    let items = read_dir_single_level(directory.path(), None);
    assert_eq!(items.len(), 3);
    assert!(items.iter().all(|item| item.name != "photo.png.yaml"));
    assert!(items.iter().any(|item| item.name == "AGENTS.md"));
    assert!(items.iter().any(|item| item.name == "folder"));
    assert!(items.iter().any(|item| item.name == "note.md"));

    let hidden_items = read_dir_single_level(directory.path(), None);
    assert!(hidden_items.iter().all(|item| item.name != ".flowix"));
}

#[test]
fn only_media_property_sidecars_are_hidden_from_directory_listing() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("photo.png.yaml"), "title: Reference").unwrap();
    fs::write(directory.path().join("video.mp4.yml"), "kind: demo").unwrap();
    fs::write(directory.path().join("config.yaml"), "enabled: true").unwrap();

    let items = read_dir_single_level(directory.path(), None);
    assert_eq!(
        items
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        vec!["config.yaml", "video.mp4.yml"]
    );
}

#[test]
fn directory_listing_attaches_indexed_memo_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let note_path = directory.path().join("note.md");
    fs::write(&note_path, "body").unwrap();
    let mut metadata = HashMap::new();
    metadata.insert(
        canonical_path(&note_path),
        MemoTreeMetadata {
            created_ms: Some(42),
            memo: DocTreeMemoMeta {
                icon: Some("flashlight".to_string()),
                colors: vec![NoteColor::Blue],
                favorited: true,
            },
        },
    );

    let items = read_dir_single_level(directory.path(), Some(&metadata));
    assert_eq!(items[0].memo_created_ms, Some(42));
    let memo = items[0].memo_meta.as_ref().expect("indexed memo metadata");
    assert_eq!(memo.icon.as_deref(), Some("flashlight"));
    assert_eq!(memo.colors, vec![NoteColor::Blue]);
    assert!(memo.favorited);
}

#[test]
fn tree_metadata_is_hydrated_for_the_listed_directory_only() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("book");
    fs::create_dir_all(root.join("projects/archive")).unwrap();
    for relative in ["note.md", "projects/note.md", "projects/archive/note.md"] {
        fs::write(root.join(relative), "body").unwrap();
    }
    let memo = MemoFile::new(temp.path().join("config"));
    memo.initialize_current_registry_storage().unwrap();
    memo.write_notebook_configs(&[flowix_core::memo_file::NotebookConfig {
        id: "tree".into(), name: "Tree".into(), icon: None,
        path: root.to_string_lossy().into_owned(), is_default: true,
        sort: 0, created_at: 0, updated_at: 0,
    }]).unwrap();
    memo.reconcile_note_index("tree").unwrap();
    let memo = Arc::new(RwLock::new(memo));
    let background = Arc::new(crate::app::notebook_background::NotebookBackground::default());
    for directory in [&root, &root.join("projects")] {
        let mut items = read_dir_single_level(directory, None);
        populate_memo_tree_metadata(directory, &mut items, &memo, &background);
        let hydrated: Vec<_> = items.iter().filter(|item| item.memo_meta.is_some()).collect();
        assert_eq!(hydrated.len(), 1);
        assert_eq!(hydrated[0].name, "note.md");
        assert!(hydrated[0].memo_created_ms.is_some());
        assert!(items.iter().filter(|item| item.item_type == "folder").all(|item| item.memo_meta.is_none()));
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.join("note.md"), root.join("alias.md")).unwrap();
        let mut items = read_dir_single_level(&root, None);
        populate_memo_tree_metadata(&root, &mut items, &memo, &background);
        assert!(items.iter().find(|item| item.name == "alias.md").unwrap().memo_meta.is_some());
    }
}

#[test]
fn notebook_policy_lists_every_dot_directory_but_keeps_dot_files_out() {
    let directory = tempfile::tempdir().unwrap();
    let hidden = directory.path().join(".codex");
    fs::create_dir(&hidden).unwrap();
    fs::write(hidden.join("skill.md"), "skill").unwrap();
    fs::create_dir(directory.path().join(".agent")).unwrap();
    fs::create_dir(directory.path().join(".cache")).unwrap();
    fs::create_dir(directory.path().join(".unrelated")).unwrap();
    fs::write(directory.path().join(".gitignore"), "ignored").unwrap();
    fs::write(directory.path().join(".index.yaml"), "collection: {}").unwrap();
    fs::create_dir(directory.path().join("notes")).unwrap();
    fs::write(directory.path().join("notes/note.md"), "note").unwrap();
    fs::write(directory.path().join("notes/.index.yaml"), "collection: {}").unwrap();

    let policy = FileManagementPolicy::default();
    let items = read_dir_single_level_with_policy(
        directory.path(),
        None,
        Some((directory.path(), &policy)),
        TreeVisibility::default(),
    );
    let mut names = items
        .iter()
        .map(|item| item.name.as_str())
        .collect::<Vec<_>>();
    names.sort_unstable();
    // Every folder on disk is browsable; only file noise stays hidden —
    // including a folder collection's own `.index.yaml`.
    assert_eq!(names, vec![".agent", ".cache", ".codex", ".unrelated", "notes"]);
    // 隐藏只发生在展示口径：集合文件的访问、重命名与恢复仍走这条路径。
    assert!(!policy.is_tree_hidden_at(directory.path(), Path::new(".index.yaml")));
    assert!(!policy.is_tree_hidden_at(directory.path(), Path::new("notes/.index.yaml")));
    // The row flag mirrors the index rule, so the row menu can refuse to
    // create notes where they would never show up.
    let excluded = |name: &str| {
        items.iter().find(|item| item.name == name).unwrap().index_excluded
    };
    assert!(excluded(".codex"));
    assert!(excluded(".agent"));
    assert!(!excluded("notes"));
    let hidden_children =
        read_dir_single_level_with_policy(
            &hidden,
            None,
            Some((directory.path(), &policy)),
            TreeVisibility::default(),
        );
    assert_eq!(hidden_children[0].name, "skill.md");
    assert!(hidden_children[0].index_excluded);
}

/// 全局显示开关只影响列举：关掉「隐藏文件夹」后点目录不再下发，关掉「系统
/// 文件夹」后黑名单目录不再下发，而应用内部目录（`.flowix`）始终不下发。
#[test]
fn tree_visibility_switches_drop_hidden_and_system_folders() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::create_dir(root.join(".trash")).unwrap();
    fs::create_dir(root.join("node_modules")).unwrap();
    fs::create_dir(root.join("attachments")).unwrap();
    fs::create_dir(root.join(".flowix")).unwrap();
    fs::create_dir(root.join("notes")).unwrap();

    let policy = FileManagementPolicy::default();
    let list = |visibility: TreeVisibility| -> Vec<String> {
        let mut names: Vec<String> = read_dir_single_level_with_policy(
            root,
            None,
            Some((root, &policy)),
            visibility,
        )
        .into_iter()
        .map(|item| item.name)
        .collect();
        names.sort_unstable();
        names
    };

    // 默认全显示（应用内部目录 `.flowix` 例外，永远不下发）。
    assert_eq!(
        list(TreeVisibility::default()),
        vec![".trash", "attachments", "node_modules", "notes"],
    );
    // 关掉「隐藏文件夹」：点目录消失。
    assert_eq!(
        list(TreeVisibility { show_hidden: false, show_system: true }),
        vec!["attachments", "node_modules", "notes"],
    );
    // 关掉「系统文件夹」：黑名单目录消失，点目录保留。
    assert_eq!(
        list(TreeVisibility { show_hidden: true, show_system: false }),
        vec![".trash", "notes"],
    );
    // 两个都关。
    assert_eq!(
        list(TreeVisibility { show_hidden: false, show_system: false }),
        vec!["notes"],
    );
}

#[cfg(unix)]
#[test]
fn directory_listing_hides_outside_and_dangling_links() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("allowed");
    fs::create_dir(&root).unwrap();
    let outside = directory.path().join("secret.md");
    fs::write(&outside, "secret").unwrap();
    fs::write(root.join("note.md"), "body").unwrap();
    symlink(&outside, root.join("outside.md")).unwrap();
    symlink(root.join("missing"), root.join("dangling.md")).unwrap();
    symlink(root.join("note.md"), root.join("inside.md")).unwrap();
    let names: Vec<_> = read_dir_single_level(&root, None)
        .into_iter()
        .map(|item| item.name)
        .collect();
    assert_eq!(names, vec!["inside.md", "note.md"]);
}

#[test]
fn file_names_cannot_escape_the_selected_parent() {
    for name in [
        "",
        " ",
        ".",
        "..",
        "../note",
        "folder/note",
        "folder\\note",
        "C:\\note",
        "note:stream",
        "note\0",
        "note.",
    ] {
        assert!(validate_file_name(name).is_err(), "accepted {name:?}");
    }
    for name in ["笔记.md", "image.png", "notes 2026.md", ".gitignore"] {
        assert!(validate_file_name(name).is_ok(), "rejected {name:?}");
    }
}

#[test]
fn file_errors_distinguish_conflicts_from_missing_and_denied_paths() {
    for (kind, code) in [
        (std::io::ErrorKind::AlreadyExists, "FILE_EXISTS:"),
        (std::io::ErrorKind::NotFound, "FILE_NOT_FOUND:"),
        (
            std::io::ErrorKind::PermissionDenied,
            "FILE_PERMISSION_DENIED:",
        ),
    ] {
        assert!(file_mutation_error(std::io::Error::new(kind, "failure")).starts_with(code));
    }
}

fn write_view_preferences(root: &Path, json: &str) {
    fs::create_dir_all(root.join(".flowix")).unwrap();
    fs::write(root.join(".flowix/view-preferences.json"), json).unwrap();
}

#[test]
fn default_note_folder_follows_the_renamed_folder() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    write_view_preferences(root, r#"{"defaultCreateFolder":"笔记/子"}"#);

    let rebased = rebase_notebook_default_create_folder(root, "笔记", "Notes").unwrap();

    assert_eq!(rebased.as_deref(), Some("Notes/子"));
    let saved = fs::read_to_string(root.join(".flowix/view-preferences.json")).unwrap();
    assert!(
        saved.contains("\"defaultCreateFolder\": \"Notes/子\""),
        "preference not rewritten: {saved}"
    );
}

#[test]
fn default_note_folder_ignores_unrelated_renames() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    write_view_preferences(root, r#"{"defaultCreateFolder":"其他"}"#);

    assert_eq!(
        rebase_notebook_default_create_folder(root, "笔记", "Notes").unwrap(),
        None
    );
    let saved = fs::read_to_string(root.join(".flowix/view-preferences.json")).unwrap();
    assert!(saved.contains("\"defaultCreateFolder\":\"其他\""));
}

#[test]
fn default_note_folder_rebase_is_a_noop_without_a_preference() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();

    assert_eq!(
        rebase_notebook_default_create_folder(root, "笔记", "Notes").unwrap(),
        None
    );
    assert!(!root.join(".flowix/view-preferences.json").exists());
}
