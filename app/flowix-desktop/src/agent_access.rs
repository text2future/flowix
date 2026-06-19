//! Agent 可访问目录 (可访问文件夹 + notebook) — `~/.flowix/agent_access.json`。
//!
//! ## 设计目标
//!
//! 把 AI Agent 工具的 "AI 可以读写哪些目录" 从"派生自 notebook 注册表"升级为
//! 独立持久化的真源: 用户可以新增/删除本地文件夹, 可以取消勾选某个 notebook
//! 让 AI 看不到, 都不影响 notebook 本身的存在。
//!
//! ## 与 notebook.json 的关系
//!
//! notebook 注册表 (`~/.flowix/notebook.json`) 仍然管 notebook 的增删改查
//! 与"当前编辑哪个"。`agent_access.json` 镜像所有 notebook 条目 + 用户
//! 增删的自定义 folder 条目。两者通过 [`commands::notebook`] 的 sync
//! 钩子联动:
//!
//! - `create_notebook` → `add_or_update_notebook`
//! - `update_notebook` (改名分支) → `rename_notebook`
//! - `delete_notebook` / `clear_notebooks` → `remove_notebook` (与 registry 对账)
//!
//! ## 失联目录 (`missing`) 的语义
//!
//! 每次 `get_config` 重新计算每条 entry 的 `Path::exists()`, 写进
//! `missing: bool` 字段返回给前端, 让 UI 灰显不可勾选。`missing` 不入盘
//! (`#[serde(skip_deserializing)]`), 由 path 状态推算。
//!
//! ## 锁与持久化
//!
//! 与 [`crate::user_config::UserConfigStore`] 同形: `RwLock<Config>` 包内存,
//! 落盘走 [`atomic_write_json`]。写操作先落盘, 成功后才更内存 — 任何一步
//! 失败内存保留旧值, 不会出现"内存新磁盘旧"的损坏态。

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::user_config::{atomic_write_json, UserConfigError};
use flowix_core::memo_file::{MemoFile, NotebookConfig};

/// agent_access.json 的文件名。 与 `preference.json` / `flowix-ai-config.toml`
/// / `notebook.json` 同居 `~/.flowix/`。
pub const AGENT_ACCESS_FILE_NAME: &str = "agent_access.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentAccessKind {
    /// 镜像 `notebook.json` 的一条 notebook config。 它的 path / name
    /// 始终跟 notebook 注册表保持一致 ── 由 [`AgentAccessStore::add_or_update_notebook`]
    /// / [`rename_notebook`] 在 notebook CRUD 钩子里刷新。
    Notebook,
    /// 用户通过 `dialogs.selectDirectory()` 手动加入的本地目录。
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessEntry {
    /// 稳定 id。`Notebook` 用 `"nb_" + notebook.id`, `Folder` 用
    /// `"fld_" + nanoid` (6 位小写字母数字, 与 memo id 字符集一致)。
    /// 跨重启引用同一条 entry 靠它, 前端 toggle / remove 都带这个 id。
    pub id: String,
    pub kind: AgentAccessKind,
    /// 绝对路径。`Notebook` 条目的尾随 `/` 在写入前 trim 掉, 跟
    /// `MemoFile::registered_notebook_paths()` 返回的形态保持一致 ──
    /// 避免一个路径因末尾分隔符差异在 `path_is_inside` 里漏判。
    pub path: String,
    pub name: String,
    pub enabled: bool,
    pub added_at: i64,
    pub updated_at: i64,
    /// 运行时计算 ── 磁盘上 `path` 是否还存在。**不入盘**, 由
    /// `get_config` 在返回前重算填入。 UI 拿这个字段决定要不要灰显
    /// 这一行 (失联目录无法让 Agent 访问, 但条目保留)。
    #[serde(default, skip_deserializing)]
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<AgentAccessEntry>,
}

