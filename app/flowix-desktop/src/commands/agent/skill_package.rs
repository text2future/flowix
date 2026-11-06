//! Skill ZIP validation and transactional installation, shared with release checks.
use base64::Engine as _;
use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillResourceFile {
    path: String,
    content: String,
    encoding: String,
}

#[derive(Default, serde::Deserialize)]
pub struct ProjectSkillArchive {
    pub url: String,
    #[serde(default)]
    pub source: Option<SkillPackageSource>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackageSource {
    pub repository: String,
    pub directory: String,
    #[serde(default)]
    pub revision: Option<String>,
}

pub(super) fn install_project_skill_zip(
    root: &Path,
    name: &str,
    bytes: &[u8],
    archive: &ProjectSkillArchive,
) -> Result<PathBuf, String> {
    validate_skill_archive_request(name, archive)?;
    let (markdown, resources) = decode_skill_zip(name, bytes)?;
    let frontmatter = parse_skill_frontmatter(&markdown)?;
    let version = frontmatter
        .get(serde_yaml::Value::String("version".into()))
        .and_then(|value| match value {
            serde_yaml::Value::String(text) => Some(text.clone()),
            serde_yaml::Value::Number(value) => Some(value.to_string()),
            _ => None,
        });
    let metadata = serde_json::json!({
        "formatVersion": 1,
        "skillId": name,
        "archiveUrl": archive.url,
        "source": archive.source,
        "skillVersion": version,
        "installedAt": chrono::Utc::now().to_rfc3339(),
    });
    write_project_skill_bundle_recorded(root, name, &markdown, &resources, Some(&metadata))
}

pub(super) fn validate_skill_archive_request(
    name: &str,
    archive: &ProjectSkillArchive,
) -> Result<url::Url, String> {
    if name.is_empty()
        || name.len() > 64
        || name.split('-').any(|part| {
            part.is_empty()
                || !part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
    {
        return Err("Skill ZIP manifest is invalid".to_string());
    }
    let url = url::Url::parse(&archive.url).map_err(|_| "Skill ZIP URL is invalid".to_string())?;
    if !crate::commands::market_package::is_market_archive_origin(&url)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != format!("/skills/archives/{name}.zip")
    {
        return Err("Skill ZIP must come from the Flowix Skill Market".to_string());
    }
    if let Some(source) = &archive.source {
        let parts = source.repository.split('/').collect::<Vec<_>>();
        if parts.len() != 2
            || parts.iter().any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            })
            || source.repository.len() > 200
            || (!source.directory.is_empty()
                && validate_skill_resource_path(&source.directory).is_err())
            || source.revision.as_ref().is_some_and(|revision| {
                !matches!(revision.len(), 40 | 64)
                    || !revision.bytes().all(|c| c.is_ascii_hexdigit())
            })
        {
            return Err("Skill source metadata is invalid".to_string());
        }
    }
    Ok(url)
}

pub(super) struct DecodedSkillResource {
    path: PathBuf,
    bytes: Vec<u8>,
    executable: bool,
}

pub(super) fn decode_skill_zip(
    name: &str,
    bytes: &[u8],
) -> Result<(String, Vec<DecodedSkillResource>), String> {
    if bytes.is_empty() || bytes.len() > MAX_SKILL_PACKAGE_BYTES {
        return Err("Skill ZIP exceeds the allowed download size".into());
    }
    let mut archive = zip::ZipArchive::new(io::Cursor::new(bytes))
        .map_err(|error| format!("invalid Skill ZIP: {error}"))?;
    if archive.len() > MAX_SKILL_RESOURCE_FILES + 1 {
        return Err("Skill ZIP contains too many entries".to_string());
    }
    let mut markdown = None;
    let mut resources = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut total_bytes = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to read Skill ZIP entry: {error}"))?;
        let filename = entry.name().to_string();
        let mode = entry.unix_mode().unwrap_or(0);
        let kind = mode & 0o170000;
        if kind != 0 && kind != 0o100000 && kind != 0o040000 {
            return Err("Skill ZIP must not contain symbolic links or special files".to_string());
        }
        let is_directory = entry.is_dir();
        let normalized = if is_directory {
            filename.trim_end_matches('/')
        } else {
            &filename
        };
        let is_entry = filename == "SKILL.md";
        let path = if is_entry {
            PathBuf::from("SKILL.md")
        } else {
            validate_skill_resource_path(normalized)?
        };
        if !seen.insert(normalized.to_lowercase()) {
            return Err("Skill ZIP contains duplicate file paths".to_string());
        }
        if is_directory {
            if entry.size() != 0 {
                return Err("Skill ZIP directory contains file data".to_string());
            }
            continue;
        }
        if kind == 0o040000 {
            return Err("Skill ZIP contains an invalid directory entry".to_string());
        }
        let limit = if is_entry {
            MAX_SKILL_MARKDOWN_BYTES
        } else {
            MAX_SKILL_RESOURCE_FILE_BYTES
        };
        if entry.size() > limit as u64 {
            return Err("Skill ZIP contains a file that is too large".to_string());
        }
        let mut content = Vec::new();
        entry
            .by_ref()
            .take(limit as u64 + 1)
            .read_to_end(&mut content)
            .map_err(|error| format!("failed to decompress Skill ZIP entry: {error}"))?;
        if content.len() > limit || content.len() as u64 != entry.size() {
            return Err("Skill ZIP entry exceeds its allowed size".to_string());
        }
        if is_entry {
            let content = String::from_utf8(content)
                .map_err(|_| "Skill ZIP entry file must be UTF-8".to_string())?;
            validate_source_skill_markdown(name, &content)?;
            markdown = Some(content);
        } else {
            total_bytes = total_bytes.saturating_add(content.len());
            if total_bytes > MAX_SKILL_PACKAGE_BYTES {
                return Err("Skill ZIP expands beyond the allowed size".to_string());
            }
            resources.push(DecodedSkillResource {
                path,
                bytes: content,
                executable: mode & 0o111 != 0,
            });
        }
    }
    let markdown = markdown.ok_or_else(|| "Skill ZIP is missing SKILL.md".to_string())?;
    Ok((markdown, resources))
}

