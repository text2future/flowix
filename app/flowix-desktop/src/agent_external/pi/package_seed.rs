//! Seeds the Pi packages vendored into the desktop bundle (see
//! `scripts/prepare-pi-bundle.mjs`) into Flowix's Pi agent directory.
//!
//! `PI_CODING_AGENT_DIR` points at `<config>/Flowix/pi`, so a vendored
//! package only reaches the runtime after its files are copied there. The
//! seed is best-effort and versioned by a digest of the vendored tree:
//! failures are logged and never block a Pi launch, because Pi without the
//! vendored packages is still fully functional.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

/// User-owned agent-directory entries the seed never touches, even if a
/// future vendored layout contains them.
const NEVER_SEED: &[&str] = &[
    "settings.json",
    "auth.json",
    "models-store.json",
    "mcp.json",
    "trust.json",
    "sessions",
];

fn last_seeded() -> &'static Mutex<bool> {
    static LAST_SEEDED: OnceLock<Mutex<bool>> = OnceLock::new();
    LAST_SEEDED.get_or_init(|| Mutex::new(false))
}

/// Copies the bundled `pi-agent` tree into the user Pi agent directory and
/// merges its package declarations into `settings.json`. Skipped once the
/// on-disk marker matches the bundled digest; errors are logged, never fatal.
pub(super) fn seed_bundled_packages(app: &tauri::AppHandle) {
    if let Err(error) = seed(app) {
        crate::runtime_log::record_event("error", "pi.packages.seed_failed", &error);
    }
}

fn seed(app: &tauri::AppHandle) -> Result<(), String> {
    // The bundled tree is immutable while the process runs, so one digest
    // computation per process is enough.
    if *last_seeded().lock().map_err(|error| error.to_string())? {
        return Ok(());
    }
    let Some(bundled) = super::runtime::resolve_pi_agent_dir(app) else {
        return Ok(());
    };
    let digest = hash_tree(&bundled)?;
    let config_dir = super::runtime::pi_config_dir()?;
    std::fs::create_dir_all(&config_dir)
        .map_err(|error| format!("cannot create Pi config directory: {error}"))?;
    let marker_path = config_dir.join("packages-seed.json");
    if super::config::read_json(&marker_path)?
        .get("digest")
        .and_then(Value::as_str)
        == Some(digest.as_str())
    {
        *last_seeded().lock().map_err(|error| error.to_string())? = true;
        return Ok(());
    }
    copy_vendored_tree(&bundled, &config_dir)?;
    merge_vendored_packages(
        &bundled.join("settings.json"),
        &config_dir.join("settings.json"),
    )?;
    super::config::write_json(&marker_path, &json!({ "digest": digest }))?;
    *last_seeded().lock().map_err(|error| error.to_string())? = true;
    Ok(())
}

fn hash_tree(root: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for entry in WalkDir::new(root)
        .min_depth(1)
        .sort_by_file_name()
        .into_iter()
    {
        let entry = entry.map_err(|error| format!("cannot read bundled Pi packages: {error}"))?;
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|error| format!("invalid bundled Pi package path: {error}"))?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        if entry.file_type().is_dir() {
            hasher.update(b"dir");
        } else {
            // Files and symlinks alike are hashed by their content; the copy
            // below dereferences symlinks the same way.
            let contents = std::fs::read(entry.path()).map_err(|error| {
                format!("cannot read {}: {error}", entry.path().display())
            })?;
            hasher.update(b"file");
            hasher.update((contents.len() as u64).to_le_bytes());
            hasher.update(&contents);
        }
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn copy_vendored_tree(bundled: &Path, config_dir: &Path) -> Result<(), String> {
    for entry in WalkDir::new(bundled)
        .min_depth(1)
        .sort_by_file_name()
        .into_iter()
    {
        let entry = entry.map_err(|error| format!("cannot read bundled Pi packages: {error}"))?;
        let relative = entry
            .path()
            .strip_prefix(bundled)
            .map_err(|error| format!("invalid bundled Pi package path: {error}"))?;
        if let Some(top) = relative.components().next() {
            let name = top.as_os_str().to_string_lossy().into_owned();
            if NEVER_SEED.contains(&name.as_str()) {
                continue;
            }
        }
        let target = config_dir.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target).map_err(|error| {
                format!("cannot seed Pi package directory {}: {error}", target.display())
            })?;
        } else {
            // fs::copy dereferences symlinks, so vendored links (e.g.
            // node_modules/.bin shims) land as real files.
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    format!("cannot seed Pi package directory {}: {error}", parent.display())
                })?;
            }
            std::fs::copy(entry.path(), &target).map_err(|error| {
                format!("cannot seed Pi package file {}: {error}", target.display())
            })?;
        }
    }
    Ok(())
}

