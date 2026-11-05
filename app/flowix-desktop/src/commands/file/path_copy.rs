use super::*;

/// In-app file copying uses registered scopes, rather than a picker/drop grant.
#[tauri::command]
pub async fn copy_path(
    operation_id: Option<String>,
    window: WebviewWindow,
    source_path: String,
    target_directory_path: String,
    source_space_path: String,
    space_path: String,
    copy_suffix: String,
    app: AppHandle,
) -> Result<String, String> {
    super::super::document_operations::run("copy_path", operation_id, window.label().to_owned(), move || {
        let state = app.state::<AppState>();
        let source_scope = Path::new(&source_space_path);
        let target_scope = Path::new(&space_path);
        let source = Path::new(&source_path);
        let directory = Path::new(&target_directory_path);
        if !is_browsable_scope(source_scope, &state)
            || !is_browsable_scope(target_scope, &state)
            || !can_access_scoped_file(source, Some(&source_space_path), &state)
            || !can_access_scoped_file(directory, Some(&space_path), &state)
            || dunce::canonicalize(source).ok() == dunce::canonicalize(source_scope).ok()
        {
            return Err("FILE_PERMISSION_DENIED".into());
        }
        validate_file_name(&format!("copy{copy_suffix}"))?;
        if copy_suffix.trim().is_empty() || copy_suffix.len() > 64 {
            return Err("INVALID_FILE_NAME".into());
        }
        let metadata = fs::symlink_metadata(source).map_err(file_mutation_error)?;
        if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
            return Err("SOURCE_NOT_REGULAR_FILE".into());
        }
        let source = dunce::canonicalize(source).map_err(file_mutation_error)?;
        let directory = dunce::canonicalize(directory).map_err(file_mutation_error)?;
        if !directory.is_dir() { return Err("TARGET_NOT_DIRECTORY".into()); }
        if metadata.is_dir() && directory.starts_with(&source) {
            return Err("INVALID_MOVE_TARGET".into());
        }
        let target = copy_target(&source, &directory, &copy_suffix).map_err(file_mutation_error)?;
        if !can_access_scoped_file(&target, Some(&space_path), &state) {
            return Err("FILE_PERMISSION_DENIED".into());
        }
        let mf = read_lock(&state.memo_file, "memo_file");
        let ids = mf.notebook_ids_for_paths(&[&target]).map_err(file_mutation_error)?;
        let copy = || copy_tree(&source, &target);
        if ids.is_empty() {
            let _guard = mf.acquire_cross_process_write_lock().map_err(file_mutation_error)?;
            copy().map_err(file_mutation_error)?;
        } else {
            mf.with_registered_path_change(&[&target], "copy_path", copy).map_err(file_mutation_error)?;
        }
        // Projections are rebuildable. A refresh failure must not report the
        // durable copy as failed and invite the caller to duplicate it again.
        for id in ids {
            if metadata.is_dir() {
                if let Err(error) = mf.reconcile_note_index(&id) {
                    tracing::warn!(notebook_id = %id, "note index refresh after copy failed: {error}");
                }
                if let Err(error) = mf.reconcile_resources(&id) {
                    tracing::warn!(notebook_id = %id, "resource catalog refresh after copy failed: {error}");
                }
                if let Some(config) = mf.get_notebook_config_by_id(&id) {
                    super::super::document_list::refresh_view_document_catalog(&mf, &id, Path::new(&config.path));
                }
            } else {
                refresh_notebook_note_index(&mf, &target);
                if let Some(config) = mf.get_notebook_config_by_id(&id) {
                    if let Ok(root) = dunce::canonicalize(&config.path) {
                        if let Ok(relative) = target.strip_prefix(&root) {
                            if let Err(error) = mf.refresh_indexed_resource_path(&id, &relative.to_string_lossy().replace('\\', "/")) {
                                tracing::warn!(notebook_id = %id, "resource refresh after copy failed: {error}");
                            }
                        }
                    }
                }
                super::super::document_list::refresh_view_document_path(&mf, &target);
            }
            let _ = app.emit("file-management-changed", serde_json::json!({ "notebookId": id }));
        }
        Ok(target.to_string_lossy().into_owned())
    }).await
}

fn copy_target(source: &Path, directory: &Path, suffix: &str) -> io::Result<PathBuf> {
    let name = source
        .file_name()
        .ok_or_else(|| io::Error::other("INVALID_FILE_PATH"))?;
    let direct = directory.join(name);
    match fs::symlink_metadata(&direct) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(direct),
        Err(error) => return Err(error),
        Ok(_) => {}
    }
    let (stem, extension) = if source.is_dir() {
        (name.to_string_lossy().into_owned(), String::new())
    } else {
        // Keep Flowix's compound collection extensions intact.
        let name = name.to_string_lossy();
        let split = [".lib.yaml", ".table.yaml", ".media.yaml"]
            .iter()
            .find_map(|ext| {
                name.strip_suffix(ext)
                    .map(|stem| (stem.to_owned(), ext.to_string()))
            })
            .unwrap_or_else(|| {
                (
                    source
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    source
                        .extension()
                        .map(|ext| format!(".{}", ext.to_string_lossy()))
                        .unwrap_or_default(),
                )
            });
        split
    };
    for index in 1..=10_000 {
        let number = if index == 1 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let candidate = directory.join(format!("{stem}{suffix}{number}{extension}"));
        match fs::symlink_metadata(&candidate) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Err(e) => return Err(e),
            Ok(_) => {}
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "FILE_EXISTS"))
}