const MAX_SKILL_RESOURCE_FILES: usize = 500;
const MAX_SKILL_RESOURCE_FILE_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_SKILL_PACKAGE_BYTES: usize = 24 * 1024 * 1024;
const MAX_SKILL_MARKDOWN_BYTES: usize = 1_000_000;

fn parse_skill_frontmatter(markdown: &str) -> Result<serde_yaml::Mapping, String> {
    if markdown.len() > MAX_SKILL_MARKDOWN_BYTES {
        return Err("Skill package entry file is invalid or too large".to_string());
    }
    super::skill_frontmatter::parse(markdown).map(|(header, _)| header)
}

pub(super) fn validate_source_skill_markdown(name: &str, markdown: &str) -> Result<(), String> {
    let header = parse_skill_frontmatter(markdown)?;
    if header
        .get(serde_yaml::Value::String("name".into()))
        .and_then(serde_yaml::Value::as_str)
        != Some(name)
    {
        return Err("Skill package entry file name does not match the requested skill".to_string());
    }
    Ok(())
}

fn validate_skill_resource_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 512 || value.starts_with('/') || value.contains('\\') {
        return Err("Skill package contains an invalid file path".to_string());
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.len() > 20
        || segments.iter().any(|segment| {
            segment.is_empty()
                || *segment == "."
                || *segment == ".."
                || segment.ends_with('.')
                || segment.ends_with(' ')
                || segment.chars().any(|character| {
                    character.is_control()
                        || matches!(character, ':' | '*' | '?' | '\"' | '<' | '>' | '|')
                })
        })
        || value.eq_ignore_ascii_case("SKILL.md")
        || segments
            .first()
            .is_some_and(|part| part.eq_ignore_ascii_case(".flowix-install.json"))
    {
        return Err("Skill package contains an invalid file path".to_string());
    }
    Ok(segments.iter().collect())
}