/// Merges the vendored `packages` declarations into the user's
/// `settings.json` without touching any other user setting. A fresh agent
/// directory adopts the vendored file wholesale.
fn merge_vendored_packages(
    bundled_settings: &Path,
    config_settings: &Path,
) -> Result<(), String> {
    let bundled = super::config::read_json(bundled_settings)?;
    let Some(packages) = bundled.get("packages").and_then(Value::as_array).cloned() else {
        return Ok(());
    };
    if packages.is_empty() {
        return Ok(());
    }
    if !config_settings.exists() {
        super::config::write_json(config_settings, &bundled)?;
        return Ok(());
    }
    let mut settings = super::config::read_json(config_settings)?;
    if !settings.is_object() {
        return Err(format!(
            "Pi settings {} is not a JSON object",
            config_settings.display()
        ));
    }
    let existing = settings
        .get("packages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut merged = existing.clone();
    for package in packages {
        if !merged.contains(&package) {
            merged.push(package);
        }
    }
    if merged != existing {
        settings["packages"] = Value::Array(merged);
        super::config::write_json(config_settings, &settings)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{copy_vendored_tree, hash_tree, merge_vendored_packages};
    use serde_json::json;
    use std::fs;

    fn write_file(path: &std::path::Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn copies_vendored_tree_but_skips_user_state() {
        let base = std::env::temp_dir().join(format!("flowix-pi-seed-{}", std::process::id()));
        let bundled = base.join("bundled");
        let config = base.join("config");
        let _ = fs::remove_dir_all(&base);
        write_file(&bundled.join("settings.json"), "{}");
        write_file(&bundled.join("npm/package.json"), "{}");
        write_file(&bundled.join("npm/node_modules/pi-subagents/index.js"), "export {}");
        write_file(&bundled.join("auth.json"), "secret");
        copy_vendored_tree(&bundled, &config).unwrap();
        assert!(config.join("npm/node_modules/pi-subagents/index.js").is_file());
        // settings.json is user state: excluded from the tree copy and
        // merged separately by merge_vendored_packages.
        assert!(!config.join("settings.json").exists());
        assert!(!config.join("auth.json").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn merges_packages_without_touching_other_settings() {
        let base = std::env::temp_dir().join(format!("flowix-pi-seed-merge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let bundled = base.join("bundled-settings.json");
        let config = base.join("settings.json");
        fs::write(&bundled, r#"{"packages":["npm:pi-subagents@0.79.2"]}"#).unwrap();
        fs::write(&config, r#"{"defaultProvider":"anthropic"}"#).unwrap();
        merge_vendored_packages(&bundled, &config).unwrap();
        let merged: serde_json::Value = serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(merged["defaultProvider"], json!("anthropic"));
        assert_eq!(merged["packages"], json!(["npm:pi-subagents@0.79.2"]));
        // Idempotent: a second merge must not duplicate entries.
        merge_vendored_packages(&bundled, &config).unwrap();
        let merged: serde_json::Value = serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(merged["packages"], json!(["npm:pi-subagents@0.79.2"]));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn fresh_config_adopts_vendored_settings() {
        let base =
            std::env::temp_dir().join(format!("flowix-pi-seed-fresh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let bundled = base.join("bundled-settings.json");
        let config = base.join("settings.json");
        fs::write(&bundled, r#"{"packages":["npm:pi-subagents@0.79.2"]}"#).unwrap();
        merge_vendored_packages(&bundled, &config).unwrap();
        let merged: serde_json::Value = serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(merged["packages"], json!(["npm:pi-subagents@0.79.2"]));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn digest_changes_when_the_bundled_tree_changes() {
        let base = std::env::temp_dir().join(format!("flowix-pi-seed-hash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let bundled = base.join("bundled");
        write_file(&bundled.join("npm/node_modules/pi-subagents/index.js"), "a");
        let before = hash_tree(&bundled).unwrap();
        write_file(&bundled.join("npm/node_modules/pi-subagents/index.js"), "b");
        let after = hash_tree(&bundled).unwrap();
        assert_ne!(before, after);
        let _ = fs::remove_dir_all(&base);
    }
}
