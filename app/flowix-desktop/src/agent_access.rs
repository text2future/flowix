//! Agent 可访问目录 (可访问文件夹 + notebook) — `~/.flowix/agent-access.json`。
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
//! 与"当前编辑哪个"。`agent-access.json` 镜像所有 notebook 条目 + 用户
//! 增删的自定义 folder 条目。两者通过 [`commands::notebook`] 的 sync
//! 钩子联动:
//!
//! - `create_notebook` → `add_or_update_notebook`
//! - `update_notebook` (改名分支) → `rename_notebook`
//! - `delete_notebook` / `clear_notebooks` → `remove_notebook` (与 registry 对账)
//!
//! ## 失联目录 (`missing`) 的语义
//!
//! `missing` 是运行时/UI 状态, 但 `get_config` 不主动 stat 路径。macOS 的
//! Documents/Desktop/Downloads 等隐私目录会因后台 exists 检查触发系统权限弹窗。
//! 目录可用性应在用户显式选择或实际使用该路径时验证。
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

/// agent-access.json 的文件名。 与 `preference.json` / `agent-config.toml`
/// / `notebook.json` 同居 `~/.flowix/`。
pub const AGENT_ACCESS_FILE_NAME: &str = "agent-access.json";

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
    #[serde(default)]
    pub workspace: bool,
    pub added_at: i64,
    pub updated_at: i64,
    /// 运行时/UI 状态。为避免 macOS 隐私目录弹窗, `get_config` 不后台
    /// stat 路径; 实际使用路径时再验证。
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
    /// 启动路径: 读盘 → 缺则播种 → 跟 notebook 注册表对账 → (dirty 才) 落盘。
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
                "agent-access.json version {} is unknown, treating as v1; future migrations should hook here",
                other
            ),
        }

        // 2. 对账: notebook.json 里的所有 config 在 access 列表里都该有条
        //    启用的对应 entry; 反过来 kind=Notebook 但 notebook.json
        //    里没有对应 id 的就是孤儿, 删掉。这一步同时承担了"两个文件
        //    写入中间崩溃 → 启动时自我修复"的语义。
        let notebook_configs = memo_file.read_notebook_configs().unwrap_or_default();
        // dirty check 用: reconcile 之前的 entries 快照。 排除 `updated_at` /
        // `workspace` ── 这俩字段 reconcile / normalize 每次都会刷, 即便语义
        // 没变化 (e.g. notebook 改名后过几个 cycle 又改回原名, 或 workspace
        // 重新选了一遍), 不应当作 dirty 信号。
        let pre_reconcile_entries = config.entries.clone();
        reconcile_with_notebook_configs(&mut config.entries, &notebook_configs);
        normalize_workspace_selection(&mut config.entries);

        let is_dirty = !entries_semantically_equal(&pre_reconcile_entries, &config.entries);

        // 3. 仅当 dirty 时落盘。 保留"两个文件写入中间崩溃 → 启动时自我修复"
        // 语义 ── 真有 reconcile 改动 (增删 notebook / 改名 / 路径漂移) 时
        // is_dirty=true, 写盘; 啥都没变时跳过, 避免每次启动都改 mtime。
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

    /// 读锁返回当前 config 的克隆。 不在这里 stat 每个路径: macOS 的
    /// Documents/Desktop/Downloads 等隐私目录会因后台 exists 检查触发系统权限弹窗。
    pub fn get_config(&self) -> AgentAccessConfig {
        let guard = self.inner.read().unwrap_or_else(|p| p.into_inner());
        guard.clone()
    }

    /// 先把整份 config 落盘, 成功后才覆盖内存。 `Err` 时内存与磁盘
    /// 都保留旧值。
    pub fn replace_config(
        &self,
        mut config: AgentAccessConfig,
    ) -> Result<AgentAccessConfig, UserConfigError> {
        normalize_workspace_selection(&mut config.entries);
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
                    workspace: false,
                    added_at: now,
                    updated_at: now,
                    missing: false,
                });
            }
        }
    }
}

fn normalize_workspace_selection(entries: &mut [AgentAccessEntry]) {
    // 主空间不再是用户手动选择项, 而是列表中第一个 enabled=true 且
    // missing=false 的 folder。每次加载/写入都重算, 避免旧 config 保留
    // 第二个 folder 的 workspace=true 后, 用户重新勾选第一个 folder 时
    // 主空间不回到第一个。
    let first_folder = entries
        .iter()
        .position(|e| e.kind == AgentAccessKind::Folder && e.enabled && !e.missing);

    for (index, entry) in entries.iter_mut().enumerate() {
        entry.workspace = Some(index) == first_folder;
    }
}

