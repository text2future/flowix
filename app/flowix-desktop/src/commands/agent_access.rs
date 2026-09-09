//! Agent 访问�?�� IPC —读写 `~/.flowix/agent-access.json`�?//!
//! �?`commands::settings` 同形: 写操作成功后 emit `agent-access-changed`
//! 事件, 其它窗口�?React 树收到后从�?盘重�?load�?前�? `set_agent_access`
//! 走乐观更�?(改本地后�?await), 失败�?store �?`loadInitial` 回滚 ──
//! 瑙?`app/flowix-web/lib/store/agent-access-store.ts`銆?
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::events as dispatcher;
use tauri::{AppHandle, State};

use crate::config::{AgentAccessConfig, AgentAccessEntry, AgentAccessKind};

use crate::app::state::AppState;

/// 跨窗口同步事�?── 任一窗口成功写入 agent-access.json �?emit, 其它窗口
/// 收到后从磁盘重新 load�?payload �?`()` (�?payload), 监听者直�?/// `loadInitial()` 拉整�?config ── 比按 entry diff 简单且不会错过任何字�?�?
pub(super) const AGENT_ACCESS_CHANGED_EVENT: &str = "agent-access-changed";

const NOTEBOOK_AGENT_CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookAddDir {
    pub id: String,
    pub path: String,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookAgentConfig {
    pub version: u32,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub add_dirs: Vec<NotebookAddDir>,
}

impl Default for NotebookAgentConfig {
    fn default() -> Self {
        Self {
            version: NOTEBOOK_AGENT_CONFIG_VERSION,
            revision: 0,
            add_dirs: Vec::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn notebook_agent_path(root: &Path) -> PathBuf {
    root.join(".flowix").join("agent.json")
}

fn read_notebook_agent_config(root: &Path) -> Result<Option<NotebookAgentConfig>, String> {
    let flowix = root.join(".flowix");
    if fs::symlink_metadata(&flowix)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Flowix directory is a symbolic link: {}",
            flowix.display()
        ));
    }
    let path = notebook_agent_path(root);
    if fs::symlink_metadata(&path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Notebook agent config is a symbolic link: {}",
            path.display()
        ));
    }
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let config: NotebookAgentConfig = serde_json::from_str(&content)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if config.version != NOTEBOOK_AGENT_CONFIG_VERSION {
        return Err(format!(
            "unsupported notebook agent config version {} in {}",
            config.version,
            path.display()
        ));
    }
    Ok(Some(config))
}

fn validate_notebook_agent_config(
    root: &Path,
    config: &mut NotebookAgentConfig,
) -> Result<(), String> {
    let notebook_canonical = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    for directory in &mut config.add_dirs {
        directory.path = directory
            .path
            .trim()
            .trim_end_matches(['/', '\\'])
            .to_string();
        if directory.path.is_empty()
            || !Path::new(&directory.path).is_absolute()
            || !Path::new(&directory.path).is_dir()
        {
            return Err(format!("add-dir is unavailable: {}", directory.path));
        }
        let canonical = fs::canonicalize(&directory.path).map_err(|error| error.to_string())?;
        if canonical == notebook_canonical {
            return Err("the notebook itself cannot be an add-dir".to_string());
        }
        if notebook_canonical.starts_with(&canonical) {
            return Err(format!(
                "an ancestor of the notebook cannot be an add-dir: {}",
                directory.path
            ));
        }
        let key = canonical.to_string_lossy().to_lowercase();
        if !seen.insert(key) {
            return Err(format!("duplicate add-dir: {}", directory.path));
        }
        if directory.id.trim().is_empty() {
            directory.id = format!("dir_{}", nanoid::nanoid!(8));
        }
        if directory.label.trim().is_empty() {
            directory.label = Path::new(&directory.path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&directory.path)
                .to_string();
        }
    }
    Ok(())
}

fn check_notebook_revision(expected: u64, current: u64) -> Result<(), String> {
    if expected != current {
        return Err(format!(
            "notebook agent config conflict: expected revision {expected}, found {current}"
        ));
    }
    Ok(())
}

fn write_notebook_agent_config(root: &Path, config: &NotebookAgentConfig) -> Result<(), String> {
    let flowix = root.join(".flowix");
    if fs::symlink_metadata(&flowix)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Flowix directory is a symbolic link: {}",
            flowix.display()
        ));
    }
    fs::create_dir_all(&flowix).map_err(|error| format!("create {}: {error}", flowix.display()))?;
    let path = notebook_agent_path(root);
    if fs::symlink_metadata(&path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Notebook agent config is a symbolic link: {}",
            path.display()
        ));
    }
    let temporary = flowix.join("agent.json.tmp");
    if fs::symlink_metadata(&temporary)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Notebook agent temporary file is a symbolic link: {}",
            temporary.display()
        ));
    }
    let content = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("open {}: {error}", temporary.display()))?;
        file.write_all(&content)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("write {}: {error}", temporary.display()))?;
    }
    fs::rename(&temporary, &path).map_err(|error| format!("replace {}: {error}", path.display()))
}

