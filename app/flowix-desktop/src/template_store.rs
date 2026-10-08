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
        if !is_legacy_builtin_notebook_template_index(&index_path)? {
            migrate_builtin_scenario_ids_and_cover_urls(&index_path)?;
            return Ok(());
        }

        // Replace the previous built-in collection on upgrade. A custom
        // template index is left alone, while the shipped eight-template
        // index is migrated to the new scenario collection.
        for directory in [
            "工作管理",
            "产品研发",
            "公众号写作",
            "小说创作",
            "自媒体管理",
            "股票基金投资",
            "考研规划",
            "课程设计",
        ] {
            let old_template = target_dir.join(directory);
            if old_template.is_dir() {
                fs::remove_dir_all(&old_template)
                    .map_err(|error| format!("replace legacy notebook template failed: {error}"))?;
            }
        }
        fs::remove_file(&index_path)
            .map_err(|error| format!("replace legacy notebook template index failed: {error}"))?;
    }

    for &(relative, content) in NOTEBOOK_TEMPLATE_ASSETS
        .iter()
        .filter(|(relative, _)| *relative != "index.json")
    {
        let relative_path = Path::new(relative);
        if relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
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

fn is_legacy_builtin_notebook_template_index(index_path: &Path) -> Result<bool, String> {
    const LEGACY_TEMPLATE_IDS: [&str; 8] = [
        "work-management",
        "product-development",
        "wechat-writing",
        "novel-writing",
        "social-media-management",
        "stock-fund-investing",
        "postgraduate-planning",
        "course-design",
    ];

    let content = fs::read_to_string(index_path)
        .map_err(|error| format!("read notebook template index failed: {error}"))?;
    let index: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("parse notebook template index failed: {error}"))?;
    let Some(templates) = index.get("templates").and_then(serde_json::Value::as_array) else {
        return Ok(false);
    };
    if templates.len() != LEGACY_TEMPLATE_IDS.len() {
        return Ok(false);
    }

    let ids = templates
        .iter()
        .filter_map(|template| template.get("id").and_then(serde_json::Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    Ok(ids.len() == LEGACY_TEMPLATE_IDS.len()
        && LEGACY_TEMPLATE_IDS.iter().all(|id| ids.contains(*id)))
}

fn migrate_builtin_scenario_ids_and_cover_urls(index_path: &Path) -> Result<(), String> {
    let content = fs::read_to_string(index_path)
        .map_err(|error| format!("read notebook template index failed: {error}"))?;
    let mut index: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("parse notebook template index failed: {error}"))?;
    let Some(templates) = index
        .get_mut("templates")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return Ok(());
    };
    if templates.len() != 72 {
        return Ok(());
    }

    let expected_ids = (1..=72)
        .map(|number| format!("scene-{number:03}"))
        .collect::<std::collections::HashSet<_>>();
    let current_ids = templates
        .iter()
        .filter_map(|template| {
            template
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect::<std::collections::HashSet<_>>();
    if current_ids != expected_ids {
        return Ok(());
    }

    let bundled_index = NOTEBOOK_TEMPLATE_ASSETS
        .iter()
        .find_map(|(relative, content)| (*relative == "index.json").then_some(*content))
        .ok_or_else(|| "bundled notebook template index is missing".to_string())?;
    let bundled_index: serde_json::Value = serde_json::from_slice(bundled_index)
        .map_err(|error| format!("parse bundled notebook template index failed: {error}"))?;
    let bundled_templates = bundled_index
        .get("templates")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "bundled notebook template list is missing".to_string())?;
    if bundled_templates.len() != 72 {
        return Ok(());
    }

    let bundled_by_directory = bundled_templates
        .iter()
        .filter_map(|template| {
            Some((
                template.get("sourceDirectory")?.as_str()?.to_owned(),
                template.clone(),
            ))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut id_mapping = std::collections::HashMap::new();
    let mut changed = false;
    for template in templates.iter_mut() {
        let Some(source_directory) = template
            .get("sourceDirectory")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Some(bundled) = bundled_by_directory.get(source_directory) else {
            continue;
        };
        let (Some(old_id), Some(new_id)) = (
            template.get("id").and_then(serde_json::Value::as_str),
            bundled.get("id").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        id_mapping.insert(old_id.to_owned(), new_id.to_owned());
        template["id"] = serde_json::Value::String(new_id.to_owned());
        changed = true;
    }

    if id_mapping.len() != 72 {
        return Ok(());
    }

    let bundled_covers = bundled_templates
        .iter()
        .filter_map(|template| {
            Some((
                template.get("id")?.as_str()?.to_owned(),
                template.get("coverUrl")?.as_str()?.to_owned(),
            ))
        })
        .collect::<std::collections::HashMap<_, _>>();

    for template in templates.iter_mut() {
        let Some(id) = template.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if let Some(cover_url) = bundled_covers.get(id) {
            let current_cover_url = template
                .get("coverUrl")
                .and_then(serde_json::Value::as_str);
            let is_legacy_r2_cover = current_cover_url.is_some_and(|url| {
                url.starts_with("https://download.flowix.cc/notebook-template-covers/v1/")
            });
            if current_cover_url.is_none() || is_legacy_r2_cover {
                if current_cover_url != Some(cover_url.as_str()) {
                    template["coverUrl"] = serde_json::Value::String(cover_url.clone());
                    changed = true;
                }
            }
        }
    }

    if let Some(old_default_id) = index
        .get("defaultTemplateId")
        .and_then(serde_json::Value::as_str)
    {
        if let Some(new_default_id) = id_mapping.get(old_default_id) {
            index["defaultTemplateId"] = serde_json::Value::String(new_default_id.clone());
            changed = true;
        }
    }

    if changed {
        let updated = serde_json::to_vec_pretty(&index)
            .map_err(|error| format!("serialize notebook template index failed: {error}"))?;
        fs::write(index_path, updated)
            .map_err(|error| format!("update notebook template cover URLs failed: {error}"))?;
    }
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
