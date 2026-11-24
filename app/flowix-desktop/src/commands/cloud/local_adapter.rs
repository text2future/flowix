//! Local file safety and conflict-copy helpers used by path sync.
use super::*;

mod conflict_files;
mod path_validation;

pub(super) use conflict_files::{
    cloud_conflict_copy_path, register_preserved_conflict_copy, safely_replace_cloud_file,
    ConflictFileOutcome,
};
#[cfg(test)]
use conflict_files::{
    conflict_stage_path, safely_replace_conflict_file_with_hook, save_conflict_bytes,
};
pub(super) use path_validation::{
    safe_cloud_collection_path, safe_cloud_file_path, safe_cloud_note_path,
};

#[cfg(test)]
mod conflict_file_tests {
    use super::*;

    #[test]
    fn collection_paths_allow_only_visible_notebook_documents() {
        let root = tempfile::tempdir().unwrap();
        for name in [
            ".index.yaml",
            "folder/.index.yaml",
            "Tasks.table.yaml",
            "Views.index.yaml",
        ] {
            assert!(
                super::path_validation::safe_cloud_collection_path(root.path(), name).is_ok(),
                "{name}"
            );
        }
        for name in [
            "../outside.table.yaml",
            ".flowix/database/Tasks.table.yaml",
            "folder/.private/Tasks.table.yaml",
            "folder/.index.yml",
            "notes.md",
        ] {
            assert!(
                super::path_validation::safe_cloud_collection_path(root.path(), name).is_err(),
                "{name}"
            );
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path(), root.path().join("link")).unwrap();
            assert!(super::path_validation::safe_cloud_collection_path(
                root.path(),
                "link/Tasks.table.yaml"
            )
            .is_err());
        }
    }

    #[test]
    fn table_note_cloud_paths_exclude_private_state() {
        let root = tempfile::tempdir().unwrap();
        let good = ".flowix/database/col_test/Note.md";
        assert_eq!(
            safe_cloud_note_path(root.path(), good).unwrap(),
            root.path().join(good)
        );
        for bad in [
            ".flowix/versions/Note.md",
            ".flowix/database2/Note.md",
            "nested/.flowix/database/Note.md",
            ".flowix/database/.private/Note.md",
            ".flowix/database/../secret.md",
        ] {
            assert!(safe_cloud_note_path(root.path(), bad).is_err(), "{bad}");
        }
        #[cfg(unix)]
        {
            std::fs::create_dir(root.path().join(".flowix")).unwrap();
            std::os::unix::fs::symlink(root.path(), root.path().join(".flowix/database")).unwrap();
            assert!(safe_cloud_note_path(root.path(), good).is_err());
        }
    }

    #[test]
    fn external_atomic_save_after_detach_is_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("note.md");
        let conflict = temp.path().join("note (Flowix conflict op).md");
        std::fs::write(&path, b"local version").unwrap();

        let outcome = safely_replace_conflict_file_with_hook(
            &path,
            b"local version",
            b"merged version",
            "op",
            &conflict,
            |path| flowix_core::memo_file::atomic_write_bytes(path, b"external save").unwrap(),
        )
        .unwrap();

        assert!(matches!(outcome, ConflictFileOutcome::Interrupted { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"external save");
        assert_eq!(std::fs::read(&conflict).unwrap(), b"local version");
        assert!(!conflict_stage_path(&path, "op").exists());
    }

    #[test]
    fn captured_conflict_bytes_do_not_overwrite_an_existing_copy() {
        let temp = tempfile::tempdir().unwrap();
        let conflict = temp.path().join("note (Flowix conflict op).md");
        std::fs::write(&conflict, b"previous conflict").unwrap();

        let preserved = save_conflict_bytes(&conflict, b"newly captured version").unwrap();

        assert_ne!(preserved, conflict);
        assert_eq!(std::fs::read(&conflict).unwrap(), b"previous conflict");
        assert_eq!(std::fs::read(preserved).unwrap(), b"newly captured version");
    }
}
