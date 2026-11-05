//! Safe installation of Flowix notebook templates from the official market.
use fs2::FileExt;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use tauri::State;

const MAX_TEMPLATE_PACKAGE_BYTES: usize = 24 * 1024 * 1024;
const MAX_TEMPLATE_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEMPLATE_FILES: usize = 300;
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookTemplateArchive {
    url: String,
    #[serde(default)]
    target_directory: Option<String>,
}

struct TemplateFile {
    path: PathBuf,
    bytes: Vec<u8>,
}

fn template_directory_name<'a>(
    id: &'a str,
    archive: &'a NotebookTemplateArchive,
) -> Result<&'a str, String> {
    let directory = archive.target_directory.as_deref().unwrap_or(id);
    // Only one visible directory component is allowed; reserved metadata stays protected.
    if directory.trim() != directory
        || directory.is_empty()
        || directory.starts_with('.')
        || directory.len() > 200
        || validate_template_path(directory).is_err()
        || directory.contains('/')
    {
        return Err("Notebook template target directory is invalid".to_string());
    }
    Ok(directory)
}

fn validate_template_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || id.split('-').any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
    {
        return Err("Notebook template ID is invalid".to_string());
    }
    Ok(())
}

fn validate_template_archive_request(
    id: &str,
    archive: &NotebookTemplateArchive,
) -> Result<url::Url, String> {
    validate_template_id(id)?;
    let url = url::Url::parse(&archive.url)
        .map_err(|_| "Notebook template archive URL is invalid".to_string())?;
    let production = url.scheme() == "https"
        && url.host_str() == Some("skills.flowix.cc")
        && url.port_or_known_default() == Some(443);
    let local = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if (!production && !local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != format!("/templates/archives/{id}.zip")
    {
        return Err("Notebook template ZIP must come from the Flowix Skill Market".to_string());
    }
    Ok(url)
}

fn validate_template_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 512 || value.starts_with('/') || value.contains('\\') {
        return Err("Notebook template contains an invalid file path".to_string());
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.len() > 20
        || segments.iter().any(|segment| {
            segment.is_empty()
                || *segment == "."
                || *segment == ".."
                || segment.ends_with('.')
                || segment.ends_with(' ')
                || is_reserved_windows_name(segment)
                || segment.chars().any(|character| {
                    character.is_control()
                        || matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|')
                })
        })
        || value.eq_ignore_ascii_case(".flowix-template.json")
    {
        return Err("Notebook template contains an unsafe file path".to_string());
    }
    Ok(segments.into_iter().collect())
}

fn ensure_template_install_directory(root: &Path, path: &Path) -> Result<(), String> {
    if !crate::config::path_is_inside(path, root) {
        return Err("Notebook template install path resolves outside the notebook".to_string());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Notebook template install path must be a regular directory".to_string());
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to inspect notebook template install path: {error}"
            ));
        }
    }
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "failed to create notebook template install path: {error}"
            ));
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || !crate::config::path_is_inside(path, root)
    {
        return Err("Notebook template install path must stay inside the notebook".to_string());
    }
    Ok(())
}

fn is_reserved_windows_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.len() == 1 && suffix.as_bytes()[0].is_ascii_digit() && suffix != "0"
            })
        })
}

fn decode_template_zip(bytes: &[u8]) -> Result<Vec<TemplateFile>, String> {
    if bytes.is_empty() || bytes.len() > MAX_TEMPLATE_PACKAGE_BYTES {
        return Err("Notebook template ZIP exceeds the allowed download size".to_string());
    }
    let mut archive = zip::ZipArchive::new(io::Cursor::new(bytes))
        .map_err(|error| format!("invalid notebook template ZIP: {error}"))?;
    if archive.len() == 0 || archive.len() > MAX_TEMPLATE_FILES {
        return Err("Notebook template contains an invalid number of files".to_string());
    }

    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut total_bytes = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to read notebook template ZIP entry: {error}"))?;
        let filename = entry.name().to_string();
        let mode = entry.unix_mode().unwrap_or(0);
        let kind = mode & 0o170000;
        if kind != 0 && kind != 0o100000 && kind != 0o040000 {
            return Err(
                "Notebook template ZIP must not contain links or special files".to_string(),
            );
        }
        if entry.is_dir() {
            let normalized = filename.trim_end_matches('/');
            let _ = validate_template_path(normalized)?;
            if entry.size() != 0 {
                return Err("Notebook template ZIP directory contains file data".to_string());
            }
            continue;
        }
        if kind == 0o040000 {
            return Err("Notebook template ZIP contains an invalid directory entry".to_string());
        }
        let path = validate_template_path(&filename)?;
        let key = filename.to_lowercase();
        if !seen.insert(key) {
            return Err("Notebook template ZIP contains duplicate file paths".to_string());
        }
        if entry.size() > MAX_TEMPLATE_FILE_BYTES as u64 {
            return Err("Notebook template ZIP contains a file that is too large".to_string());
        }
        let mut content = Vec::new();
        entry
            .by_ref()
            .take(MAX_TEMPLATE_FILE_BYTES as u64 + 1)
            .read_to_end(&mut content)
            .map_err(|error| format!("failed to decompress notebook template ZIP: {error}"))?;
        if content.len() > MAX_TEMPLATE_FILE_BYTES || content.len() as u64 != entry.size() {
            return Err("Notebook template ZIP entry exceeds its allowed size".to_string());
        }
        total_bytes = total_bytes.saturating_add(content.len());
        if total_bytes > MAX_TEMPLATE_PACKAGE_BYTES {
            return Err("Notebook template ZIP expands beyond the allowed size".to_string());
        }
        files.push(TemplateFile {
            path,
            bytes: content,
        });
    }
    if files.is_empty() {
        return Err("Notebook template ZIP is empty".to_string());
    }
    Ok(files)
}