/// 比较两份 entries 是否语义等价 ── 用于 `AgentAccessStore::new` 的 dirty 判断。
///
/// **不**比较的字段 (视为自动派生, reconcile / normalize 每次会刷新, 不算 dirty):
/// - `updated_at`: 每次 reconcile_with_notebook_configs 都刷成 `chrono::Utc::now()`,
///   即使 path / name 没变。 同样, ensure_skill_folder 漂移修复也会刷。
/// - `workspace`: normalize_workspace_selection 每次启动都重算 ── 用户没动
///   folder 也会被重写一次, 不应当 dirty。
/// - `added_at`: 历史数据保留, reconcile 不会改 (新 entry 才设)。
///
/// **不**比较 `missing` ── 该字段 `skip_deserializing`, 序列化时不出现, 内存里
/// 默认 false, 实际语义等价比较不依赖它。
///
/// **依赖** entries 顺序稳定: reconcile 用 `retain` + `push` 不重排, normalize
/// 只 in-place 改 workspace。 因此 `zip` 比较是安全的。
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
                workspace: false,
                added_at: 1,
                updated_at: 2,
                missing: true, // 写盘前会丢
            }],
        };
        store.replace_config(custom.clone()).unwrap();

        // 重新构造, 验证 missing 字段按磁盘状态恢复; get_config 不再
        // 后台 stat 路径, 避免 macOS 隐私目录权限弹窗。
        let memo2 = MemoFile::new(dir.clone(), memo_path);
        let store2 = AgentAccessStore::new(dir.clone(), &memo2);
        let cfg2 = store2.get_config();
        assert_eq!(cfg2.entries.len(), 1);
        assert!(!cfg2.entries[0].missing);
    }

    #[test]
    fn replace_config_recomputes_workspace_from_first_enabled_folder() {
        let dir = tempdir();
        let memo_path = dir.join("notebook.json");
        std::fs::write(&memo_path, "[]").unwrap();
        let memo = MemoFile::new(dir.clone(), memo_path);
        let store = AgentAccessStore::new(dir.clone(), &memo);

        let config = AgentAccessConfig {
            version: 1,
            entries: vec![
                AgentAccessEntry {
                    id: "fld_a".into(),
                    kind: AgentAccessKind::Folder,
                    path: "/tmp/a".into(),
                    name: "A".into(),
                    enabled: false,
                    workspace: true,
                    added_at: 1,
                    updated_at: 1,
                    missing: false,
                },
                AgentAccessEntry {
                    id: "fld_b".into(),
                    kind: AgentAccessKind::Folder,
                    path: "/tmp/b".into(),
                    name: "B".into(),
                    enabled: true,
                    workspace: true,
                    added_at: 1,
                    updated_at: 1,
                    missing: false,
                },
            ],
        };

        store.replace_config(config).unwrap();
        let cfg = store.get_config();
        assert!(!cfg.entries[0].workspace);
        assert!(!cfg.entries[0].enabled);
        assert!(cfg.entries[1].workspace);
    }

    #[test]
    fn replace_config_auto_assigns_first_folder_when_no_workspace() {
        let dir = tempdir();
        let memo_path = dir.join("notebook.json");
        std::fs::write(&memo_path, "[]").unwrap();
        let memo = MemoFile::new(dir.clone(), memo_path);
        let store = AgentAccessStore::new(dir.clone(), &memo);

        // 两个 folder + 一个 notebook, 都 workspace=false (旧磁盘 config
        // 从未手动指定过 workspace, 因为 UI 早先还没有 home 图标)。 落
        // 盘时 normalize 应该把第一个 enabled 且非 missing 的 folder 自
        // 动设为 workspace ── 对应"第一个 folder 作为主工作区"的 UI 约
        // 定。
        let config = AgentAccessConfig {
            version: 1,
            entries: vec![
                AgentAccessEntry {
                    id: "fld_a".into(),
                    kind: AgentAccessKind::Folder,
                    path: "/tmp/a".into(),
                    name: "A".into(),
                    enabled: true,
                    workspace: false,
                    added_at: 1,
                    updated_at: 1,
                    missing: false,
                },
                AgentAccessEntry {
                    id: "fld_b".into(),
                    kind: AgentAccessKind::Folder,
                    path: "/tmp/b".into(),
                    name: "B".into(),
                    enabled: true,
                    workspace: false,
                    added_at: 1,
                    updated_at: 1,
                    missing: false,
                },
                AgentAccessEntry {
                    id: "fld_c".into(),
                    kind: AgentAccessKind::Folder,
                    path: "/tmp/c".into(),
                    name: "C".into(),
                    enabled: true,
                    workspace: false,
                    added_at: 1,
                    updated_at: 1,
                    missing: false,
                },
            ],
        };

        store.replace_config(config).unwrap();
        let cfg = store.get_config();
        assert!(
            cfg.entries[0].workspace,
            "first folder should be auto-assigned"
        );
        assert!(cfg.entries[0].enabled);
        assert!(!cfg.entries[1].workspace);
        assert!(!cfg.entries[2].workspace);
    }

    #[test]
    fn replace_config_skips_disabled_folders_when_picking_workspace() {
        // 第一个 folder 被用户手动 disabled, 第二个 enabled ── auto-assign
        // 应该跳过第一个, 把第二个 folder 标为 workspace。 这是 "第一个
        // 勾选的文件夹作为主空间" 的核心: workspace 跟的是 "第一个 enabled",
        // 不是 "第一个位置"。
        let dir = tempdir();
        let memo_path = dir.join("notebook.json");
        std::fs::write(&memo_path, "[]").unwrap();
        let memo = MemoFile::new(dir.clone(), memo_path);
        let store = AgentAccessStore::new(dir.clone(), &memo);

        let config = AgentAccessConfig {
            version: 1,
            entries: vec![
                AgentAccessEntry {
                    id: "fld_disabled".into(),
                    kind: AgentAccessKind::Folder,
                    path: "/tmp/disabled".into(),
                    name: "Disabled".into(),
                    enabled: false, // 用户手动取消勾选
                    workspace: false,
                    added_at: 1,
                    updated_at: 1,
                    missing: false,
                },
                AgentAccessEntry {
                    id: "fld_active".into(),
                    kind: AgentAccessKind::Folder,
                    path: "/tmp/active".into(),
                    name: "Active".into(),
                    enabled: true,
                    workspace: false,
                    added_at: 1,
                    updated_at: 1,
                    missing: false,
                },
            ],
        };

        store.replace_config(config).unwrap();
        let cfg = store.get_config();
        // 第一个被跳过 (enabled=false), 第二个 enabled 的 fld_active 成为
        // workspace。
        assert!(
            !cfg.entries[0].workspace,
            "disabled folder should NOT be auto-assigned as workspace"
        );
        assert!(
            cfg.entries[1].workspace,
            "first enabled folder should be auto-assigned as workspace"
        );
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
            added_at: 0,
            updated_at,
            missing: false,
        }
    }

    #[test]
    fn entries_semantically_equal_returns_true_when_only_updated_at_differs() {
        // 修复 #8: reconcile 每次都刷 updated_at 即便没真改 ── 不应当作 dirty。
        let a = vec![entry(
            "nb_1",
            AgentAccessKind::Notebook,
            "/a",
            "A",
            true,
            100,
        )];
        let mut b = a.clone();
        b[0].updated_at = 200; // 时钟走动造成的变化

        assert!(
            entries_semantically_equal(&a, &b),
            "updated_at 差异应忽略, 不能误判 dirty"
        );
    }

    #[test]
    fn entries_semantically_equal_returns_true_when_workspace_changes() {
        // normalize_workspace_selection 每次启动都重算 workspace ── 即便
        // 其它字段没变, workspace 也可能不同。 不应当 dirty。
        let mut a = vec![entry(
            "fld_a",
            AgentAccessKind::Folder,
            "/a",
            "A",
            true,
            100,
        )];
        a[0].workspace = true;
        let mut b = a.clone();
        b[0].workspace = false;

        assert!(entries_semantically_equal(&a, &b), "workspace 差异应忽略");
    }

    #[test]
    fn entries_semantically_equal_returns_false_when_path_changes() {
        // 真实 reconcile 场景: notebook 改名或路径漂移 ── 必须 dirty。
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

        assert!(
            !entries_semantically_equal(&a, &b),
            "path 差异必须视为 dirty"
        );
    }

    #[test]
    fn entries_semantically_equal_returns_false_on_length_difference() {
        // 新增 / 删除 notebook 或 folder ── 必须 dirty。
        let a = vec![entry(
            "nb_1",
            AgentAccessKind::Notebook,
            "/a",
            "A",
            true,
            100,
        )];
        let b = vec![
            entry("nb_1", AgentAccessKind::Notebook, "/a", "A", true, 100),
            entry("nb_2", AgentAccessKind::Notebook, "/b", "B", true, 100),
        ];

        assert!(
            !entries_semantically_equal(&a, &b),
            "长度差异必须视为 dirty"
        );
    }

    #[test]
    fn entries_semantically_equal_returns_false_on_enabled_toggle() {
        // 用户在 UI 里切换 enabled ── 必须 dirty。
        let a = vec![entry(
            "nb_1",
            AgentAccessKind::Notebook,
            "/a",
            "A",
            true,
            100,
        )];
        let mut b = a.clone();
        b[0].enabled = false;

        assert!(
            !entries_semantically_equal(&a, &b),
            "enabled 切换必须视为 dirty"
        );
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