pub(super) fn decode_skill_resources(
    files: Vec<ProjectSkillResourceFile>,
) -> Result<Vec<DecodedSkillResource>, String> {
    if files.len() > MAX_SKILL_RESOURCE_FILES {
        return Err("Skill package contains too many files".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let mut total_bytes = 0usize;
    let mut output = Vec::with_capacity(files.len());
    for file in files {
        let path = validate_skill_resource_path(&file.path)?;
        let key = file.path.to_lowercase();
        if !seen.insert(key) {
            return Err("Skill package contains duplicate file paths".to_string());
        }
        let bytes = match file.encoding.as_str() {
            "utf8" => file.content.into_bytes(),
            "base64" => base64::engine::general_purpose::STANDARD
                .decode(file.content.as_bytes())
                .map_err(|_| "Skill package contains invalid base64 data".to_string())?,
            _ => return Err("Skill package contains an unsupported file encoding".to_string()),
        };
        if bytes.len() > MAX_SKILL_RESOURCE_FILE_BYTES {
            return Err("Skill package contains a file that is too large".to_string());
        }
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > MAX_SKILL_PACKAGE_BYTES {
            return Err("Skill package is too large".to_string());
        }
        output.push(DecodedSkillResource {
            path,
            bytes,
            executable: false,
        });
    }
    Ok(output)
}

// Check before directory creation as well as afterward. Match the notebook skill
// reader, which also rejects symlink directories instead of following them.
fn validate_skill_folder(root: &Path, folder: &Path) -> Result<(), String> {
    if !crate::config::path_is_inside(folder, root) {
        return Err("project Skill folder resolves outside the notebook".to_string());
    }
    for path in [
        root.join(".agents"),
        root.join(".agents/skills"),
        folder.to_path_buf(),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("project Skill directory must not be a symbolic link".to_string());
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err("project Skill directory is not a directory".to_string());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to inspect project Skill folder: {error}")),
        }
    }
    Ok(())
}

fn write_project_skill(root: &Path, name: &str, content: &str) -> Result<PathBuf, String> {
    write_project_skill_bundle(root, name, content, &[])
}

pub(super) fn write_project_skill_bundle(
    root: &Path,
    name: &str,
    content: &str,
    resources: &[DecodedSkillResource],
) -> Result<PathBuf, String> {
    write_project_skill_bundle_recorded(root, name, content, resources, None)
}

fn ensure_skill_directory(root: &Path, path: &Path) -> Result<(), String> {
    if !crate::config::path_is_inside(path, root) {
        return Err("Skill directory resolves outside the notebook".to_string());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(
                "Skill directory must be a regular directory, not a symbolic link".to_string(),
            )
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect Skill directory: {error}")),
    }
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("failed to create Skill directory: {error}")),
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || !crate::config::path_is_inside(path, root)
    {
        return Err("Skill directory must be a regular directory inside the notebook".to_string());
    }
    Ok(())
}

fn write_project_skill_bundle_recorded(
    root: &Path,
    name: &str,
    content: &str,
    resources: &[DecodedSkillResource],
    metadata: Option<&serde_json::Value>,
) -> Result<PathBuf, String> {
    let folder = root.join(".agents/skills").join(name);
    validate_skill_folder(root, &folder)?;
    let work = root.join(".flowix/skill-installs");
    for directory in [
        root.join(".agents"),
        root.join(".agents/skills"),
        root.join(".flowix"),
        work.clone(),
    ] {
        ensure_skill_directory(root, &directory)?;
    }
    let lock_path = work.join(format!("{name}.lock"));
    if let Ok(metadata) = fs::symlink_metadata(&lock_path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Skill installation lock must be a regular file".to_string());
        }
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| format!("failed to open Skill installation lock: {e}"))?;
    // Keep the lock file in place: removing it would let waiters lock different inodes.
    lock.lock_exclusive()
        .map_err(|e| format!("failed to lock Skill installation: {e}"))?;
    validate_skill_folder(root, &folder)?;
    match fs::symlink_metadata(&folder) {
        Ok(_) => {
            let entry = folder.join("SKILL.md");
            return match fs::symlink_metadata(&entry) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    Err("project Skill path is not a regular file".to_string())
                }
                _ => Err("a project Skill with this name already exists".to_string()),
            };
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect Skill destination: {error}")),
    }
    // Isolate every skill, including IDs such as "example-stage-child".
    let skill_work = work.join(name);
    ensure_skill_directory(root, &skill_work)?;
    let prefix = "stage-";
    // A prior process may have exited without running TempDir's destructor.
    // Same-skill writers hold this lock, so no live stage can be removed here.
    for entry in fs::read_dir(&skill_work).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with(prefix) {
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() || !kind.is_dir() {
                return Err("abandoned Skill stage must be a regular directory".to_string());
            }
            fs::remove_dir_all(entry.path())
                .map_err(|e| format!("failed to clean abandoned Skill stage: {e}"))?;
        }
    }
    let staging = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(&skill_work)
        .map_err(|e| format!("failed to stage Skill installation: {e}"))?;
    let mut created_directories = Vec::new();
    for resource in resources {
        let destination = create_skill_resource_parent(
            root,
            staging.path(),
            &resource.path,
            &mut created_directories,
        )?;
        create_skill_file(&destination, |file| {
            file.write_all(&resource.bytes)?;
            #[cfg(unix)]
            if resource.executable {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o755))?;
            }
            Ok(())
        })?;
    }
    if let Some(metadata) = metadata {
        let bytes = serde_json::to_vec_pretty(metadata).map_err(|e| e.to_string())?;
        create_skill_file(&staging.path().join(".flowix-install.json"), |file| {
            file.write_all(&bytes)
        })?;
    }
    create_skill_file(&staging.path().join("SKILL.md"), |file| {
        file.write_all(content.as_bytes())
    })?;
    // The stage lives on the same filesystem, outside the discovery directory.
    // The complete tree becomes visible with this one directory rename.
    fs::rename(staging.path(), &folder)
        .map_err(|e| format!("failed to publish Skill installation: {e}"))?;
    Ok(folder.join("SKILL.md"))
}