fn create_template_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("failed to create notebook template file: {error}"))?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(format!("failed to write notebook template file: {error}"));
    }
    Ok(())
}

fn installed_template_ids(root: &Path) -> Result<Vec<String>, String> {
    let mut ids = std::collections::BTreeSet::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
            || entry.file_name().to_string_lossy().starts_with('.')
        {
            continue;
        }
        let marker = entry.path().join(".flowix-template.json");
        let Ok(metadata) = fs::symlink_metadata(&marker) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            continue;
        }
        let Ok(bytes) = fs::read(&marker) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if let Some(id) = value.get("templateId").and_then(Value::as_str) {
            if validate_template_id(id).is_ok() {
                ids.insert(id.to_string());
            }
        }
    }
    Ok(ids.into_iter().collect())
}

fn installed_template_marker(root: &Path, id: &str) -> Result<bool, String> {
    validate_template_id(id)?;
    Ok(installed_template_ids(root)?
        .iter()
        .any(|installed| installed == id))
}

fn install_template_zip(
    root: &Path,
    id: &str,
    bytes: &[u8],
    archive: &NotebookTemplateArchive,
) -> Result<PathBuf, String> {
    validate_template_id(id)?;
    let display_directory = template_directory_name(id, archive)?;
    let files = decode_template_zip(bytes)?;

    let flowix_directory = root.join(".flowix");
    let lock_directory = flowix_directory.join("template-installs");
    for directory in [&flowix_directory, &lock_directory] {
        ensure_template_install_directory(root, directory)?;
    }
    let lock_path = lock_directory.join(format!("{id}.lock"));
    if let Ok(metadata) = fs::symlink_metadata(&lock_path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Notebook template install lock must be a regular file".to_string());
        }
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| format!("failed to open notebook template install lock: {error}"))?;
    lock.lock_exclusive()
        .map_err(|error| format!("failed to lock notebook template install: {error}"))?;

    if installed_template_marker(root, id)? {
        return Err("a notebook template with this ID already exists".to_string());
    }
    let target = root.join(display_directory);
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err("a folder with this notebook template name already exists".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to inspect notebook template destination: {error}"
            ))
        }
    }

    let template_work = lock_directory.join(id);
    ensure_template_install_directory(root, &template_work)?;
    // The per-template lock excludes live writers while abandoned stages are cleaned.
    for entry in fs::read_dir(&template_work).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().starts_with("stage-") {
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() || !kind.is_dir() {
                return Err(
                    "Abandoned notebook template stage must be a regular directory".to_string(),
                );
            }
            fs::remove_dir_all(entry.path()).map_err(|error| {
                format!("failed to clean abandoned notebook template stage: {error}")
            })?;
        }
    }
    // Keep partial files inside the notebook's internal directory until publication.
    let staging = tempfile::Builder::new()
        .prefix("stage-")
        .tempdir_in(&template_work)
        .map_err(|error| format!("failed to stage notebook template installation: {error}"))?;
    for file in files {
        let destination = staging.path().join(file.path);
        let parent = destination
            .parent()
            .ok_or_else(|| "Notebook template contains an invalid file path".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create notebook template folder: {error}"))?;
        create_template_file(&destination, &file.bytes)?;
    }
    let marker = serde_json::json!({
        "formatVersion": 1,
        "templateId": id,
        "targetDirectory": display_directory,
        "installedAt": chrono::Utc::now().to_rfc3339(),
        "archiveUrl": validate_template_archive_request(id, archive)?.as_str(),
    });
    create_template_file(
        &staging.path().join(".flowix-template.json"),
        &serde_json::to_vec_pretty(&marker).map_err(|error| error.to_string())?,
    )?;
    fs::rename(staging.path(), &target)
        .map_err(|error| format!("failed to publish notebook template installation: {error}"))?;
    Ok(target)
}

