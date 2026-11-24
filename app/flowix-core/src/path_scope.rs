//! Path containment checks shared by every boundary that has to prove a path
//! stays inside an allowed root.
//!
//! There are two such boundaries in the app: the Tauri command surface (a path
//! coming from the UI must resolve inside a registered notebook) and the AI tool
//! surface (a tool may only touch registered notebook roots). Both used to keep
//! their own copy and drifted; this module is the single implementation.
//!
//! It lives in `flowix-core` rather than in the desktop shell because domain
//! code — template installation, collection rebasing — needs the same answer
//! without depending on the IPC layer.
use std::path::{Component, Path, PathBuf};

/// `fs::canonicalize` requires the path to exist. For write targets that do not
/// exist yet we canonicalize the longest existing ancestor and re-attach the
/// remaining components, so containment can be checked before creation.
pub fn canonical_existing_or_parent(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => {
                match std::fs::metadata(&normalized) {
                    Ok(metadata) if !metadata.is_dir() => return None,
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => return None,
                    _ => {}
                }
                normalized.push(value);
                match std::fs::symlink_metadata(&normalized) {
                    Ok(_) => normalized = dunce::canonicalize(&normalized).ok()?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return None,
                }
            }
        }
    }
    Some(normalized)
}

/// Containment test: canonicalize both sides, then `starts_with`.
///
/// Tolerates `path` / `root` not existing yet (the write-target case) by
/// falling back to the longest existing ancestor.
pub fn path_is_inside(path: &Path, root: &Path) -> bool {
    let Some(path) = canonical_existing_or_parent(path) else {
        return false;
    };
    let Some(root) = canonical_existing_or_parent(root) else {
        return false;
    };
    path.starts_with(root)
}

/// Returns true when a path resolves inside a reserved child directory of a
/// scope. This keeps internal notebook data protected even when the requested
/// path does not exist yet.
pub fn path_is_inside_reserved_directory(path: &Path, root: &Path, reserved: &str) -> bool {
    let Some(path) = canonical_existing_or_parent(path) else {
        return false;
    };
    let Some(root) = canonical_existing_or_parent(root) else {
        return false;
    };
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative
        .components()
        .any(|component| matches!(component, Component::Normal(value) if value == reserved))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("flowix-path-scope-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn inside_returns_true_for_subpath() {
        let tmp = scratch("subpath");
        let sub = tmp.join("child");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert!(path_is_inside(&file, &tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn inside_returns_false_for_sibling() {
        let a = scratch("sibling-a");
        let b = scratch("sibling-b");
        let file = a.join("note.md");
        std::fs::write(&file, "x").unwrap();
        assert!(!path_is_inside(&file, &b));
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn inside_works_for_nonexistent_target() {
        let tmp = scratch("future");
        assert!(path_is_inside(&tmp.join("not-yet-created.md"), &tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn inside_works_for_multiple_nonexistent_directories() {
        let tmp = scratch("multi-level");
        let future = tmp.join(".flowix").join("plugin").join("mindmap");
        assert!(path_is_inside(&future, &tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn inside_normalizes_parent_components_before_comparing() {
        let tmp = scratch("parent");
        let outside = tmp
            .join("..")
            .join(format!("flowix-path-scope-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        assert!(!path_is_inside(
            &tmp.join("missing").join("..").join(".."),
            &tmp
        ));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn relative_paths_cannot_define_an_authorization_boundary() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!path_is_inside(Path::new("note.md"), directory.path()));
        assert!(!path_is_inside(directory.path(), Path::new(".")));
    }

    #[test]
    fn missing_descendants_are_allowed_but_parent_escape_is_not() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("allowed");
        std::fs::create_dir(&root).unwrap();
        assert!(path_is_inside(&root.join("missing/nested/note.md"), &root));
        assert!(!path_is_inside(
            &root.join("missing/../../outside.md"),
            &root
        ));
    }

    #[test]
    fn sibling_with_the_same_textual_prefix_is_not_inside() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("allowed");
        std::fs::create_dir(&root).unwrap();
        assert!(!path_is_inside(
            &directory.path().join("allowed-other/note.md"),
            &root
        ));
    }

    #[test]
    fn regular_file_cannot_be_used_as_a_directory() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("file");
        std::fs::write(&file, "original").unwrap();
        assert!(!path_is_inside(&file.join("child"), directory.path()));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_parent_components_follow_filesystem_semantics() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("allowed");
        let outside = directory.path().join("outside/child");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("link")).unwrap();
        assert!(!path_is_inside(&root.join("link/../secret.md"), &root));
        assert!(!path_is_inside(&root.join("link/new/note.md"), &root));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_with_internal_targets_and_root_aliases_remain_supported() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("allowed");
        std::fs::create_dir_all(root.join("child")).unwrap();
        symlink(root.join("child"), root.join("link")).unwrap();
        let alias = directory.path().join("alias");
        symlink(&root, &alias).unwrap();
        assert!(path_is_inside(&root.join("link/note.md"), &root));
        assert!(path_is_inside(&root.join("link/../note.md"), &root));
        assert!(path_is_inside(&alias.join("child/note.md"), &root));
        assert!(path_is_inside(&root.join("child/note.md"), &alias));
    }

    #[cfg(unix)]
    #[test]
    fn dangling_and_cyclic_symlinks_fail_closed() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        symlink(root.join("missing"), root.join("dangling")).unwrap();
        symlink(root.join("cycle"), root.join("cycle")).unwrap();
        for name in ["dangling", "cycle"] {
            assert!(!path_is_inside(&root.join(name), root));
            assert!(!path_is_inside(&root.join(name).join("note.md"), root));
        }
    }

    #[test]
    fn reserved_directory_is_detected_below_scope() {
        let tmp = scratch("reserved");
        assert!(path_is_inside_reserved_directory(
            &tmp.join(".flowix").join("template-installs"),
            &tmp,
            ".flowix"
        ));
        assert!(!path_is_inside_reserved_directory(
            &tmp.join("notes"),
            &tmp,
            ".flowix"
        ));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