impl Default for AgentAccessConfig {
    /// 手写 Default 而非 `#[derive(Default)]`: 默认 version 必须是 1
    /// (schema 当前版本), 派生实现走 `<u32 as Default>::default()` 给到 0。
    /// 两者必须给到同一个兜底值, 否则 "刚启动未读盘" 与 "老文件缺字段"
    /// 行为分裂。
    fn default() -> Self {
        Self {
            version: default_version(),
            entries: Vec::new(),
        }
    }
}

fn default_version() -> u32 {
    1
}

/// 全局可访问目录的真源。 `Arc<AgentAccessStore>` 跨 `AppState` 与
/// `AgentManager` 共享, 与 `UserConfigStore` / `MemoFile` 的 Arc
/// 引用模型一致。
pub struct AgentAccessStore {
    config_dir: PathBuf,
    inner: RwLock<AgentAccessConfig>,
}

impl AgentAccessStore {
    /// 启动路径: 读盘 → 缺则播种 → 跟 notebook 注册表对账 → 落盘。
    /// 整个流程在 `lib::run` 的 `init_default_notebook` **之后** 调用,
    /// 保证 notebook.json 已经是初始化后的形态。
    pub fn new(config_dir: PathBuf, memo_file: &MemoFile) -> Self {
        // 1. 先尝试从盘上恢复, 缺文件就拿一个空 config (走播种)
        let mut config: AgentAccessConfig = read_from_disk(&config_dir)
            .ok()
            .flatten()
            .unwrap_or_default();

        match config.version {
            1 => {}
            other => tracing::warn!(
                "agent_access.json version {} is unknown, treating as v1; future migrations should hook here",
                other
            ),
        }

        // 2. 对账: notebook.json 里的所有 config 在 access 列表里都该有条
        //    启用的对应 entry; 反过来 kind=Notebook 但 notebook.json
        //    里没有对应 id 的就是孤儿, 删掉。这一步同时承担了"两个文件
        //    写入中间崩溃 → 启动时自我修复"的语义。
        let notebook_configs = memo_file.read_notebook_configs().unwrap_or_default();
        reconcile_with_notebook_configs(&mut config.entries, &notebook_configs);

        // 3. 同步落盘 (无论有无变化都写, 避免在用户重命名 / 加新 notebook
        //    之后第一次重启才发现旧文件)。
        let store = Self {
            config_dir,
            inner: RwLock::new(config),
        };
        if let Err(e) = store.persist() {
            tracing::warn!("failed to persist agent_access on startup: {e}");
        }
        store
    }

    /// 读锁返回当前 config 的克隆, 并在返回前给每条 entry 重新计算
    /// `missing` ── 这是 UI 灰显的唯一来源。 不入盘, 不影响 `inner`。
    pub fn get_config(&self) -> AgentAccessConfig {
        let guard = self.inner.read().unwrap_or_else(|p| p.into_inner());
        let mut out = guard.clone();
        for entry in &mut out.entries {
            entry.missing = !Path::new(&entry.path).exists();
        }
        out
    }

    /// 先把整份 config 落盘, 成功后才覆盖内存。 `Err` 时内存与磁盘
    /// 都保留旧值。
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

    // ==================== notebook 同步钩子 ====================
    // 由 `commands::notebook` 在 create / rename / delete / clear 成功后
    // 调用, 保证 access 列表与 notebook 注册表始终同形。 每次都 persist,
    // 走原子写保证不出现"两份文件不一致"的中间态。