fn create_skill_resource_parent(
    root: &Path,
    folder: &Path,
    relative_path: &Path,
    created_directories: &mut Vec<PathBuf>,
) -> Result<PathBuf, String> {
    let mut destination = folder.to_path_buf();
    let components = relative_path.components().collect::<Vec<_>>();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        destination.push(component.as_os_str());
        if !crate::config::path_is_inside(&destination, root) {
            return Err("Skill package file resolves outside the notebook".to_string());
        }
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Skill package directory must not be a symbolic link".to_string());
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err("Skill package path is not a directory".to_string());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&destination).map_err(|error| {
                    format!("failed to create Skill package directory: {error}")
                })?;
                created_directories.push(destination.clone());
            }
            Err(error) => {
                return Err(format!(
                    "failed to inspect Skill package directory: {error}"
                ));
            }
        }
    }
    destination.push(
        components
            .last()
            .ok_or_else(|| "Skill package contains an invalid file path".to_string())?
            .as_os_str(),
    );
    if !crate::config::path_is_inside(&destination, root) {
        return Err("Skill package file resolves outside the notebook".to_string());
    }
    Ok(destination)
}

// The writer callback keeps partial-write failure handling testable without
// depending on disk-full conditions. It does not change the installation format.
fn create_skill_file(
    path: &Path,
    write_content: impl FnOnce(&mut File) -> io::Result<()>,
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                match fs::symlink_metadata(path) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        "project Skill file must not be a symbolic link".to_string()
                    }
                    Ok(metadata) if metadata.is_file() => {
                        "a project Skill with this name already exists".to_string()
                    }
                    _ => "project Skill path is not a regular file".to_string(),
                }
            } else {
                format!("failed to create project Skill: {error}")
            }
        })?;
    let result = write_content(&mut file).and_then(|_| file.sync_all());
    // Windows requires the handle to be closed before cleanup.
    drop(file);
    if let Err(error) = result {
        return match fs::remove_file(path) {
            Ok(()) => Err(format!("failed to write project Skill: {error}")),
            Err(cleanup) => Err(format!("failed to write project Skill: {error}; failed to remove incomplete file: {cleanup}")),
        };
    }
    Ok(())
}

#[cfg(test)]
mod skill_install_tests {
    use super::*;

    const ZIP_MARKDOWN: &[u8] = b"---\nname: example\ndescription: Example\n---\n\nInstructions\n";

