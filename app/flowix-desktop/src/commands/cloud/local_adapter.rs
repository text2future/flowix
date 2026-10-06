//! Coordinates local cloud-sync snapshots, conflict resolution, and remote application.
use super::*;

mod conflict_files;
mod conflict_resolution;
mod local_snapshot;
mod remote_apply;

use conflict_files::{
    choose_markdown_conflict_content, recover_and_register_conflict_stage,
    safely_replace_conflict_file,
};
#[cfg(test)]
use conflict_files::{
    conflict_stage_path, safely_remove_conflict_file_with_hook,
    safely_replace_conflict_file_with_hook, save_conflict_bytes,
};
#[cfg(test)]
use remote_apply::write_cloud_attachments;

pub(super) use conflict_files::{
    cloud_conflict_copy_path, record_rejected_cloud_version, register_preserved_conflict_copy,
    safely_remove_conflict_file, safely_replace_cloud_file, ConflictFileOutcome,
};
pub(super) use conflict_resolution::{
    resolve_v2_delete_conflict, resolve_v2_file_put_conflict, resolve_v2_move_conflict,
};
pub(super) use local_snapshot::{
    record_full_local_snapshot, scan_cloud_attachments, should_run_full_local_snapshot,
    v2_account_snapshot,
};
pub(super) use remote_apply::{apply_v2_report, safe_cloud_file_path, safe_cloud_note_path};

#[cfg(test)]
mod conflict_file_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn attachment_manifest_rejects_symlink_directory() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), temp.path().join("attachments")).unwrap();
        let bytes = b"image".to_vec();
        let attachment = flowix_sync::V2RemoteAttachment {
            metadata: flowix_sync::V2Attachment {
                filename: "image.png".into(),
                content_hash: v2_content_hash(&bytes),
                size_bytes: bytes.len() as i64,
                mime_type: "image/png".into(),
            },
            content: bytes,
        };
        assert!(write_cloud_attachments(temp.path(), &[attachment]).is_err());
        assert!(!outside.path().join("image.png").exists());
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
    fn external_atomic_save_after_detach_survives_conflict_delete() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("note.md");
        let conflict = temp.path().join("note (Flowix conflict op).md");
        std::fs::write(&path, b"local version").unwrap();

        let outcome = safely_remove_conflict_file_with_hook(
            &path,
            b"local version",
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

    #[test]
    fn markdown_conflict_policy_merges_then_falls_back_to_cloud_head() {
        let base = b"left: old\nright: old\n";
        let local = b"left: local\nright: old\n";
        let remote = b"left: old\nright: cloud\n";
        assert_eq!(
            choose_markdown_conflict_content(Some(base), local, remote),
            (b"left: local\nright: cloud\n".to_vec(), false),
        );
        assert_eq!(
            choose_markdown_conflict_content(Some(b"same\n"), b"local\n", b"cloud\n"),
            (b"cloud\n".to_vec(), true),
        );
        assert_eq!(
            choose_markdown_conflict_content(None, local, remote),
            (remote.to_vec(), true),
        );
    }
}