/// Scan before writing, never follow links or copy notebook-private state.
/// A failure cleans up only the destination that this operation created.
fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other("SOURCE_NOT_REGULAR_FILE"));
    }
    let source_is_directory = metadata.is_dir();
    let physical_source = dunce::canonicalize(source)?;
    let source = physical_source.as_path();
    if source_is_directory
        && dunce::canonicalize(
            target
                .parent()
                .ok_or_else(|| io::Error::other("INVALID_FILE_PATH"))?,
        )?
        .starts_with(source)
    {
        return Err(io::Error::other("INVALID_MOVE_TARGET"));
    }
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !matches!(entry.file_name().to_str(), Some(".flowix" | ".DS_Store"))
        })
    {
        let entry = entry.map_err(io::Error::other)?;
        if entry.file_type().is_symlink()
            || !(entry.file_type().is_dir() || entry.file_type().is_file())
        {
            return Err(io::Error::other("SOURCE_NOT_REGULAR_FILE"));
        }
        if is_cloud_file_not_downloaded(entry.path()) {
            return Err(io::Error::other("CLOUD_FILE_NOT_DOWNLOADED"));
        }
        entries.push((
            entry.path().to_owned(),
            entry
                .path()
                .strip_prefix(source)
                .map_err(io::Error::other)?
                .to_owned(),
            entry.file_type().is_dir(),
        ));
    }
    // Reserve the root with create_new/create_dir: a racing writer is never overwritten.
    let mut root_file = if source_is_directory {
        fs::create_dir(target)?;
        None
    } else {
        Some(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)?,
        )
    };
    let result = (|| {
        for (path, relative, directory) in entries {
            // Re-check physical containment after scanning, including changes to ancestors.
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !dunce::canonicalize(&path)?.starts_with(source)
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "FILE_PERMISSION_DENIED",
                ));
            }
            let destination = target.join(relative);
            if directory {
                if destination != target {
                    fs::create_dir(&destination)?;
                }
            } else {
                let mut input = fs::File::open(&path)?;
                let mut output = if destination == target {
                    root_file
                        .take()
                        .ok_or_else(|| io::Error::other("INVALID_FILE_PATH"))?
                } else {
                    fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&destination)?
                };
                io::copy(&mut input, &mut output)?;
                output.set_permissions(input.metadata()?.permissions())?;
                output.sync_all()?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        drop(root_file);
        let cleanup = if source_is_directory {
            fs::remove_dir_all(target)
        } else {
            fs::remove_file(target)
        };
        if let Err(cleanup_error) = cleanup {
            return Err(io::Error::other(format!(
                "IMPORT_FOLDER_CLEANUP_FAILED: {error}; {cleanup_error}"
            )));
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copies_tree_without_private_state_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("folder");
        fs::create_dir_all(source.join("sub")).unwrap();
        fs::create_dir_all(source.join(".flowix")).unwrap();
        fs::write(source.join("sub/note.md"), "hello").unwrap();
        fs::write(source.join(".flowix/local.db"), "private").unwrap();
        let target = copy_target(&source, root.path(), " - Copy").unwrap();
        assert_eq!(target.file_name().unwrap(), "folder - Copy");
        copy_tree(&source, &target).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("sub/note.md")).unwrap(),
            "hello"
        );
        assert!(!target.join(".flowix").exists());
        assert!(copy_tree(&source, &target).is_err());
        assert!(target.join("sub/note.md").exists());
        assert_eq!(
            copy_target(&source, root.path(), " - Copy")
                .unwrap()
                .file_name()
                .unwrap(),
            "folder - Copy (2)"
        );
    }
    #[test]
    fn copies_file_and_preserves_compound_extension() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("Test.lib.yaml");
        fs::write(&source, "data").unwrap();
        let target = copy_target(&source, root.path(), " - Copy").unwrap();
        assert_eq!(target.file_name().unwrap(), "Test - Copy.lib.yaml");
        copy_tree(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "data");
    }
    #[test]
    fn rejects_copying_into_a_descendant_before_writing() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir_all(source.join("child")).unwrap();
        let target = source.join("child/copy");
        assert!(copy_tree(&source, &target).is_err());
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn preserves_executable_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("run.sh");
        let target = root.path().join("copy.sh");
        fs::write(&source, "echo hello").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        copy_tree(&source, &target).unwrap();
        assert_eq!(
            fs::metadata(target).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_before_creating_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("folder");
        fs::create_dir(&source).unwrap();
        std::os::unix::fs::symlink(root.path(), source.join("escape")).unwrap();
        let target = root.path().join("copy");
        assert!(copy_tree(&source, &target).is_err());
        assert!(!target.exists());
    }
}
