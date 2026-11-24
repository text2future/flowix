//! Private notebook-local storage for reusable editor HTML components.

use std::{fs, path::Path};

use tauri::State;

use crate::{
    app::state::AppState, commands::helpers::is_registered_notebook_root, config::path_is_inside,
    lock_utils::read_lock,
};

const MAX_COMPONENT_BYTES: u64 = 64 * 1024;

/// Ensure the editor component directory exists and list its direct HTML files.
/// The generic notebook tree intentionally hides `.flowix`, so this narrowly
/// scoped command is the only directory enumeration path exposed to the picker.
#[tauri::command]
pub fn list_editor_components(
    notebook_path: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) || !root.is_dir() {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }

    let internal = root.join(".flowix");
    let directory = internal.join("editor-components");
    if !path_is_inside(&directory, root) {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }

    if internal.exists() {
        let metadata = fs::symlink_metadata(&internal).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("FILE_PERMISSION_DENIED".to_string());
        }
    }

    let memo_file = read_lock(&state.memo_file, "memo_file");
    memo_file
        .with_registered_path_change(&[&directory], "list_editor_components", || {
            if !internal.exists() {
                fs::create_dir(&internal)?;
            }
            if !directory.exists() {
                fs::create_dir(&directory)?;
            }
            Ok(())
        })
        .map_err(|error| error.to_string())?;

    for path in [&internal, &directory] {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("FILE_PERMISSION_DENIED".to_string());
        }
    }

    let entries = fs::read_dir(&directory).map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.is_file()
            && !metadata.file_type().is_symlink()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("html"))
        {
            paths.push(path.to_string_lossy().into_owned());
        }
    }
    paths.sort();
    Ok(paths)
}

/// Read one direct HTML child of the private editor component directory.
/// Generic notebook file reads deliberately reject `.flowix`, so the picker
/// uses this narrowly scoped command after enumerating the component files.
#[tauri::command]
pub fn read_editor_component(
    file_path: String,
    notebook_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    let root = Path::new(&notebook_path);
    if !is_registered_notebook_root(root, &state) || !root.is_dir() {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }

    let internal = root.join(".flowix");
    let directory = internal.join("editor-components");
    let component_path = Path::new(&file_path);
    if !path_is_inside(&directory, root)
        || !component_path.is_absolute()
        || component_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("html"))
    {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }

    for path in [&internal, &directory] {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("FILE_PERMISSION_DENIED".to_string());
        }
    }

    let component_metadata =
        fs::symlink_metadata(component_path).map_err(|error| error.to_string())?;
    if !component_metadata.is_file() || component_metadata.file_type().is_symlink() {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }
    if component_metadata.len() > MAX_COMPONENT_BYTES {
        return Err("COMPONENT_TOO_LARGE".to_string());
    }

    let canonical_directory = dunce::canonicalize(&directory).map_err(|error| error.to_string())?;
    let canonical_component =
        dunce::canonicalize(component_path).map_err(|error| error.to_string())?;
    if canonical_component.parent() != Some(canonical_directory.as_path())
        || !path_is_inside(&canonical_component, root)
    {
        return Err("FILE_PERMISSION_DENIED".to_string());
    }

    fs::read_to_string(canonical_component).map_err(|error| error.to_string())
}
