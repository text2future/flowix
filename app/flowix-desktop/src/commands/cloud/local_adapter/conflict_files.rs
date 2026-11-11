use super::*;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConflictFileOutcome {
    Applied { preserved: Option<PathBuf> },
    Interrupted { preserved: Option<PathBuf> },
}

pub(super) fn conflict_stage_path(path: &Path, operation_id: &str) -> PathBuf {
    let operation_key: String = operation_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(48)
        .collect();
    let path_hash = flowix_sync::v2_content_hash(path.to_string_lossy().as_bytes());
    path.with_file_name(format!(
        ".flowix-sync-{operation_key}-{}.stage",
        &path_hash[..8]
    ))
}

pub(crate) fn cloud_conflict_copy_path(path: &Path, operation_id: &str) -> PathBuf {
    let operation_key: String = operation_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(48)
        .collect();
    let stem: String = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Note")
        .chars()
        .take(80)
        .collect();
    let name = match path.extension().and_then(|value| value.to_str()) {
        Some(extension) => format!("{stem} (Flowix conflict {operation_key}).{extension}"),
        None => format!("{stem} (Flowix conflict {operation_key})"),
    };
    path.with_file_name(name)
}

pub(crate) fn record_rejected_cloud_version(
    memo_file: &flowix_core::memo_file::MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
    path: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    let relative = flowix_core::memo_file::notebook_relative_path(notebook_root, path)?;
    let created = memo_file
        .create_path_version_bytes(
            notebook_id,
            &relative,
            bytes,
            flowix_core::memo_file::MemoVersionSource::CloudConflict,
        )
        .map_err(sync_error)?;
    if created.is_none() {
        if !memo_file
            .list_path_versions(notebook_id, &relative)
            .iter()
            .any(|version| memo_file.read_path_version_bytes(notebook_id, &relative, &version.id).as_deref() == Some(bytes))
        {
            return Err("CLOUD_CONFLICT_VERSION_UNAVAILABLE".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod collection_history_tests {
    use super::*;

    #[test]
    fn rejected_collection_version_is_recoverable_and_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("book");
        std::fs::create_dir(&root).unwrap();
        let memo = flowix_core::memo_file::MemoFile::new(temp.path().join("config"));
        memo.write_notebook_configs(&[flowix_core::memo_file::NotebookConfig {
            id: "book".into(), name: "Book".into(), icon: None,
            path: root.to_string_lossy().into_owned(), is_default: true,
            sort: 0, created_at: 1, updated_at: 1,
        }]).unwrap();
        let path = root.join("Tasks.table.yaml");
        record_rejected_cloud_version(&memo, "book", &root, &path, b"offline").unwrap();
        record_rejected_cloud_version(&memo, "book", &root, &path, b"offline").unwrap();
        let versions = memo.list_path_versions("book", "Tasks.table.yaml");
        assert_eq!(versions.len(), 1);
        assert_eq!(memo.read_path_version_bytes("book", "Tasks.table.yaml", &versions[0].id).as_deref(), Some(b"offline".as_slice()));
    }
}

pub(super) fn choose_markdown_conflict_content(
    base: Option<&[u8]>,
    local: &[u8],
    remote: &[u8],
) -> (Vec<u8>, bool) {
    match base.map(|base| flowix_sync::text_merge::merge_markdown(base, local, remote)) {
        Some(flowix_sync::text_merge::MergeOutcome::Merged(bytes)) => (bytes, false),
        _ => (remote.to_vec(), true),
    }
}

pub(super) fn save_conflict_bytes(primary: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if primary.exists() && std::fs::read(primary).map_err(sync_error)? == bytes {
        return Ok(primary.to_path_buf());
    }
    if !primary.exists() {
        match flowix_core::memo_file::atomic_create_bytes(primary, bytes) {
            Ok(()) => return Ok(primary.to_path_buf()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::read(primary).map_err(sync_error)? == bytes {
                    return Ok(primary.to_path_buf());
                }
            }
            Err(error) => return Err(sync_error(error)),
        }
    }
    let hash = flowix_sync::v2_content_hash(bytes);
    let stem = primary
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Note");
    let extension = primary.extension().and_then(|value| value.to_str());
    for suffix in 0..100 {
        let name = match (extension, suffix) {
            (Some(extension), 0) => format!("{stem} (observed-{hash}).{extension}"),
            (Some(extension), suffix) => format!("{stem} (observed-{hash}-{suffix}).{extension}"),
            (None, 0) => format!("{stem} (observed-{hash})"),
            (None, suffix) => format!("{stem} (observed-{hash}-{suffix})"),
        };
        let candidate = primary.with_file_name(name);
        if candidate.exists() {
            if std::fs::read(&candidate).map_err(sync_error)? == bytes {
                return Ok(candidate);
            }
            continue;
        }
        match flowix_core::memo_file::atomic_create_bytes(&candidate, bytes) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::read(&candidate).map_err(sync_error)? == bytes {
                    return Ok(candidate);
                }
            }
            Err(error) => return Err(sync_error(error)),
        }
    }
    Err("CLOUD_CONFLICT_COPY_COLLISION: could not allocate a safe copy name".into())
}

fn recover_conflict_stage(
    path: &Path,
    stage: &Path,
    conflict_copy: &Path,
) -> Result<Option<PathBuf>, String> {
    if !stage.exists() {
        return Ok(None);
    }
    if !path.exists() {
        flowix_core::memo_file::rename_file_noclobber(stage, path).map_err(sync_error)?;
        return Ok(None);
    }
    let bytes = std::fs::read(stage).map_err(sync_error)?;
    let preserved = save_conflict_bytes(conflict_copy, &bytes)?;
    std::fs::remove_file(stage).map_err(sync_error)?;
    Ok(Some(preserved))
}

pub(super) fn safely_replace_conflict_file_with_hook(
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
    after_detach: impl FnOnce(&Path),
) -> Result<ConflictFileOutcome, String> {
    let stage = conflict_stage_path(path, operation_id);
    if let Some(preserved) = recover_conflict_stage(path, &stage, conflict_copy)? {
        return Ok(ConflictFileOutcome::Interrupted {
            preserved: Some(preserved),
        });
    }
    let current = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConflictFileOutcome::Interrupted { preserved: None });
        }
        Err(error) => return Err(sync_error(error)),
    };
    if current != expected {
        return Ok(ConflictFileOutcome::Interrupted { preserved: None });
    }
    if let Err(error) = flowix_core::memo_file::rename_file_noclobber(path, &stage) {
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(ConflictFileOutcome::Interrupted { preserved: None });
        }
        return Err(sync_error(error));
    }
    let captured = std::fs::read(&stage).map_err(sync_error)?;
    if captured != expected {
        let preserved = save_conflict_bytes(conflict_copy, &captured)?;
        if !path.exists() {
            let _ = flowix_core::memo_file::rename_file_noclobber(&stage, path);
        }
        if stage.exists() && path.exists() {
            std::fs::remove_file(&stage).map_err(sync_error)?;
        }
        return Ok(ConflictFileOutcome::Interrupted {
            preserved: Some(preserved),
        });
    }
    let original_permissions = std::fs::metadata(&stage).map_err(sync_error)?.permissions();
    after_detach(path);
    match flowix_core::memo_file::atomic_create_bytes(path, replacement) {
        Ok(()) => {
            std::fs::set_permissions(path, original_permissions).map_err(sync_error)?;
            let latest = std::fs::read(&stage).map_err(sync_error)?;
            let preserved = if latest == expected {
                None
            } else {
                Some(save_conflict_bytes(conflict_copy, &latest)?)
            };
            std::fs::remove_file(&stage).map_err(sync_error)?;
            Ok(ConflictFileOutcome::Applied { preserved })
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let bytes = std::fs::read(&stage).map_err(sync_error)?;
            let preserved = save_conflict_bytes(conflict_copy, &bytes)?;
            std::fs::remove_file(&stage).map_err(sync_error)?;
            Ok(ConflictFileOutcome::Interrupted {
                preserved: Some(preserved),
            })
        }
        Err(error) => {
            if !path.exists() {
                let _ = flowix_core::memo_file::rename_file_noclobber(&stage, path);
            }
            Err(sync_error(error))
        }
    }
}