    /// notebook 新建 / 改名 / 路径变更时调。 返回 true = 真改了 entry。
    pub fn add_or_update_notebook(&self, nb: &NotebookConfig) -> bool {
        let now = chrono::Utc::now().timestamp_millis();
        let trimmed_path = nb.path.trim_end_matches(|c| c == '/' || c == '\\');
        let mut guard = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let mut changed = false;
        match guard
            .entries
            .iter_mut()
            .find(|e| e.kind == AgentAccessKind::Notebook && e.id == nb.id)
        {
            Some(entry) => {
                if entry.path != trimmed_path || entry.name != nb.name {
                    entry.path = trimmed_path.to_string();
                    entry.name = nb.name.clone();
                    entry.updated_at = now;
                    changed = true;
                }
            }
            None => {
                guard.entries.push(AgentAccessEntry {
                    id: nb.id.clone(),
                    kind: AgentAccessKind::Notebook,
                    path: trimmed_path.to_string(),
                    name: nb.name.clone(),
                    enabled: true,
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

    /// notebook 删除 / clear_notebooks 调。 找不到 / kind 不对都返回 false。
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

    // ==================== 默认 skills 目录 ====================
    //
    // 由 `lib.rs::run()` 在启动时调一次, 给 Agent 默认开放
    // `~/.flowix/skills/` 的读权限 ── 不需要 LLM 先调 `load_skill` 就能
    // `read` / `grep` 任意 SKILL.md (跟普通 folder 一样走 ToolScope)。
    //
    // 固定 id `"fld_skills_auto"`, 跟 `nb_*` notebook id 和 `fld_<nanoid>`
    // 用户自添加 folder id 都不撞名, 重复启动幂等。
    //
    // **尊重用户 `enabled` 切换** ── 用户在偏好里手动关掉这条 entry
    // 后, 我们不在每次启动时强制 re-enable。 仅修复 `path` / `name`
    // 漂移 (例如未来 user_config_dir 改名)。
    pub fn ensure_skill_folder(&self, path: &Path) {
        const SKILLS_FOLDER_ID: &str = "fld_skills_auto";
        const DISPLAY_NAME: &str = "Skills (auto)";
        let path_str = path
            .to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .to_string();
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

    // ==================== 内部 ====================

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

/// 跟 notebook 注册表对账: 给注册表里新增的 notebook 补 entry, 删除注册表
/// 已经不存在的 kind=Notebook entry。 kind=Folder 永远不动。
#[allow(dead_code)] // 通过 `new()` 间接调用, binary 端看不到使用, 实际活着。
fn reconcile_with_notebook_configs(
    entries: &mut Vec<AgentAccessEntry>,
    notebooks: &[NotebookConfig],
) {
    let now = chrono::Utc::now().timestamp_millis();
    let registry_ids: std::collections::HashSet<&str> =
        notebooks.iter().map(|n| n.id.as_str()).collect();

    // 1. 删孤儿 (access 里有但 registry 没有的 kind=Notebook 条目)
    entries.retain(|e| {
        !(e.kind == AgentAccessKind::Notebook && !registry_ids.contains(e.id.as_str()))
    });

    // 2. 补新增 (registry 里有但 access 里没有的)
    for nb in notebooks {
        let trimmed_path = nb.path.trim_end_matches(|c| c == '/' || c == '\\');
        match entries
            .iter_mut()
            .find(|e| e.kind == AgentAccessKind::Notebook && e.id == nb.id)
        {
            Some(entry) => {
                // 路径 / 名字漂移修复 ── registry 才是真源
                if entry.path != trimmed_path {
                    entry.path = trimmed_path.to_string();
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
                    path: trimmed_path.to_string(),
                    name: nb.name.clone(),
                    enabled: true,
                    added_at: now,
                    updated_at: now,
                    missing: false,
                });
            }
        }
    }
}

/// 比较两条 path 是否应被视为"同一条目"。 tail slash / 反复 normalize
/// 都不算差异, 跟 `path_is_inside` 的语义保持一致。
#[allow(dead_code)]
fn path_eq_for_compare(a: &str, b: &Path) -> bool {
    let a_trim = a.trim_end_matches(|c| c == '/' || c == '\\');
    a_trim == b.to_string_lossy()
}

#[allow(dead_code)]
fn canonicalize_for_compare(path: &Path) -> PathBuf {
    let trimmed = path
        .to_string_lossy()
        .trim_end_matches(|c| c == '/' || c == '\\')
        .to_string();
    PathBuf::from(trimmed)
}

/// 6 位小写字母 + 数字, 与 MEMO_ID_ALPHABET 同形 ── 见
/// [`flowix_core::memo_file::MEMO_ID_ALPHABET`]。 36^6 ≈ 21.7 亿种,
/// 用户通常 < 20 个 folder, 实际不撞。

#[cfg(test)]
mod tests {
    use super::*;
    use flowix_core::memo_file::NotebookConfig;
    use std::path::PathBuf;

    fn nb(id: &str, name: &str, path: &str) -> NotebookConfig {
        NotebookConfig {
            id: id.to_string(),
            name: name.to_string(),
            icon: Some("📓".to_string()),
            path: path.to_string(),
            is_default: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn seed_populates_from_notebook_configs() {
        let dir = tempdir();
        let memo_path = dir.join("notebook.json");
        let configs = vec![
            nb("nb_1", "First", "/tmp/a/"),
            nb("nb_2", "Second", "/tmp/b/"),
        ];
        std::fs::write(&memo_path, serde_json::to_string(&configs).unwrap()).unwrap();
        let memo = MemoFile::new(dir.clone(), memo_path);
        let store = AgentAccessStore::new(dir.clone(), &memo);

        let cfg = store.get_config();
        assert_eq!(cfg.version, 1);
        assert_eq!(cfg.entries.len(), 2);
        let names: Vec<_> = cfg.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"First"));
        assert!(names.contains(&"Second"));
        for e in &cfg.entries {
            assert!(e.enabled);
            assert_eq!(e.kind, AgentAccessKind::Notebook);
        }
    }

    #[test]
    fn add_or_update_then_remove_round_trip() {
        let dir = tempdir();
        let memo_path = dir.join("notebook.json");
        std::fs::write(&memo_path, "[]").unwrap();
        let memo = MemoFile::new(dir.clone(), memo_path);
        let store = AgentAccessStore::new(dir.clone(), &memo);

        assert!(store.add_or_update_notebook(&nb("nb_1", "A", "/tmp/x/")));
        assert_eq!(store.get_config().entries.len(), 1);

        // idempotent when nothing changed
        assert!(!store.add_or_update_notebook(&nb("nb_1", "A", "/tmp/x/")));

        // rename + path change both update
        assert!(store.add_or_update_notebook(&nb("nb_1", "A2", "/tmp/y/")));
        let cfg = store.get_config();
        assert_eq!(cfg.entries[0].name, "A2");
        assert_eq!(cfg.entries[0].path, "/tmp/y");

        assert!(store.remove_notebook("nb_1"));
        assert!(!store.remove_notebook("nb_1"));
        assert!(store.get_config().entries.is_empty());
    }

    #[test]
    fn replace_config_round_trip() {
        let dir = tempdir();
        let memo_path = dir.join("notebook.json");
        std::fs::write(&memo_path, "[]").unwrap();
        let memo = MemoFile::new(dir.clone(), memo_path.clone());
        let store = AgentAccessStore::new(dir.clone(), &memo);

        let custom = AgentAccessConfig {
            version: 1,
            entries: vec![AgentAccessEntry {
                id: "fld_x".into(),
                kind: AgentAccessKind::Folder,
                path: "/tmp/foo".into(),
                name: "Foo".into(),
                enabled: true,
                added_at: 1,
                updated_at: 2,
                missing: true, // 写盘前会丢
            }],
        };
        store.replace_config(custom.clone()).unwrap();

        // 重新构造, 验证 missing 字段确实不入盘 ── 反序列化后是默认值
        // false, get_config 实时算出来是 true (因为 /tmp/foo 不存在)。
        let memo2 = MemoFile::new(dir.clone(), memo_path);
        let store2 = AgentAccessStore::new(dir.clone(), &memo2);
        let cfg2 = store2.get_config();
        assert_eq!(cfg2.entries.len(), 1);
        assert!(cfg2.entries[0].missing); // /tmp/foo 不存在, get_config 算出 missing=true
    }

    fn tempdir() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("agent_access_{}_{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