    #[test]
    fn interrupted_stage_is_invisible_and_retry_publishes_complete_tree() {
        let root = tempfile::tempdir().unwrap();
        let abandoned = root
            .path()
            .join(".flowix/skill-installs/example/stage-crashed");
        fs::create_dir_all(&abandoned).unwrap();
        fs::write(abandoned.join("SKILL.md"), b"partial").unwrap();
        assert!(!root.path().join(".agents/skills/example").exists());
        let bytes = make_zip(&[
            ("SKILL.md", ZIP_MARKDOWN),
            ("references/guide.md", b"complete"),
        ]);
        let archive = ProjectSkillArchive {
            url: "https://skills.flowix.cc/skills/archives/example.zip".into(),
            source: None,
        };
        let entry = install_project_skill_zip(root.path(), "example", &bytes, &archive).unwrap();
        assert!(!abandoned.exists());
        assert_eq!(
            fs::read(entry.parent().unwrap().join("references/guide.md")).unwrap(),
            b"complete"
        );
        assert_eq!(fs::read(entry).unwrap(), ZIP_MARKDOWN);
    }

    #[test]
    fn retry_never_cleans_another_skills_staging_namespace() {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join(".flowix/skill-installs");
        let other_stage = work.join("example-stage-child/stage-active");
        fs::create_dir_all(&other_stage).unwrap();
        fs::write(other_stage.join("resource"), b"other installation").unwrap();
        fs::write(work.join("example-stage-child.lock"), b"other lock").unwrap();
        write_project_skill(root.path(), "example", "complete").unwrap();
        assert_eq!(
            fs::read(other_stage.join("resource")).unwrap(),
            b"other installation"
        );
        assert_eq!(
            fs::read(work.join("example-stage-child.lock")).unwrap(),
            b"other lock"
        );
    }

