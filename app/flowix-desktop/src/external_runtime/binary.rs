use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use crate::config::AgentsConfig;

#[derive(Clone, Default)]
struct CustomAgentLocations {
    enabled_by_type: HashMap<String, bool>,
    locations: HashMap<String, String>,
}

static CUSTOM_AGENT_LOCATIONS: OnceLock<RwLock<CustomAgentLocations>> = OnceLock::new();

fn store() -> &'static RwLock<CustomAgentLocations> {
    CUSTOM_AGENT_LOCATIONS.get_or_init(|| RwLock::new(CustomAgentLocations::default()))
}

pub fn configure_custom_agent_locations(config: &AgentsConfig) {
    let next = CustomAgentLocations {
        enabled_by_type: config.custom_location_enabled_by_type.clone(),
        locations: config.custom_locations.clone(),
    };
    *store()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
}

pub fn custom_location_enabled(agent_type: &str) -> bool {
    store()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .enabled_by_type
        .get(agent_type)
        .copied()
        .unwrap_or(false)
}

pub fn custom_agent_binary(agent_type: &str, binary_name: &str) -> Option<PathBuf> {
    let config = store()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if !config
        .enabled_by_type
        .get(agent_type)
        .copied()
        .unwrap_or(false)
    {
        return None;
    }

    let configured = config.locations.get(agent_type)?.trim();
    if configured.is_empty() {
        return Some(PathBuf::new());
    }
    Some(resolve_configured_path(Path::new(configured), binary_name))
}

fn resolve_configured_path(configured: &Path, binary_name: &str) -> PathBuf {
    if !configured.is_dir() {
        return configured.to_path_buf();
    }

    #[cfg(windows)]
    let file_names = [
        format!("{binary_name}.exe"),
        format!("{binary_name}.cmd"),
        format!("{binary_name}.bat"),
        binary_name.to_string(),
    ];
    #[cfg(not(windows))]
    let file_names = [binary_name.to_string()];

    for file_name in &file_names {
        let candidate = configured.join(file_name);
        if candidate.is_file() {
            return candidate;
        }
    }
    configured.join(&file_names[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_file_location_is_returned_verbatim() {
        let path = std::env::temp_dir().join("flowix-custom-codex");
        assert_eq!(resolve_configured_path(&path, "codex"), path);
    }

    #[test]
    fn configured_directory_resolves_expected_binary_name() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let resolved = resolve_configured_path(dir.path(), "codex");

        #[cfg(windows)]
        assert_eq!(resolved, dir.path().join("codex.exe"));
        #[cfg(not(windows))]
        assert_eq!(resolved, dir.path().join("codex"));
    }
}