#[tauri::command]
pub async fn notebook_template_install_zip(
    cwd: String,
    template_id: String,
    archive: NotebookTemplateArchive,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Value, crate::commands::market_package::MarketInstallError> {
    let root = super::helpers::is_registered_notebook_root(Path::new(&cwd), &state)
        .then(|| PathBuf::from(&cwd))
        .ok_or_else(|| "Notebook template install requires a registered notebook".to_string())?;
    let url = validate_template_archive_request(&template_id, &archive)?;
    let bytes =
        crate::commands::market_package::download_market_zip(url, MAX_TEMPLATE_PACKAGE_BYTES)
            .await?;
    let requested_id = template_id.clone();
    let installed_path = tokio::task::spawn_blocking(move || {
        install_template_zip(&root, &template_id, &bytes, &archive)
    })
    .await
    .map_err(|error| format!("Notebook template installation failed: {error}"))??;
    Ok(serde_json::json!({ "path": installed_path, "templateId": requested_id }))
}

#[tauri::command]
pub fn notebook_template_is_installed(
    cwd: String,
    template_id: String,
    state: State<'_, crate::app::state::AppState>,
) -> Result<bool, String> {
    validate_template_id(&template_id)?;
    let root = super::helpers::is_registered_notebook_root(Path::new(&cwd), &state)
        .then(|| PathBuf::from(&cwd))
        .ok_or_else(|| "Notebook template lookup requires a registered notebook".to_string())?;
    installed_template_marker(&root, &template_id)
}

#[tauri::command]
pub fn notebook_template_list_installed(
    cwd: String,
    state: State<'_, crate::app::state::AppState>,
) -> Result<Vec<String>, String> {
    let root = super::helpers::is_registered_notebook_root(Path::new(&cwd), &state)
        .then(|| PathBuf::from(&cwd))
        .ok_or_else(|| "Notebook template lookup requires a registered notebook".to_string())?;
    installed_template_ids(&root)
}

#[cfg(test)]
mod template_install_tests {
    use super::*;

    fn package() -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        writer
            .start_file("README.md", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"complete template").unwrap();
        writer.finish().unwrap().into_inner()
    }

    fn archive() -> NotebookTemplateArchive {
        NotebookTemplateArchive {
            url: "https://skills.flowix.cc/templates/archives/self-media-management.zip".into(),
            target_directory: Some("自媒体管理".into()),
        }
    }

    #[test]
    fn retry_cleans_only_its_internal_stages_and_publishes_complete_template() {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join(".flowix/template-installs");
        let abandoned = work.join("self-media-management/stage-crashed");
        let other = work.join("other-template/stage-active");
        fs::create_dir_all(&abandoned).unwrap();
        fs::write(abandoned.join("README.md"), b"partial").unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("README.md"), b"keep").unwrap();

        let target =
            install_template_zip(root.path(), "self-media-management", &package(), &archive())
                .unwrap();

        assert_eq!(
            fs::read(target.join("README.md")).unwrap(),
            b"complete template"
        );
        assert!(installed_template_marker(root.path(), "self-media-management").unwrap());
        assert!(!abandoned.exists());
        assert_eq!(fs::read(other.join("README.md")).unwrap(), b"keep");
        assert_eq!(
            fs::read_dir(work.join("self-media-management"))
                .unwrap()
                .count(),
            0
        );
        assert!(fs::read_dir(root.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".flowix-template-stage-")));
    }

    #[test]
    fn failure_cleans_internal_stage_and_retry_preserves_existing_template() {
        let root = tempfile::tempdir().unwrap();
        let invalid_archive = NotebookTemplateArchive {
            url: "https://invalid.example/template.zip".into(),
            target_directory: Some("自媒体管理".into()),
        };
        assert!(install_template_zip(
            root.path(),
            "self-media-management",
            &package(),
            &invalid_archive
        )
        .is_err());
        assert!(!root.path().join("自媒体管理").exists());
        let work = root
            .path()
            .join(".flowix/template-installs/self-media-management");
        assert_eq!(fs::read_dir(&work).unwrap().count(), 0);

        let target =
            install_template_zip(root.path(), "self-media-management", &package(), &archive())
                .unwrap();
        fs::write(target.join("README.md"), b"user content").unwrap();
        assert!(
            install_template_zip(root.path(), "self-media-management", &package(), &archive())
                .is_err()
        );
        assert_eq!(fs::read(target.join("README.md")).unwrap(), b"user content");
    }
    #[test]
    fn generic_templates_are_discovered_by_marker_after_directory_rename() {
        let root = tempfile::tempdir().unwrap();
        let archive = NotebookTemplateArchive {
            url: "https://skills.flowix.cc/templates/archives/work-plan.zip".into(),
            target_directory: Some("工作计划".into()),
        };
        let target = install_template_zip(root.path(), "work-plan", &package(), &archive).unwrap();
        fs::rename(target, root.path().join("重命名计划")).unwrap();
        assert_eq!(
            installed_template_ids(root.path()).unwrap(),
            vec!["work-plan"]
        );
        assert!(install_template_zip(root.path(), "work-plan", &package(), &archive).is_err());
        assert!(!root.path().join("工作计划").exists());
    }

    #[test]
    fn template_target_cannot_escape_or_use_internal_directories() {
        let root = tempfile::tempdir().unwrap();
        for target in [
            "../outside",
            ".flowix",
            ".agents",
            "folder/child",
            "CON",
            "trailing ",
            "",
        ] {
            let archive = NotebookTemplateArchive {
                url: "https://skills.flowix.cc/templates/archives/work-plan.zip".into(),
                target_directory: Some(target.into()),
            };
            assert!(
                install_template_zip(root.path(), "work-plan", &package(), &archive).is_err(),
                "{target}"
            );
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