    #[test]
    fn stage_write_failure_does_not_publish_and_allows_retry() {
        let root = tempfile::tempdir().unwrap();
        let resources = vec![
            DecodedSkillResource {
                path: "conflict".into(),
                bytes: b"file".to_vec(),
                executable: false,
            },
            DecodedSkillResource {
                path: "conflict/child".into(),
                bytes: b"child".to_vec(),
                executable: false,
            },
        ];
        assert!(write_project_skill_bundle(root.path(), "example", "entry", &resources).is_err());
        assert!(!root.path().join(".agents/skills/example").exists());
        assert!(
            fs::read_dir(root.path().join(".flowix/skill-installs/example"))
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("stage-"))
        );
        assert!(write_project_skill(root.path(), "example", "retry").is_ok());
    }

    #[test]
    fn crlf_yaml_and_source_record_are_preserved_without_version_pinning() {
        let root = tempfile::tempdir().unwrap();
        let markdown = b"---\r\nname: 'example' # quoted\r\nversion: 2.1.0\r\ndescription: >-\r\n  Multi line\r\n  description\r\n---\r\n\r\nInstructions";
        let bytes = make_zip(&[("SKILL.md", markdown)]);
        let archive = ProjectSkillArchive {
            url: "https://skills.flowix.cc/skills/archives/example.zip".into(),
            source: Some(SkillPackageSource {
                repository: "owner/repo".into(),
                directory: "skills/example".into(),
                revision: Some("0".repeat(40)),
            }),
        };
        let entry = install_project_skill_zip(root.path(), "example", &bytes, &archive).unwrap();
        assert_eq!(fs::read(&entry).unwrap(), markdown);
        let record: serde_json::Value = serde_json::from_slice(
            &fs::read(entry.parent().unwrap().join(".flowix-install.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(record["source"]["revision"], "0".repeat(40));
        assert_eq!(record["skillVersion"], "2.1.0");
        assert!(
            chrono::DateTime::parse_from_rfc3339(record["installedAt"].as_str().unwrap()).is_ok()
        );
    }

    #[test]
    fn archive_cannot_replace_installation_record() {
        for path in [
            ".flowix-install.json",
            ".FLOWIX-INSTALL.JSON",
            ".flowix-install.json/child",
        ] {
            assert!(decode_skill_zip(
                "example",
                &make_zip(&[("SKILL.md", ZIP_MARKDOWN), (path, b"spoof")])
            )
            .is_err());
        }
    }

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        for (path, bytes) in entries {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(0o755);
            writer.start_file(*path, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn installs_zip_with_nested_documents_binary_assets_and_executable_scripts() {
        let bytes = make_zip(&[
            ("SKILL.md", ZIP_MARKDOWN),
            ("references/guide.md", b"reference content"),
            ("assets/image.bin", &[0, 255, 128, 10]),
            ("scripts/run.sh", b"#!/bin/sh\necho hello\n"),
        ]);
        let (markdown, resources) = decode_skill_zip("example", &bytes).unwrap();
        let root = tempfile::tempdir().unwrap();
        let path =
            write_project_skill_bundle(root.path(), "example", &markdown, &resources).unwrap();
        let folder = path.parent().unwrap();
        assert_eq!(fs::read(&path).unwrap(), ZIP_MARKDOWN);
        assert_eq!(
            fs::read(folder.join("references/guide.md")).unwrap(),
            b"reference content"
        );
        assert_eq!(
            fs::read(folder.join("assets/image.bin")).unwrap(),
            [0, 255, 128, 10]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(folder.join("scripts/run.sh"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
    }

    #[test]
    fn rejects_zip_traversal_absolute_paths_and_case_collisions() {
        for path in [
            "../outside",
            "/absolute",
            "scripts/../../outside",
            "scripts\\outside",
            "scripts/bad.",
        ] {
            let bytes = make_zip(&[("SKILL.md", ZIP_MARKDOWN), (path, b"unsafe")]);
            assert!(
                decode_skill_zip("example", &bytes).is_err(),
                "accepted {path}"
            );
        }
        let bytes = make_zip(&[
            ("SKILL.md", ZIP_MARKDOWN),
            ("notes.md", b"one"),
            ("NOTES.md", b"two"),
        ]);
        assert!(decode_skill_zip("example", &bytes).is_err());
    }

    #[test]
    fn rejects_zip_symlinks_missing_entry_and_wrong_skill_name() {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        writer
            .add_symlink(
                "reference",
                "../../outside",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(decode_skill_zip("example", &bytes)
            .err()
            .unwrap()
            .contains("symbolic links"));
        assert!(decode_skill_zip("example", &make_zip(&[("notes.md", b"no entry")])).is_err());
        assert!(decode_skill_zip("different", &make_zip(&[("SKILL.md", ZIP_MARKDOWN)])).is_err());
        assert!(decode_skill_zip("example", b"not a zip").is_err());
    }

    #[test]
    fn rejects_zip_file_count_and_decompression_size_limits() {
        let large = vec![0; MAX_SKILL_RESOURCE_FILE_BYTES + 1];
        let bytes = make_zip(&[("SKILL.md", ZIP_MARKDOWN), ("large.bin", &large)]);
        assert!(decode_skill_zip("example", &bytes).is_err());
        let content = vec![0; 7 * 1024 * 1024];
        let bytes = make_zip(&[
            ("SKILL.md", ZIP_MARKDOWN),
            ("a", &content),
            ("b", &content),
            ("c", &content),
            ("d", &content),
        ]);
        assert!(decode_skill_zip("example", &bytes)
            .err()
            .unwrap()
            .contains("expands"));
        let names: Vec<_> = (0..MAX_SKILL_RESOURCE_FILES + 1)
            .map(|i| format!("file-{i}"))
            .collect();
        let mut entries = vec![("SKILL.md", ZIP_MARKDOWN)];
        entries.extend(names.iter().map(|name| (name.as_str(), &b""[..])));
        assert!(decode_skill_zip("example", &make_zip(&entries)).is_err());
    }

    #[test]
    fn zip_install_failure_removes_only_files_created_by_that_attempt() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join(".agents/skills/example");
        fs::create_dir_all(folder.join("references")).unwrap();
        fs::write(folder.join("references/existing.md"), b"keep").unwrap();
        let bytes = make_zip(&[
            ("SKILL.md", ZIP_MARKDOWN),
            ("scripts/new.sh", b"new"),
            ("references/existing.md", b"replace"),
        ]);
        let (markdown, resources) = decode_skill_zip("example", &bytes).unwrap();
        assert!(write_project_skill_bundle(root.path(), "example", &markdown, &resources).is_err());
        assert!(!folder.join("SKILL.md").exists());
        assert!(!folder.join("scripts").exists());
        assert_eq!(
            fs::read(folder.join("references/existing.md")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn official_website_skill_archive_is_accepted() {
        let mut request = ProjectSkillArchive {
            url: "https://flowix.cc/skills/archives/example.zip".into(), source: None,
        };
        assert!(validate_skill_archive_request("example", &request).is_ok());
        request.url = "https://flowix.cc.evil.test/skills/archives/example.zip".into();
        assert!(validate_skill_archive_request("example", &request).is_err());
    }

    #[test]
    fn archive_url_is_stable_and_restricted_to_the_market() {
        let request = ProjectSkillArchive {
            url: "https://skills.flowix.cc/skills/archives/example.zip".to_string(),
            source: None,
        };
        assert!(validate_skill_archive_request("example", &request).is_ok());
        for url in [
            "http://skills.flowix.cc/skills/archives/example.zip",
            "https://evil.example/skills/archives/example.zip",
            "https://skills.flowix.cc/skills/archives/different.zip",
            "https://skills.flowix.cc/skills/archives/example.zip?old=true",
            "https://user@skills.flowix.cc/skills/archives/example.zip",
            "https://skills.flowix.cc:8443/skills/archives/example.zip",
        ] {
            assert!(validate_skill_archive_request(
                "example",
                &ProjectSkillArchive {
                    url: url.to_string(),
                    source: None,
                }
            )
            .is_err());
        }
        assert!(validate_skill_archive_request("../example", &request).is_err());
    }

    #[test]
    fn creates_skill_and_preserves_existing_contents_on_retry() {
        let root = tempfile::tempdir().unwrap();
        let path = write_project_skill(root.path(), "example", "original").unwrap();
        let error = write_project_skill(root.path(), "example", "replacement").unwrap_err();
        assert!(error.contains("already exists"));
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
    }

    #[test]
    fn removes_incomplete_file_and_allows_retry() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("SKILL.md");
        let error = create_skill_file(&path, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::other("simulated write failure"))
        })
        .unwrap_err();
        assert!(error.contains("simulated write failure"));
        assert!(!path.exists());
        create_skill_file(&path, |file| file.write_all(b"complete")).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "complete");
    }

    #[test]
    fn directory_at_skill_file_path_is_not_reported_as_installed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".agents/skills/example/SKILL.md");
        fs::create_dir_all(&path).unwrap();
        let error = write_project_skill(root.path(), "example", "content").unwrap_err();
        assert!(!error.contains("already exists"));
        assert!(path.is_dir());
    }

    #[test]
    fn concurrent_installations_create_exactly_one_file() {
        let root = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|content| {
                let root = root.path().to_path_buf();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    write_project_skill(&root, "example", content).map(|_| content)
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let winner = results
            .iter()
            .find_map(|result| result.as_ref().ok())
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join(".agents/skills/example/SKILL.md")).unwrap(),
            *winner
        );
    }

    #[test]
    fn concurrent_failed_write_reports_conflict_and_allows_later_retry() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("SKILL.md");
        let writer_path = path.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            create_skill_file(&writer_path, |file| {
                file.write_all(b"partial")?;
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Err(io::Error::other("simulated write failure"))
            })
        });
        started_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let conflict = create_skill_file(&path, |file| file.write_all(b"second")).unwrap_err();
        finish_tx.send(()).unwrap();
        assert!(writer.join().unwrap().is_err());
        assert!(conflict.contains("already exists"));
        assert!(!path.exists());
        create_skill_file(&path, |file| file.write_all(b"complete")).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "complete");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_directory_before_creating_outside_notebook() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join(".agents")).unwrap();
        assert!(write_project_skill(root.path(), "example", "content").is_err());
        assert!(!outside.path().join("skills").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_file_symlink_without_creating_its_target() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let folder = root.path().join(".agents/skills/example");
        fs::create_dir_all(&folder).unwrap();
        let target = outside.path().join("unexpected.md");
        std::os::unix::fs::symlink(&target, folder.join("SKILL.md")).unwrap();
        let error = write_project_skill(root.path(), "example", "content").unwrap_err();
        assert!(!error.contains("already exists"));
        assert!(!target.exists());
        assert!(fs::symlink_metadata(folder.join("SKILL.md"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_directory_even_when_target_is_inside_notebook() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("shared-agents");
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, root.path().join(".agents")).unwrap();
        assert!(write_project_skill(root.path(), "example", "content").is_err());
        assert!(!target.join("skills").exists());
    }
}
