use std::fs;
use std::path::{Component, Path, PathBuf};

pub fn initialize(user_config_dir: &Path) -> Result<(), String> {
    let templates_dir = user_config_dir.join("templates");
    let notes_templates_dir = templates_dir.join("notes");

    flowix_core::memo_file::ensure_storage_directory(&notes_templates_dir)
        .map_err(|error| format!("create note template directory failed: {error}"))?;
    migrate_legacy_note_templates(user_config_dir, &notes_templates_dir)?;

    Ok(())
}

pub fn notes_templates_dir(user_config_dir: &Path) -> PathBuf {
    user_config_dir.join("templates").join("notes")
}

fn migrate_legacy_note_templates(
    user_config_dir: &Path,
    notes_templates_dir: &Path,
) -> Result<(), String> {
    let legacy_dir = user_config_dir.join("template");
    let metadata = match fs::symlink_metadata(&legacy_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "inspect legacy note template directory failed: {error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("legacy note template path is not a regular directory".to_string());
    }
    copy_legacy_template_tree(&legacy_dir, &legacy_dir, notes_templates_dir)?;

    fs::remove_dir_all(&legacy_dir)
        .map_err(|error| format!("remove legacy note template directory failed: {error}"))
}

fn copy_legacy_template_tree(root: &Path, source: &Path, destination: &Path) -> Result<(), String> {
    let entries = fs::read_dir(source)
        .map_err(|error| format!("read legacy note template directory failed: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read legacy note template failed: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect legacy note template failed: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("resolve legacy note template path failed: {error}"))?;
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            continue;
        }
        let target = destination.join(relative);
        if file_type.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| format!("create note template directory failed: {error}"))?;
            copy_legacy_template_tree(root, &path, destination)?;
        } else if file_type.is_file() {
            let content = fs::read(&path)
                .map_err(|error| format!("read legacy note template failed: {error}"))?;
            write_if_missing(&target, &content)?;
        }
    }
    Ok(())
}

fn write_if_missing(path: &Path, content: &[u8]) -> Result<(), String> {
    match flowix_core::memo_file::atomic_create_bytes(path, content) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!("create template file failed: {error}")),
    }
}