pub(super) fn safely_replace_conflict_file(
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
) -> Result<ConflictFileOutcome, String> {
    safely_replace_conflict_file_with_hook(
        path,
        expected,
        replacement,
        operation_id,
        conflict_copy,
        |_| {},
    )
}

pub(crate) fn safely_replace_cloud_file(
    path: &Path,
    expected: Option<&[u8]>,
    replacement: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
) -> Result<ConflictFileOutcome, String> {
    if let Some(expected) = expected {
        return safely_replace_conflict_file(
            path,
            expected,
            replacement,
            operation_id,
            conflict_copy,
        );
    }
    match flowix_core::memo_file::atomic_create_bytes(path, replacement) {
        Ok(()) => Ok(ConflictFileOutcome::Applied { preserved: None }),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(ConflictFileOutcome::Interrupted { preserved: None })
        }
        Err(error) => Err(sync_error(error)),
    }
}

pub(super) fn safely_remove_conflict_file_with_hook(
    path: &Path,
    expected: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
    after_detach: impl FnOnce(&Path),
) -> Result<ConflictFileOutcome, String> {
    let stage = conflict_stage_path(path, operation_id);
    if let Some(preserved) = recover_conflict_stage(path, &stage, conflict_copy)? {
        return Ok(ConflictFileOutcome::Interrupted {
            preserved: Some(preserved),
        });
    }
    let current = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConflictFileOutcome::Applied { preserved: None });
        }
        Err(error) => return Err(sync_error(error)),
    };
    if current != expected {
        return Ok(ConflictFileOutcome::Interrupted { preserved: None });
    }
    if let Err(error) = flowix_core::memo_file::rename_file_noclobber(path, &stage) {
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(ConflictFileOutcome::Interrupted { preserved: None });
        }
        return Err(sync_error(error));
    }
    let captured = std::fs::read(&stage).map_err(sync_error)?;
    if captured != expected {
        let preserved = save_conflict_bytes(conflict_copy, &captured)?;
        if !path.exists() {
            let _ = flowix_core::memo_file::rename_file_noclobber(&stage, path);
        }
        if stage.exists() && path.exists() {
            std::fs::remove_file(&stage).map_err(sync_error)?;
        }
        return Ok(ConflictFileOutcome::Interrupted {
            preserved: Some(preserved),
        });
    }
    after_detach(path);
    if path.exists() {
        let preserved = save_conflict_bytes(conflict_copy, &captured)?;
        std::fs::remove_file(&stage).map_err(sync_error)?;
        return Ok(ConflictFileOutcome::Interrupted {
            preserved: Some(preserved),
        });
    }
    std::fs::remove_file(&stage).map_err(sync_error)?;
    Ok(ConflictFileOutcome::Applied { preserved: None })
}

