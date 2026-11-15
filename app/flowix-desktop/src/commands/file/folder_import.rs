use std::fs;
use std::path::Path;

use tauri::{State, WebviewWindow};

use super::mutate::{file_mutation_error, target_directory_error};
use super::tree::is_browsable_scope;
use crate::app::state::AppState;
use crate::commands::helpers::{
    can_access_document_path, can_access_scoped_file, FileOperationFailure,
};
use crate::lock_utils::read_lock;

const MAX_IMPORT_FOLDER_FILES: usize = 2_000;
const MAX_IMPORT_FOLDER_ENTRIES: usize = 5_000;
const MAX_IMPORT_FOLDER_DEPTH: usize = 32;
const MAX_IMPORT_FOLDER_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// Import a selected directory while preserving its internal folder structure.
/// Limits are checked before creating anything in the destination.
#[tauri::command]
pub async fn import_folder(
    window: WebviewWindow,
    source_directory_path: String,
    target_directory_path: String,
    space_path: String,
    state: State<'_, AppState>,
) -> Result<String, FileOperationFailure> {
    let source_directory = Path::new(&source_directory_path);
    let target_directory = Path::new(&target_directory_path);
    let scope = Path::new(&space_path);
    if !can_access_document_path(source_directory, window.label(), &state)
        || !is_browsable_scope(scope, &state)
        || !can_access_scoped_file(target_directory, Some(&space_path), &state)
    {
        return Err(FileOperationFailure::code("FILE_PERMISSION_DENIED"));
    }
    let source_metadata = fs::symlink_metadata(source_directory).map_err(file_mutation_error)?;
    if !source_metadata.is_dir() || source_metadata.file_type().is_symlink() {
        return Err(FileOperationFailure::code("SOURCE_NOT_DIRECTORY"));
    }
    if !fs::symlink_metadata(target_directory)
        .map_err(target_directory_error)?
        .is_dir()
    {
        return Err(FileOperationFailure::code("TARGET_NOT_DIRECTORY"));
    }
    let folder_name = source_directory
        .file_name()
        .ok_or_else(|| FileOperationFailure::code("INVALID_FILE_PATH"))?;
    let target_root = target_directory.join(folder_name);
    if !can_access_scoped_file(&target_root, Some(&space_path), &state) {
        return Err(FileOperationFailure::code("FILE_PERMISSION_DENIED"));
    }
    if fs::symlink_metadata(&target_root).is_ok() {
        return Err(FileOperationFailure::code("FILE_EXISTS"));
    }

    let source = dunce::canonicalize(source_directory).map_err(file_mutation_error)?;
    let memo_file = state.memo_file.clone();

    tokio::task::spawn_blocking(move || {
        use walkdir::WalkDir;

        let mut directories = Vec::new();
        let mut files = Vec::new();
        let mut entry_count = 0usize;
        let mut total_bytes = 0u64;
        let walker = WalkDir::new(&source)
            .follow_links(false)
            .min_depth(1)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0
                    || !matches!(entry.file_name().to_str(), Some(".flowix" | ".DS_Store"))
            });
        for entry in walker {
            let entry = entry.map_err(|_| FileOperationFailure::code("IMPORT_FOLDER_SCAN_FAILED"))?;
            let relative = entry
                .path()
                .strip_prefix(&source)
                .map_err(|_| FileOperationFailure::code("INVALID_FILE_PATH"))?;
            entry_count += 1;
            if entry_count > MAX_IMPORT_FOLDER_ENTRIES {
                return Err(FileOperationFailure::code("IMPORT_FOLDER_TOO_MANY_ENTRIES"));
            }
            let relative_depth = relative.components().count();
            let depth = if entry.file_type().is_dir() {
                relative_depth
            } else {
                relative_depth.saturating_sub(1)
            };
            if depth > MAX_IMPORT_FOLDER_DEPTH {
                return Err(FileOperationFailure::code("IMPORT_FOLDER_TOO_DEEP"));
            }
            if entry.file_type().is_symlink() {
                continue;
            }
            if entry.file_type().is_dir() {
                directories.push(relative.to_path_buf());
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            if flowix_core::file_copy::is_cloud_file_not_downloaded(entry.path()) {
                return Err(FileOperationFailure::code("CLOUD_FILE_NOT_DOWNLOADED"));
            }
            let size = entry
                .metadata()
                .map_err(|_| FileOperationFailure::code("IMPORT_FOLDER_SCAN_FAILED"))?
                .len();
            total_bytes = total_bytes.saturating_add(size);
            if total_bytes > MAX_IMPORT_FOLDER_BYTES {
                return Err(FileOperationFailure::code("IMPORT_FOLDER_TOO_LARGE"));
            }
            files.push((entry.path().to_path_buf(), relative.to_path_buf()));
            if files.len() > MAX_IMPORT_FOLDER_FILES {
                return Err(FileOperationFailure::code("IMPORT_FOLDER_TOO_MANY_FILES"));
            }
        }

        // Create the full tree only after the source passes all import limits.
        fs::create_dir(&target_root).map_err(file_mutation_error)?;
        let copy_result = (|| -> Result<(), FileOperationFailure> {
            for relative in &directories {
                fs::create_dir_all(target_root.join(relative)).map_err(file_mutation_error)?;
            }
            for (source_file, relative) in &files {
                let target = target_root.join(relative);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(file_mutation_error)?;
                }
                let store = read_lock(&memo_file, "memo_file");
                let ids = store
                    .notebook_ids_for_paths(&[&target])
                    .map_err(file_mutation_error)?;
                let copy = |destination: &Path| -> std::io::Result<()> {
                    let metadata = fs::symlink_metadata(source_file)?;
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "source is not a regular file",
                        ));
                    }
                    let canonical_source = dunce::canonicalize(source_file)?;
                    if !canonical_source.starts_with(&source) {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "source escaped selected folder",
                        ));
                    }
                    let mut input = fs::File::open(canonical_source)?;
                    let mut output = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(destination)?;
                    if let Err(error) = std::io::copy(&mut input, &mut output) {
                        let _ = fs::remove_file(destination);
                        return Err(error);
                    }
                    output.sync_all()
                };
                match ids.as_slice() {
                    [notebook_id] => store.with_file_write(
                        notebook_id,
                        &target,
                        flowix_core::memo_file::FileLockIntent::Create,
                        "import_folder_file",
                        copy,
                    ),
                    [] => {
                        let _guard = store
                            .acquire_cross_process_write_lock()
                            .map_err(file_mutation_error)?;
                        copy(&target)
                    }
                    _ => store.with_registered_path_change(
                        &[&target],
                        "import_folder_nested_notebooks",
                        || copy(&target),
                    ),
                }
                .map_err(file_mutation_error)?;
            }
            Ok(())
        })();
        if let Err(import_error) = copy_result {
            if let Err(cleanup_error) = fs::remove_dir_all(&target_root) {
                tracing::warn!(
                    target = %target_root.display(),
                    error = %cleanup_error,
                    "failed to clean up partially imported folder"
                );
                return Err(FileOperationFailure {
                    code: "IMPORT_FOLDER_CLEANUP_FAILED".to_string(),
                    message: Some(format!(
                        "Import failed ({}) and partial files could not be removed ({cleanup_error})",
                        import_error.code
                    )),
                });
            }
            return Err(import_error);
        }
        Ok(target_root.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| FileOperationFailure::code(&format!("FILE_OPERATION_FAILED: {error}")))?
}