fn legacy_add_dirs(config: &AgentAccessConfig, notebook_id: &str) -> Vec<NotebookAddDir> {
    let Some(defaults) = config.defaults.as_ref() else {
        return Vec::new();
    };
    let Some(files) = defaults.get("files") else {
        return Vec::new();
    };
    let selected = if files.get("folders").is_some() {
        files
    } else {
        files
            .get(notebook_id)
            .or_else(|| files.get("_global"))
            .unwrap_or(&serde_json::Value::Null)
    };
    selected
        .get("folders")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .enumerate()
        .map(|(index, path)| NotebookAddDir {
            id: format!("legacy_{}", index + 1),
            path: path.trim_end_matches(['/', '\\']).to_string(),
            label: Path::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(path)
                .to_string(),
            enabled: true,
        })
        .collect()
}

fn load_or_migrate_notebook_agent_config(
    root: &Path,
    notebook_id: &str,
    legacy: &AgentAccessConfig,
) -> Result<NotebookAgentConfig, String> {
    if let Some(config) = read_notebook_agent_config(root)? {
        return Ok(config);
    }
    let mut config = NotebookAgentConfig {
        version: NOTEBOOK_AGENT_CONFIG_VERSION,
        revision: 1,
        add_dirs: legacy_add_dirs(legacy, notebook_id),
    };
    // Legacy defaults were user-editable JSON and may contain stale or unsafe
    // paths.  Migrate only entries that pass the same validation as new writes;
    // never widen access merely because an old file listed a directory.
    let mut safe_dirs = Vec::with_capacity(config.add_dirs.len());
    for directory in config.add_dirs.drain(..) {
        let mut candidate = NotebookAgentConfig {
            version: config.version,
            revision: config.revision,
            add_dirs: vec![directory],
        };
        if validate_notebook_agent_config(root, &mut candidate).is_ok() {
            safe_dirs.extend(candidate.add_dirs);
        }
    }
    config.add_dirs = safe_dirs;
    write_notebook_agent_config(root, &config)?;
    Ok(config)
}

fn remove_legacy_file_defaults(config: &mut AgentAccessConfig) -> bool {
    let removed = config
        .defaults
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|defaults| defaults.remove("files"))
        .is_some();
    if removed
        && config
            .defaults
            .as_ref()
            .and_then(serde_json::Value::as_object)
            .is_some_and(|defaults| defaults.is_empty())
    {
        config.defaults = None;
    }
    removed
}