pub(crate) fn safely_remove_conflict_file(
    path: &Path,
    expected: &[u8],
    operation_id: &str,
    conflict_copy: &Path,
) -> Result<ConflictFileOutcome, String> {
    safely_remove_conflict_file_with_hook(path, expected, operation_id, conflict_copy, |_| {})
}

pub(crate) fn register_preserved_conflict_copy(
    memo_file: &flowix_core::memo_file::MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
    path: &Path,
    attachment: bool,
) -> Result<(), String> {
    if attachment {
        let relative = flowix_core::memo_file::notebook_relative_path(notebook_root, path)?;
        memo_file
            .refresh_indexed_resource_path(notebook_id, &relative)
            .map_err(sync_error)
    } else {
        let relative = flowix_core::memo_file::notebook_relative_path(notebook_root, path)?;
        memo_file
            .refresh_note_path(notebook_id, &relative)
            .map_err(sync_error)
    }
}

pub(super) fn recover_and_register_conflict_stage(
    memo_file: &flowix_core::memo_file::MemoFile,
    notebook_id: &str,
    notebook_root: &Path,
    path: &Path,
    operation_id: &str,
    conflict_copy: &Path,
    attachment: bool,
) -> Result<bool, String> {
    let stage = conflict_stage_path(path, operation_id);
    let Some(preserved) = recover_conflict_stage(path, &stage, conflict_copy)? else {
        return Ok(false);
    };
    register_preserved_conflict_copy(
        memo_file,
        notebook_id,
        notebook_root,
        &preserved,
        attachment,
    )?;
    Ok(true)
}
