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
}

struct TemplateFile {
    path: PathBuf,
    bytes: Vec<u8>,
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
    if !crate::commands::market_package::is_market_archive_origin(&url)
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
        || segments[0].eq_ignore_ascii_case(".flowix")
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

fn read_template_marker(marker: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(marker).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return None;
    }
    let value: Value = serde_json::from_slice(&fs::read(marker).ok()?).ok()?;
    let id = value.get("templateId")?.as_str()?;
    validate_template_id(id).ok()?;
    Some(id.to_string())
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
        if let Some(id) = read_template_marker(&entry.path().join(".flowix-template.json")) {
            ids.insert(id);
        }
    }
    // Root installations keep their receipts in internal metadata; legacy folder
    // markers above remain discoverable, including renamed template folders.
    let installs = root.join(".flowix/template-installs");
    if installs.exists() {
        ensure_template_install_directory(root, &root.join(".flowix"))?;
        ensure_template_install_directory(root, &installs)?;
        for entry in fs::read_dir(&installs).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            if let Some(id) = read_template_marker(&entry.path().join("installed.json")) {
                ids.insert(id);
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

fn template_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let destination = root.join(relative);
    let mut parent = root.to_path_buf();
    if let Some(relative_parent) = relative.parent() {
        for component in relative_parent.components() {
            parent.push(component);
            match fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err("Notebook template parent must be a regular directory".to_string());
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    Ok(destination)
}

fn template_destination(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let destination = template_path(root, relative)?;
    match fs::symlink_metadata(&destination) {
        Ok(_) => Err("a file with this notebook template path already exists".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(destination),
        Err(error) => Err(error.to_string()),
    }
}

fn publish_template_at_root(root: &Path, staging: &Path, paths: &[PathBuf]) -> Result<(), String> {
    // An existing hard link to this stage belongs to an interrupted publication.
    // A replaced file remains a conflict; recovery never overwrites user content.
    let already_published = |relative: &Path| -> Result<bool, String> {
        let source = template_path(staging, relative)?;
        let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Notebook template staged file must be a regular file".to_string());
        }
        let destination = template_path(root, relative)?;
        match fs::symlink_metadata(&destination) {
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && same_file::is_same_file(&source, &destination)
                        .map_err(|error| error.to_string())? =>
            {
                Ok(true)
            }
            Ok(_) => Err("a file with this notebook template path already exists".to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    };
    // Preflight the entire package before creating any user-visible paths.
    for path in paths {
        already_published(path)?;
    }
    let mut created_files = Vec::new();
    let mut created_directories = Vec::new();
    let result = (|| {
        for path in paths {
            if already_published(path)? {
                continue;
            }
            let destination = template_destination(root, path)?;
            let mut parent = root.to_path_buf();
            if let Some(relative_parent) = path.parent() {
                for component in relative_parent.components() {
                    parent.push(component);
                    if !parent.exists() {
                        fs::create_dir(&parent).map_err(|error| error.to_string())?;
                        created_directories.push(parent.clone());
                    }
                    ensure_template_install_directory(root, &parent)?;
                }
            }
            fs::hard_link(staging.join(path), &destination)
                .map_err(|error| format!("failed to publish notebook template file: {error}"))?;
            created_files.push(destination);
        }
        Ok(())
    })();
    if result.is_err() {
        for file in created_files.iter().rev() {
            let _ = fs::remove_file(file);
        }
        for directory in created_directories.iter().rev() {
            let _ = fs::remove_dir(directory);
        }
    }
    result
}

fn record_template_publication(stage: &Path, paths: &[PathBuf]) -> Result<(), String> {
    // Use portable separators so the journal can also be read on Windows.
    let paths: Vec<String> = paths
        .iter()
        .map(|path| {
            path.iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .collect();
    // A crash during writing leaves no committed journal and no published files.
    let pending = stage.join("publication.pending");
    create_template_file(
        &pending,
        &serde_json::to_vec(&paths).map_err(|error| error.to_string())?,
    )?;
    fs::rename(pending, stage.join("publication.json")).map_err(|error| error.to_string())
}

fn recover_template_publication(root: &Path, id: &str, work: &Path) -> Result<bool, String> {
    let installed = installed_template_marker(root, id)?;
    let receipt = PathBuf::from(".flowix/template-installs")
        .join(id)
        .join("installed.json");
    let mut recovered = false;
    for entry in fs::read_dir(work).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_name().to_string_lossy().starts_with("stage-") {
            continue;
        }
        let stage = entry.path();
        ensure_template_install_directory(root, &stage)?;
        let journal = stage.join("publication.json");
        if !installed && !recovered && journal.try_exists().map_err(|error| error.to_string())? {
            let metadata = fs::symlink_metadata(&journal).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() > 256 * 1024
            {
                return Err("Notebook template publication manifest is invalid".to_string());
            }
            let relative_paths: Vec<String> =
                serde_json::from_slice(&fs::read(&journal).map_err(|error| error.to_string())?)
                    .map_err(|error| {
                        format!("invalid notebook template publication manifest: {error}")
                    })?;
            if relative_paths.len() < 2
                || relative_paths.len() > MAX_TEMPLATE_FILES + 1
                || relative_paths.last().map(PathBuf::from).as_ref() != Some(&receipt)
            {
                return Err("Notebook template publication manifest is invalid".to_string());
            }
            let mut paths = Vec::with_capacity(relative_paths.len());
            for path in &relative_paths[..relative_paths.len() - 1] {
                paths.push(validate_template_path(path)?);
            }
            paths.push(receipt.clone());
            let content = stage.join("content");
            ensure_template_install_directory(root, &content)?;
            if read_template_marker(&content.join(&receipt)).as_deref() != Some(id) {
                return Err("Notebook template staged receipt is invalid".to_string());
            }
            publish_template_at_root(root, &content, &paths)?;
            recovered = true;
        }
        // No journal means publication never began. A receipt means it completed.
        fs::remove_dir_all(&stage).map_err(|error| error.to_string())?;
    }
    Ok(recovered)
}

fn install_template_zip(
    root: &Path,
    id: &str,
    bytes: &[u8],
    archive: &NotebookTemplateArchive,
) -> Result<PathBuf, String> {
    let archive_url = validate_template_archive_request(id, archive)?;
    let files = decode_template_zip(bytes)?;

    let flowix_directory = root.join(".flowix");
    let lock_directory = flowix_directory.join("template-installs");
    for directory in [&flowix_directory, &lock_directory] {
        ensure_template_install_directory(root, directory)?;
    }
    let lock_path = lock_directory.join("install.lock");
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

    let template_work = lock_directory.join(id);
    ensure_template_install_directory(root, &template_work)?;
    if recover_template_publication(root, id, &template_work)? {
        return Ok(root.to_path_buf());
    }
    if installed_template_marker(root, id)? {
        return Err("a notebook template with this ID already exists".to_string());
    }
    // Keep partial files inside the notebook's internal directory until publication.
    let staging = tempfile::Builder::new()
        .prefix("stage-")
        .tempdir_in(&template_work)
        .map_err(|error| format!("failed to stage notebook template installation: {error}"))?;
    let content = staging.path().join("content");
    for file in &files {
        let destination = content.join(&file.path);
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
        "installLocation": "notebookRoot",
        "installedAt": chrono::Utc::now().to_rfc3339(),
        "archiveUrl": archive_url.as_str(),
    });
    // Publish the receipt as the last file, so failed merges are not marked installed.
    let receipt_path = PathBuf::from(".flowix/template-installs")
        .join(id)
        .join("installed.json");
    // Include the internal receipt in the same rollback transaction as the content.
    let receipt_stage = content.join(&receipt_path);
    fs::create_dir_all(receipt_stage.parent().unwrap()).map_err(|error| error.to_string())?;
    create_template_file(
        &receipt_stage,
        &serde_json::to_vec_pretty(&marker).map_err(|error| error.to_string())?,
    )?;
    let mut publication: Vec<PathBuf> = files.into_iter().map(|file| file.path).collect();
    publication.push(receipt_path);
    // Persist the manifest before publishing anything. Keep the stage across errors
    // and process exits so the next attempt can identify and resume its hard links.
    record_template_publication(staging.path(), &publication)?;
    let stage_path = staging.keep();
    publish_template_at_root(root, &content, &publication)?;
    // A committed receipt is authoritative even if temporary cleanup fails.
    let _ = fs::remove_dir_all(stage_path);
    Ok(root.to_path_buf())
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

    fn package_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn package() -> Vec<u8> {
        package_with(&[("README.md", b"complete template")])
    }

    fn archive() -> NotebookTemplateArchive {
        NotebookTemplateArchive {
            url: "https://skills.flowix.cc/templates/archives/self-media-management.zip".into(),
        }
    }

    #[test]
    fn official_website_template_archive_is_accepted() {
        let mut request = archive();
        request.url = "https://flowix.cc/templates/archives/self-media-management.zip".into();
        assert!(validate_template_archive_request("self-media-management", &request).is_ok());
        request.url =
            "https://flowix.cc.evil.test/templates/archives/self-media-management.zip".into();
        assert!(validate_template_archive_request("self-media-management", &request).is_err());
    }

    #[test]
    fn retry_cleans_only_its_internal_stages_and_publishes_complete_template() {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join(".flowix/template-installs");
        let abandoned = work.join("self-media-management/stage-crashed");
        let other = work.join("other-template/stage-active");
        fs::create_dir_all(&abandoned).unwrap();
        fs::write(abandoned.join("README.md"), b"partial").unwrap();
        fs::write(abandoned.join("publication.pending"), b"incomplete journal").unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("README.md"), b"keep").unwrap();

        let target =
            install_template_zip(root.path(), "self-media-management", &package(), &archive())
                .unwrap();

        assert_eq!(target, root.path());
        assert!(!root.path().join("自媒体管理").exists());
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
            1
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
        assert!(!work.exists());

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
        };
        let target = install_template_zip(root.path(), "work-plan", &package(), &archive).unwrap();
        assert_eq!(target, root.path());
        let legacy = root.path().join("重命名计划");
        fs::create_dir(&legacy).unwrap();
        fs::write(
            legacy.join(".flowix-template.json"),
            br#"{"templateId":"legacy-plan"}"#,
        )
        .unwrap();
        assert_eq!(
            installed_template_ids(root.path()).unwrap(),
            vec!["legacy-plan", "work-plan"]
        );
        assert!(install_template_zip(root.path(), "work-plan", &package(), &archive).is_err());
        assert!(!root.path().join("工作计划").exists());
    }

    #[test]
    fn root_install_merges_directories_and_includes_hidden_skills() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("01 账号空间")).unwrap();
        fs::write(root.path().join("01 账号空间/已有笔记.md"), b"keep").unwrap();
        let bytes = package_with(&[
            ("01 账号空间/账号定位.md", b"profile"),
            (".agents/skills/xhs-topic-planner/SKILL.md", b"skill"),
            ("installed.json", b"template-owned file"),
        ]);
        let target =
            install_template_zip(root.path(), "self-media-management", &bytes, &archive()).unwrap();
        assert_eq!(target, root.path());
        assert_eq!(
            fs::read(target.join("01 账号空间/已有笔记.md")).unwrap(),
            b"keep"
        );
        assert_eq!(
            fs::read(target.join("01 账号空间/账号定位.md")).unwrap(),
            b"profile"
        );
        assert_eq!(
            fs::read(target.join(".agents/skills/xhs-topic-planner/SKILL.md")).unwrap(),
            b"skill"
        );
        assert_eq!(
            fs::read(target.join("installed.json")).unwrap(),
            b"template-owned file"
        );
        assert!(installed_template_marker(root.path(), "self-media-management").unwrap());
    }

    #[test]
    fn conflict_is_detected_before_any_template_content_is_published() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("AGENTS.md"), b"existing rules").unwrap();
        let bytes = package_with(&[("new/first.md", b"new"), ("AGENTS.md", b"template rules")]);
        assert!(
            install_template_zip(root.path(), "self-media-management", &bytes, &archive()).is_err()
        );
        assert!(!root.path().join("new").exists());
        assert_eq!(
            fs::read(root.path().join("AGENTS.md")).unwrap(),
            b"existing rules"
        );
        assert!(!installed_template_marker(root.path(), "self-media-management").unwrap());
    }

    #[test]
    fn missing_staged_file_is_detected_before_publication() {
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("existing")).unwrap();
        fs::write(root.path().join("existing/keep.md"), b"keep").unwrap();
        fs::create_dir(stage.path().join("new")).unwrap();
        fs::write(stage.path().join("new/first.md"), b"new").unwrap();
        let files = vec![
            PathBuf::from("new/first.md"),
            PathBuf::from("existing/missing.md"),
        ];
        assert!(publish_template_at_root(root.path(), stage.path(), &files).is_err());
        assert!(!root.path().join("new").exists());
        assert_eq!(
            fs::read(root.path().join("existing/keep.md")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn package_cannot_write_internal_notebook_metadata() {
        for name in [
            ".flowix/settings.json",
            ".FLOWIX/template-installs/other/installed.json",
        ] {
            assert!(decode_template_zip(&package_with(&[(name, b"unsafe")])).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn root_install_rejects_symlinked_parent() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join(".agents")).unwrap();
        let bytes = package_with(&[(".agents/skills/example/SKILL.md", b"skill")]);
        assert!(
            install_template_zip(root.path(), "self-media-management", &bytes, &archive()).is_err()
        );
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    fn interrupted_publication(root: &Path) -> (PathBuf, Vec<PathBuf>) {
        let work = root.join(".flowix/template-installs/self-media-management");
        let stage = work.join("stage-interrupted");
        let content = stage.join("content");
        let paths = vec![
            PathBuf::from("new/first.md"),
            PathBuf::from("new/second.md"),
            PathBuf::from(".flowix/template-installs/self-media-management/installed.json"),
        ];
        for (path, bytes) in paths.iter().zip([
            b"first".as_slice(),
            b"second".as_slice(),
            br#"{"templateId":"self-media-management"}"#.as_slice(),
        ]) {
            let source = content.join(path);
            fs::create_dir_all(source.parent().unwrap()).unwrap();
            fs::write(source, bytes).unwrap();
        }
        record_template_publication(&stage, &paths).unwrap();
        fs::create_dir(root.join("new")).unwrap();
        fs::hard_link(content.join(&paths[0]), root.join(&paths[0])).unwrap();
        (stage, paths)
    }

    #[test]
    fn retry_resumes_interrupted_publication_and_preserves_edits() {
        let root = tempfile::tempdir().unwrap();
        let (stage, _) = interrupted_publication(root.path());
        fs::write(root.path().join("new/first.md"), b"user edit").unwrap();
        install_template_zip(root.path(), "self-media-management", &package(), &archive()).unwrap();
        assert_eq!(
            fs::read(root.path().join("new/first.md")).unwrap(),
            b"user edit"
        );
        assert_eq!(
            fs::read(root.path().join("new/second.md")).unwrap(),
            b"second"
        );
        assert!(installed_template_marker(root.path(), "self-media-management").unwrap());
        assert!(!stage.exists());
    }

    #[test]
    fn recovery_does_not_overwrite_a_replaced_file() {
        let root = tempfile::tempdir().unwrap();
        let (stage, _) = interrupted_publication(root.path());
        let replaced = root.path().join("new/first.md");
        fs::remove_file(&replaced).unwrap();
        fs::write(&replaced, b"replacement").unwrap();
        assert!(
            install_template_zip(root.path(), "self-media-management", &package(), &archive())
                .is_err()
        );
        assert_eq!(fs::read(replaced).unwrap(), b"replacement");
        assert!(!root.path().join("new/second.md").exists());
        assert!(stage.exists());
        assert!(!installed_template_marker(root.path(), "self-media-management").unwrap());
    }

    #[test]
    fn retry_cleans_a_stage_committed_before_interruption() {
        let root = tempfile::tempdir().unwrap();
        let (stage, paths) = interrupted_publication(root.path());
        publish_template_at_root(root.path(), &stage.join("content"), &paths).unwrap();
        assert!(
            install_template_zip(root.path(), "self-media-management", &package(), &archive())
                .is_err()
        );
        assert!(!stage.exists());
        assert!(installed_template_marker(root.path(), "self-media-management").unwrap());
    }

    #[test]
    fn legacy_target_directory_is_ignored_for_root_installation() {
        let root = tempfile::tempdir().unwrap();
        let request: NotebookTemplateArchive = serde_json::from_value(serde_json::json!({
            "url": "https://skills.flowix.cc/templates/archives/work-plan.zip",
            "targetDirectory": "../obsolete-field"
        }))
        .unwrap();
        assert_eq!(
            install_template_zip(root.path(), "work-plan", &package(), &request).unwrap(),
            root.path()
        );
        assert!(root.path().join("README.md").exists());
    }
}
