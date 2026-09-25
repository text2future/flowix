use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/notebook_template_assets.rs"));

const LEGACY_NOTES_MIGRATION_MARKER: &str = ".notes-template-migration-v1-complete";

pub fn initialize(user_config_dir: &Path) -> Result<(), String> {
    initialize_notebook_templates(user_config_dir)?;

    let templates_dir = user_config_dir.join("templates");
    let notes_templates_dir = templates_dir.join("notes");

    fs::create_dir_all(&notes_templates_dir)
        .map_err(|error| format!("create note template directory failed: {error}"))?;
    migrate_legacy_note_templates(user_config_dir, &templates_dir, &notes_templates_dir)?;

    Ok(())
}

pub fn initialize_notebook_templates(user_config_dir: &Path) -> Result<(), String> {
    let notebook_templates_dir = user_config_dir.join("templates").join("notebook-templates");
    fs::create_dir_all(&notebook_templates_dir)
        .map_err(|error| format!("create notebook template directory failed: {error}"))?;
    seed_notebook_templates_if_needed(&notebook_templates_dir)
}

pub fn notebook_templates_dir(user_config_dir: &Path) -> PathBuf {
    user_config_dir.join("templates").join("notebook-templates")
}

pub fn notes_templates_dir(user_config_dir: &Path) -> PathBuf {
    user_config_dir.join("templates").join("notes")
}

fn seed_notebook_templates_if_needed(target_dir: &Path) -> Result<(), String> {
    let index_path = target_dir.join("index.json");
    if index_path.exists() {
        return Ok(());
    }

    for &(relative, content) in NOTEBOOK_TEMPLATE_ASSETS
        .iter()
        .filter(|(relative, _)| *relative != "index.json")
    {
        let relative_path = Path::new(relative);
        if relative_path.components().any(|component| {
            !matches!(component, Component::Normal(_))
        }) {
            return Err(format!("invalid bundled template path: {relative}"));
        }

        let target = target_dir.join(relative_path);
        let parent = target
            .parent()
            .ok_or_else(|| format!("invalid bundled template path: {relative}"))?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("create bundled template folder failed: {error}"))?;
        write_if_missing(&target, content)?;
    }

    let index_content = NOTEBOOK_TEMPLATE_ASSETS
        .iter()
        .find_map(|(relative, content)| (*relative == "index.json").then_some(*content))
        .ok_or_else(|| "bundled notebook template index is missing".to_string())?;
    write_if_missing(&index_path, index_content)?;

    Ok(())
}

fn migrate_legacy_note_templates(
    user_config_dir: &Path,
    templates_dir: &Path,
    notes_templates_dir: &Path,
) -> Result<(), String> {
    let legacy_dir = user_config_dir.join("template");
    if !legacy_dir.is_dir() {
        return Ok(());
    }

    let marker = templates_dir.join(LEGACY_NOTES_MIGRATION_MARKER);
    if marker.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(&legacy_dir)
        .map_err(|error| format!("read legacy note template directory failed: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read legacy note template failed: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect legacy note template failed: {error}"))?;
        if !file_type.is_file() {
            continue;
        }

        let source = entry.path();
        let extension = source
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default();
        if !matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown") {
            continue;
        }

        let filename = source
            .file_name()
            .ok_or_else(|| "invalid legacy note template filename".to_string())?;
        let target = notes_templates_dir.join(filename);
        let content = fs::read(&source)
            .map_err(|error| format!("read legacy note template failed: {error}"))?;
        write_if_missing(&target, &content)?;
    }

    write_if_missing(&marker, b"completed\n")
}

fn write_if_missing(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(format!("create template file failed: {error}")),
    };

    if let Err(error) = file.write_all(content) {
        let _ = fs::remove_file(path);
        return Err(format!("write template file failed: {error}"));
    }
    Ok(())
}
