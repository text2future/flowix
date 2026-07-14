use std::path::{Path, PathBuf};
use std::sync::RwLock;

use flowix_core::memo_file::{MemoFile, NotebookConfig};
use serde::{Deserialize, Serialize};

use crate::config::user::{atomic_write_json, UserConfigError};

pub const AGENT_ACCESS_FILE_NAME: &str = "agent-access.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentAccessKind {
    Notebook,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessEntry {
    pub id: String,
    pub kind: AgentAccessKind,
    pub path: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub workspace: bool,
    pub added_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_deserializing)]
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessConfig {
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<AgentAccessEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<serde_json::Value>,
}

impl Default for AgentAccessConfig {
    fn default() -> Self {
        Self {
            version: 1,
            entries: Vec::new(),
            defaults: None,
        }
    }
}

pub struct AgentAccessStore {
    config_dir: PathBuf,
    inner: RwLock<AgentAccessConfig>,
}

impl AgentAccessStore {
    pub fn new(config_dir: PathBuf, memo_file: &MemoFile) -> Self {
        let mut config: AgentAccessConfig = read_from_disk(&config_dir)
            .ok()
            .flatten()
            .unwrap_or_default();

        match config.version {
            1 => {}
            other => tracing::warn!(
                "agent-access.json version {} is unknown, treating as v1",
                other
            ),
        }

        let notebook_configs = memo_file.read_notebook_configs().unwrap_or_default();
        let pre_reconcile_entries = config.entries.clone();
        reconcile_with_notebook_configs(&mut config.entries, &notebook_configs);
        let is_dirty = !entries_semantically_equal(&pre_reconcile_entries, &config.entries);

        let store = Self {
            config_dir,
            inner: RwLock::new(config),
        };
        if is_dirty {
            if let Err(e) = store.persist() {
                tracing::warn!("failed to persist agent_access on startup: {e}");
            } else {
                tracing::debug!(
                    "agent_access reconciled on startup; entries count changed: {} -> {}",
                    pre_reconcile_entries.len(),
                    store.get_config().entries.len(),
                );
            }
        }
        store
    }

    pub fn get_config(&self) -> AgentAccessConfig {
        let guard = self.inner.read().unwrap_or_else(|p| p.into_inner());
        guard.clone()
    }

    pub fn replace_config(
        &self,
        config: AgentAccessConfig,
    ) -> Result<AgentAccessConfig, UserConfigError> {
        let content = serde_json::to_string_pretty(&config)?;
        let path = self.config_dir.join(AGENT_ACCESS_FILE_NAME);
        atomic_write_json(&path, &content)?;
        let mut guard = self.inner.write().unwrap_or_else(|p| p.into_inner());
        *guard = config.clone();
        Ok(config)
    }

    pub fn add_or_update_notebook(&self, nb: &NotebookConfig) -> bool {
        let now = chrono::Utc::now().timestamp_millis();
        let trimmed_path = trim_path(&nb.path);
        let mut guard = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let mut changed = false;

        match guard
            .entries
            .iter_mut()
            .find(|e| e.kind == AgentAccessKind::Notebook && e.id == nb.id)
        {
            Some(entry) => {
                if entry.path != trimmed_path || entry.name != nb.name {
                    entry.path = trimmed_path;
                    entry.name = nb.name.clone();
                    entry.updated_at = now;
                    changed = true;
                }
            }
            None => {
                guard.entries.push(AgentAccessEntry {
                    id: nb.id.clone(),
                    kind: AgentAccessKind::Notebook,
                    path: trimmed_path,
                    name: nb.name.clone(),
                    enabled: true,
                    workspace: false,
                    added_at: now,
                    updated_at: now,
                    missing: false,
                });
                changed = true;
            }
        }

        if changed {
            let _ = self.persist_locked(&guard);
        }
        changed
    }

    pub fn remove_notebook(&self, notebook_id: &str) -> bool {
        let mut guard = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let before = guard.entries.len();
        guard
            .entries
            .retain(|e| !(e.kind == AgentAccessKind::Notebook && e.id == notebook_id));
        let removed = guard.entries.len() != before;
        if removed {
            let _ = self.persist_locked(&guard);
        }
        removed
    }

    pub fn ensure_skill_folder(&self, path: &Path) {
        const SKILLS_FOLDER_ID: &str = "fld_skills_auto";
        const DISPLAY_NAME: &str = "Skills (auto)";

        let path_str = trim_path(&path.to_string_lossy());
        let mut guard = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let now = chrono::Utc::now().timestamp_millis();
        let mut dirty = false;

        match guard.entries.iter_mut().find(|e| e.id == SKILLS_FOLDER_ID) {
            Some(entry) => {
                if entry.path != path_str {
                    entry.path = path_str;
                    entry.updated_at = now;
                    dirty = true;
                }
                if entry.name != DISPLAY_NAME {
                    entry.name = DISPLAY_NAME.to_string();
                    entry.updated_at = now;
                    dirty = true;
                }
            }
            None => {
                guard.entries.push(AgentAccessEntry {
                    id: SKILLS_FOLDER_ID.to_string(),
                    kind: AgentAccessKind::Folder,
                    path: path_str,
                    name: DISPLAY_NAME.to_string(),
                    enabled: true,
                    workspace: false,
                    added_at: now,
                    updated_at: now,
                    missing: false,
                });
                dirty = true;
            }
        }

        if dirty {
            let _ = self.persist_locked(&guard);
        }
    }

    fn persist(&self) -> Result<(), UserConfigError> {
        let guard = self.inner.read().unwrap_or_else(|p| p.into_inner());
        self.persist_locked(&guard)
    }