#[tauri::command]
pub fn get_notebook_agent_configs(
    state: State<AppState>,
    app: AppHandle,
) -> Result<HashMap<String, NotebookAgentConfig>, String> {
    let notebooks = state
        .memo_file
        .read()
        .map_err(|_| "memo file lock poisoned".to_string())?
        .read_notebook_configs()
        .map_err(|error| error.to_string())?;
    let legacy = state.agent_access.get_config();
    let mut result = HashMap::new();
    let mut all_notebooks_migrated = true;
    for notebook in notebooks {
        let root = PathBuf::from(&notebook.path);
        if !root.is_dir() {
            all_notebooks_migrated = false;
            continue;
        }
        let config = load_or_migrate_notebook_agent_config(&root, &notebook.id, &legacy)?;
        result.insert(notebook.id, config);
    }
    // Once every registered, existing notebook has a local config, remove the
    // obsolete global files defaults. Runtime defaults remain untouched. This
    // is deliberately skipped when a notebook path is unavailable so a
    // partially migrated installation keeps its rollback source.
    if all_notebooks_migrated && !result.is_empty() {
        let mut cleaned = legacy.clone();
        let removed = remove_legacy_file_defaults(&mut cleaned);
        if removed {
            state
                .agent_access
                .replace_config(cleaned)
                .map_err(|error| format!("remove legacy file defaults: {error}"))?;
            dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn set_notebook_agent_config(
    notebook_id: String,
    expected_revision: u64,
    mut config: NotebookAgentConfig,
    state: State<AppState>,
    app: AppHandle,
) -> Result<NotebookAgentConfig, String> {
    let notebook = state
        .memo_file
        .read()
        .map_err(|_| "memo file lock poisoned".to_string())?
        .get_notebook_config_by_id(&notebook_id)
        .ok_or_else(|| format!("notebook not found: {notebook_id}"))?;
    let root = PathBuf::from(notebook.path);
    let current = read_notebook_agent_config(&root)?.unwrap_or_default();
    check_notebook_revision(expected_revision, current.revision)?;
    config.version = NOTEBOOK_AGENT_CONFIG_VERSION;
    config.revision = current.revision.saturating_add(1);
    validate_notebook_agent_config(&root, &mut config)?;
    write_notebook_agent_config(&root, &config)?;
    dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    Ok(config)
}

/// 拉取当前 agent_access 整份 config�?每�?都从 store �? `missing` 字�?
/// �?`get_config` 内重新算, 失联�?��会立刻拿到最�?disk 状态�?
#[tauri::command]
pub fn get_agent_access(state: State<AppState>) -> AgentAccessConfig {
    state.agent_access.get_config()
}

/// 用整份新 config 覆盖 (前�?走乐观更�? 整份 set 避免一�?IPC 一份的
/// 复杂协�?)�?先落�? �?emit, 成功才更新内�?(�?user_config �?set
/// �?��完全对齐)�?
#[tauri::command]
pub fn set_agent_access(
    config: AgentAccessConfig,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .agent_access
        .replace_config(config)
        .map(|_| {
            dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
            Ok(())
        })
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_agent_access_folder_from_picker(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<AgentAccessEntry>, String> {
    let picked = crate::commands::dialog::select_directory(app.clone()).await;
    let Some(path) = picked else {
        return Ok(None);
    };
    let trimmed = path.trim_end_matches(|c| c == '/' || c == '\\').to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut config = state.agent_access.get_config();
    if let Some(existing) = reusable_tracked_folder(&config, &trimmed)? {
        // Folder entries form a global metadata/bookmark pool while
        // notebook `.flowix/agent.json` owns per-notebook attachments.
        // Returning the existing folder lets a removed folder be attached
        // again and lets multiple notebooks reference the same directory.
        return Ok(Some(existing));
    }

    let now = chrono::Utc::now().timestamp_millis();
    let name = Path::new(&trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&trimmed)
        .to_string();
    let entry = AgentAccessEntry {
        id: format!("fld_{}", nanoid::nanoid!(6)),
        kind: AgentAccessKind::Folder,
        path: trimmed,
        name,
        enabled: true,
        workspace: false,
        added_at: now,
        updated_at: now,
        missing: false,
    };
    config.entries.push(entry.clone());
    state
        .agent_access
        .replace_config(config)
        .map_err(|e| format!("agent access persist failed: {e}"))?;
    dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    Ok(Some(entry))
}

#[cfg(test)]
mod notebook_agent_tests {
    use super::*;

    fn legacy_with_folder(path: &str) -> AgentAccessConfig {
        AgentAccessConfig {
            version: 1,
            entries: Vec::new(),
            defaults: Some(serde_json::json!({
                "files": { "folders": [path] }
            })),
        }
    }

    #[test]
    fn migrates_legacy_defaults_into_notebook_config() {
        let temp = tempfile::tempdir().unwrap();
        let notebook = temp.path().join("notebook");
        let add_dir = temp.path().join("资料");
        fs::create_dir_all(&notebook).unwrap();
        fs::create_dir_all(&add_dir).unwrap();
        let config = load_or_migrate_notebook_agent_config(
            &notebook,
            "nb-1",
            &legacy_with_folder(add_dir.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(config.revision, 1);
        assert_eq!(config.add_dirs.len(), 1);
        assert_eq!(config.add_dirs[0].path, add_dir.to_string_lossy());
        assert!(notebook.join(".flowix/agent.json").is_file());
    }

    #[test]
    fn migration_skips_unsafe_legacy_paths() {
        let temp = tempfile::tempdir().unwrap();
        let notebook = temp.path().join("notebook");
        let safe = temp.path().join("资料");
        fs::create_dir_all(&notebook).unwrap();
        fs::create_dir_all(&safe).unwrap();
        let legacy = AgentAccessConfig {
            version: 1,
            entries: Vec::new(),
            defaults: Some(serde_json::json!({
                "files": { "folders": [notebook, safe] }
            })),
        };
        let config = load_or_migrate_notebook_agent_config(&notebook, "nb-1", &legacy).unwrap();
        assert_eq!(config.add_dirs.len(), 1);
        assert_eq!(config.add_dirs[0].path, safe.to_string_lossy());
    }

    #[test]
    fn removes_only_legacy_file_defaults_and_keeps_runtime_defaults() {
        let mut config = AgentAccessConfig {
            version: 1,
            entries: Vec::new(),
            defaults: Some(serde_json::json!({
                "files": { "folders": ["/old"] },
                "runtime": { "codex": { "model": { "key": "gpt" } } }
            })),
        };
        assert!(remove_legacy_file_defaults(&mut config));
        let defaults = config.defaults.unwrap();
        assert!(defaults.get("files").is_none());
        assert!(defaults.get("runtime").is_some());
    }

    #[test]
    fn rejects_notebook_and_ancestor_add_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let notebook = temp.path().join("root/notebook");
        fs::create_dir_all(&notebook).unwrap();
        for path in [&notebook, notebook.parent().unwrap()] {
            let mut config = NotebookAgentConfig::default();
            config.add_dirs.push(NotebookAddDir {
                id: "x".into(),
                path: path.to_string_lossy().into_owned(),
                label: String::new(),
                enabled: true,
            });
            let error = validate_notebook_agent_config(&notebook, &mut config).unwrap_err();
            assert!(error.contains("cannot be an add-dir"));
        }
    }

    #[test]
    fn rejects_duplicate_add_dirs_and_revision_is_detected_before_write() {
        let temp = tempfile::tempdir().unwrap();
        let notebook = temp.path().join("notebook");
        let add_dir = temp.path().join("资料");
        fs::create_dir_all(&notebook).unwrap();
        fs::create_dir_all(&add_dir).unwrap();
        let mut config = NotebookAgentConfig::default();
        config.add_dirs = vec![
            NotebookAddDir {
                id: "a".into(),
                path: add_dir.to_string_lossy().into_owned(),
                label: String::new(),
                enabled: true,
            },
            NotebookAddDir {
                id: "b".into(),
                path: add_dir.to_string_lossy().into_owned(),
                label: String::new(),
                enabled: true,
            },
        ];
        assert!(validate_notebook_agent_config(&notebook, &mut config)
            .unwrap_err()
            .contains("duplicate add-dir"));
        let persisted = NotebookAgentConfig {
            revision: 3,
            ..Default::default()
        };
        write_notebook_agent_config(&notebook, &persisted).unwrap();
        let current = read_notebook_agent_config(&notebook).unwrap().unwrap();
        let error = check_notebook_revision(2, current.revision).unwrap_err();
        assert!(error.contains("conflict"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_flowix_directory() {
        let temp = tempfile::tempdir().unwrap();
        let notebook = temp.path().join("notebook");
        let target = temp.path().join("target");
        fs::create_dir_all(&notebook).unwrap();
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, notebook.join(".flowix")).unwrap();
        let error =
            write_notebook_agent_config(&notebook, &NotebookAgentConfig::default()).unwrap_err();
        assert!(error.contains("symbolic link"));
    }
}

fn reusable_tracked_folder(
    config: &AgentAccessConfig,
    path: &str,
) -> Result<Option<AgentAccessEntry>, String> {
    let comparable = path
        .trim_end_matches(|c| c == '/' || c == '\\')
        .to_ascii_lowercase();
    let Some(existing) = config.entries.iter().find(|entry| {
        entry
            .path
            .trim_end_matches(|c| c == '/' || c == '\\')
            .to_ascii_lowercase()
            == comparable
    }) else {
        return Ok(None);
    };
    if existing.kind == AgentAccessKind::Folder {
        Ok(Some(existing.clone()))
    } else {
        Err("path already tracked as notebook".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: AgentAccessKind, path: &str) -> AgentAccessEntry {
        AgentAccessEntry {
            id: "entry".to_string(),
            kind,
            path: path.to_string(),
            name: "Entry".to_string(),
            enabled: true,
            workspace: false,
            added_at: 1,
            updated_at: 1,
            missing: false,
        }
    }

    #[test]
    fn existing_folder_is_reusable_across_notebooks_and_after_removal() {
        let config = AgentAccessConfig {
            version: 1,
            entries: vec![entry(AgentAccessKind::Folder, "/tmp/reference")],
            defaults: None,
        };

        let reused = reusable_tracked_folder(&config, "/tmp/reference/")
            .unwrap()
            .expect("folder should be reused");

        assert_eq!(reused.path, "/tmp/reference");
    }

    #[test]
    fn notebook_path_is_not_reused_as_folder_metadata() {
        let config = AgentAccessConfig {
            version: 1,
            entries: vec![entry(AgentAccessKind::Notebook, "/tmp/notebook")],
            defaults: None,
        };

        assert!(reusable_tracked_folder(&config, "/tmp/notebook").is_err());
    }
}
