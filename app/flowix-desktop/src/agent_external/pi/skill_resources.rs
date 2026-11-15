use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};
use walkdir::WalkDir;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PiStartupResources {
    pub skill_directories: Vec<PathBuf>,
    pub fingerprint: String,
}

static NEXT_STAGE_ID: AtomicU64 = AtomicU64::new(0);

fn hash_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn hash_config_file(hasher: &mut Sha256, label: &str, path: &Path) -> Result<(), String> {
    hash_part(hasher, label.as_bytes());
    hash_part(hasher, path.to_string_lossy().as_bytes());
    match std::fs::read(path) {
        Ok(contents) => {
            hash_part(hasher, b"present");
            hash_part(hasher, &contents);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            hash_part(hasher, b"missing");
        }
        Err(error) => {
            return Err(format!(
                "cannot read Pi startup config {}: {error}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn hash_skill_tree(
    hasher: &mut Sha256,
    label: &str,
    path: &Path,
    optional: bool,
) -> Result<(), String> {
    hash_part(hasher, label.as_bytes());
    hash_part(hasher, path.to_string_lossy().as_bytes());
    if !path.exists() {
        if !optional {
            return Err(format!(
                "Pi skills directory is missing: {}",
                path.display()
            ));
        }
        hash_part(hasher, b"missing");
        return Ok(());
    }
    if !path.is_dir() {
        return Err(format!(
            "Pi skills path is not a directory: {}",
            path.display()
        ));
    }
    hash_part(hasher, b"present");
    for entry in WalkDir::new(path)
        .follow_links(true)
        .sort_by_file_name()
        .into_iter()
    {
        let entry = entry.map_err(|error| format!("cannot read Pi skills directory: {error}"))?;
        if entry.path() == path {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(path)
            .unwrap_or(entry.path())
            .to_string_lossy();
        hash_part(hasher, relative.as_bytes());
        let metadata = entry
            .metadata()
            .map_err(|error| format!("cannot inspect Pi skill resource: {error}"))?;
        if metadata.is_file() {
            hash_part(hasher, b"file");
            let contents = std::fs::read(entry.path()).map_err(|error| {
                format!(
                    "cannot read Pi skill file {}: {error}",
                    entry.path().display()
                )
            })?;
            hash_part(hasher, &contents);
        } else {
            hash_part(hasher, b"directory");
        }
    }
    Ok(())
}

fn compatible_skill_contents(contents: &[u8], command_name: &str) -> Result<Vec<u8>, String> {
    let source = std::str::from_utf8(contents)
        .map_err(|error| format!("notebook Pi Skill is not valid UTF-8: {error}"))?;
    flowix_core::skill_frontmatter::render_with_name(source, command_name)
}

fn stage_skill(
    source_directory: &Path,
    source_path: &Path,
    command_name: &str,
    compatible_contents: &[u8],
    session_directory: &Path,
) -> Result<PathBuf, String> {
    let mut key = Sha256::new();
    hash_skill_tree(&mut key, "source-tree", source_directory, false)?;
    hash_part(&mut key, source_directory.to_string_lossy().as_bytes());
    hash_part(&mut key, command_name.as_bytes());
    hash_part(&mut key, compatible_contents);
    let key = key
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let cache = session_directory.join("flowix-skill-cache");
    let destination = cache.join(&key).join(command_name);
    if std::fs::read(destination.join("SKILL.md")).ok().as_deref() == Some(compatible_contents) {
        return Ok(destination);
    }
    std::fs::create_dir_all(&cache)
        .map_err(|error| format!("cannot create Pi skill cache: {error}"))?;
    let stage_id = NEXT_STAGE_ID.fetch_add(1, Ordering::Relaxed);
    let staging = cache.join(format!(".stage-{}-{stage_id}", std::process::id()));
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("cannot create Pi skill staging directory: {error}"))?;
    let result = (|| {
        for entry in WalkDir::new(source_directory)
            .follow_links(true)
            .sort_by_file_name()
            .min_depth(1)
        {
            let entry =
                entry.map_err(|error| format!("cannot copy Pi Skill resources: {error}"))?;
            let relative = entry
                .path()
                .strip_prefix(source_directory)
                .map_err(|error| format!("invalid Pi Skill resource path: {error}"))?;
            let target = staging.join(relative);
            let metadata = entry
                .metadata()
                .map_err(|error| format!("cannot inspect Pi Skill resource: {error}"))?;
            if metadata.is_dir() {
                std::fs::create_dir_all(&target)
                    .map_err(|error| format!("cannot copy Pi Skill directory: {error}"))?;
            } else if metadata.is_file() {
                if entry.path() == source_path {
                    continue;
                }
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|error| format!("cannot copy Pi Skill resource: {error}"))?;
                }
                std::fs::copy(entry.path(), &target)
                    .map_err(|error| format!("cannot copy Pi Skill resource: {error}"))?;
            }
        }
        std::fs::write(staging.join("SKILL.md"), compatible_contents)
            .map_err(|error| format!("cannot write normalized Pi Skill: {error}"))?;
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create Pi skill cache: {error}"))?;
        }
        match std::fs::rename(&staging, &destination) {
            Ok(()) => Ok(()),
            Err(error)
                if std::fs::read(destination.join("SKILL.md")).ok().as_deref()
                    == Some(compatible_contents) =>
            {
                std::fs::remove_dir_all(&staging).map_err(|cleanup| {
                    format!("cannot remove duplicate Pi skill staging directory: {cleanup}")
                })?;
                let _ = error;
                Ok(())
            }
            Err(error) => Err(format!("cannot publish normalized Pi Skill: {error}")),
        }
    })();
    if result.is_err() && staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result?;
    Ok(destination)
}

pub(super) fn capture(
    cwd: &Path,
    config_directory: &Path,
    session_directory: &Path,
) -> Result<PiStartupResources, String> {
    let skills = flowix_core::notebook_agents::enabled_notebook_skills(cwd)?;
    let mut hasher = Sha256::new();
    let mut skill_directories = Vec::with_capacity(skills.len());
    for skill in skills {
        hash_part(&mut hasher, b"notebook-skill");
        hash_part(&mut hasher, skill.path.to_string_lossy().as_bytes());
        hash_part(&mut hasher, skill.command_name.as_bytes());
        hash_skill_tree(&mut hasher, "notebook-skill-files", &skill.directory, false)?;
        let directory = if skill.declared_name.as_deref() == Some(skill.command_name.as_str()) {
            skill.directory
        } else {
            let compatible = compatible_skill_contents(&skill.contents, &skill.command_name)?;
            hash_part(&mut hasher, &compatible);
            stage_skill(
                &skill.directory,
                &skill.path,
                &skill.command_name,
                &compatible,
                session_directory,
            )?
        };
        skill_directories.push(directory);
    }
    hash_skill_tree(
        &mut hasher,
        "user-skills",
        &config_directory.join("skills"),
        true,
    )?;
    hash_config_file(&mut hasher, "user-mcp", &config_directory.join("mcp.json"))?;
    // Tracking this file only invalidates the runtime snapshot. It does not
    // grant Pi trust to the project or load an otherwise untrusted config.
    hash_config_file(
        &mut hasher,
        "project-mcp",
        &cwd.join(".pi").join("mcp.json"),
    )?;
    let fingerprint = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(PiStartupResources {
        skill_directories,
        fingerprint,
    })
}