    fn persist_locked(&self, config: &AgentAccessConfig) -> Result<(), UserConfigError> {
        let content = serde_json::to_string_pretty(config)?;
        let path = self.config_dir.join(AGENT_ACCESS_FILE_NAME);
        Ok(atomic_write_json(&path, &content)?)
    }
}

fn read_from_disk(config_dir: &Path) -> std::io::Result<Option<AgentAccessConfig>> {
    let path = config_dir.join(AGENT_ACCESS_FILE_NAME);
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    let cfg: AgentAccessConfig = serde_json::from_str(&content).unwrap_or_default();
    Ok(Some(cfg))
}

fn reconcile_with_notebook_configs(
    entries: &mut Vec<AgentAccessEntry>,
    notebooks: &[NotebookConfig],
) {
    let now = chrono::Utc::now().timestamp_millis();
    let registry_ids: std::collections::HashSet<&str> =
        notebooks.iter().map(|n| n.id.as_str()).collect();

    entries.retain(|e| {
        !(e.kind == AgentAccessKind::Notebook && !registry_ids.contains(e.id.as_str()))
    });

    for nb in notebooks {
        let trimmed_path = trim_path(&nb.path);
        match entries
            .iter_mut()
            .find(|e| e.kind == AgentAccessKind::Notebook && e.id == nb.id)
        {
            Some(entry) => {
                if entry.path != trimmed_path {
                    entry.path = trimmed_path.clone();
                    entry.updated_at = now;
                }
                if entry.name != nb.name {
                    entry.name = nb.name.clone();
                    entry.updated_at = now;
                }
            }
            None => {
                entries.push(AgentAccessEntry {
                    id: nb.id.clone(),
                    kind: AgentAccessKind::Notebook,
                    path: trimmed_path,
                    name: nb.name.clone(),
                    enabled: true,
                    workspace: false,
                    added_at: now,
                    updated_at: now,
                    missing: false,
                });
            }
        }
    }
}

fn entries_semantically_equal(a: &[AgentAccessEntry], b: &[AgentAccessEntry]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).all(|(x, y)| {
        x.id == y.id
            && x.kind == y.kind
            && x.path == y.path
            && x.name == y.name
            && x.enabled == y.enabled
    })
}

fn trim_path(path: &str) -> String {
    path.trim_end_matches(|c| c == '/' || c == '\\').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nb(id: &str, name: &str, path: &str) -> NotebookConfig {
        NotebookConfig {
            id: id.to_string(),
            name: name.to_string(),
            icon: Some("📘".to_string()),
            path: path.to_string(),
            is_default: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn entry(
        id: &str,
        kind: AgentAccessKind,
        path: &str,
        name: &str,
        enabled: bool,
        updated_at: i64,
    ) -> AgentAccessEntry {
        AgentAccessEntry {
            id: id.to_string(),
            kind,
            path: path.to_string(),
            name: name.to_string(),
            enabled,
            workspace: false,
            added_at: 1,
            updated_at,
            missing: false,
        }
    }

    #[test]
    fn seed_populates_from_notebook_configs() {
        let mut entries = Vec::new();
        let notebooks = vec![
            nb("nb_1", "First", "/tmp/a/"),
            nb("nb_2", "Second", "/tmp/b/"),
        ];

        reconcile_with_notebook_configs(&mut entries, &notebooks);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "/tmp/a");
        assert!(entries.iter().all(|entry| entry.enabled));
    }

    #[test]
    fn reconcile_removes_deleted_notebooks() {
        let mut entries = vec![
            entry("nb_1", AgentAccessKind::Notebook, "/a", "A", true, 1),
            entry("nb_2", AgentAccessKind::Notebook, "/b", "B", true, 1),
            entry("fld_1", AgentAccessKind::Folder, "/c", "C", true, 1),
        ];
        let notebooks = vec![nb("nb_1", "A", "/a")];

        reconcile_with_notebook_configs(&mut entries, &notebooks);

        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry.id == "nb_1"));
        assert!(entries.iter().any(|entry| entry.id == "fld_1"));
    }

    #[test]
    fn entries_semantically_equal_ignores_updated_at_and_workspace() {
        let a = vec![entry(
            "nb_1",
            AgentAccessKind::Notebook,
            "/a",
            "A",
            true,
            100,
        )];
        let mut b = a.clone();
        b[0].updated_at = 200;
        b[0].workspace = true;

        assert!(entries_semantically_equal(&a, &b));
    }

    #[test]
    fn entries_semantically_equal_detects_path_and_enabled_changes() {
        let a = vec![entry(
            "nb_1",
            AgentAccessKind::Notebook,
            "/old",
            "A",
            true,
            100,
        )];
        let mut b = a.clone();
        b[0].path = "/new".to_string();
        assert!(!entries_semantically_equal(&a, &b));

        let mut c = a.clone();
        c[0].enabled = false;
        assert!(!entries_semantically_equal(&a, &c));
    }

    #[test]
    fn config_defaults_round_trip_shape() {
        let defaults = serde_json::json!({
            "runtime": { "flowix": { "model": "gpt-5" } },
            "files": { "workspacePaths": ["/tmp"] }
        });
        let cfg = AgentAccessConfig {
            version: 1,
            entries: Vec::new(),
            defaults: Some(defaults.clone()),
        };

        let encoded = serde_json::to_string(&cfg).unwrap();
        let decoded: AgentAccessConfig = serde_json::from_str(&encoded).unwrap();

        assert_eq!(decoded.defaults, Some(defaults));
    }
}
