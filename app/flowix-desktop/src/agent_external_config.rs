//! External CLI path config ── 持久化在 `~/.flowix/agent-external-config.json`。
//!
//! 作为各 external agent (codex / claude / gemini / hermes / openclaw) 执行路径
//! 的"唯一参照":
//! - 启动时探测一次 (`run_startup_detect`), 把命中的 path 写入文件并灌进
//!   `agent_external::cli_resolver::REGISTRY`; 此后运行时 `resolve_external_cli`
//!   命中即用, 不再每条消息跑探测链。
//! - `source = "user"` 的条目启动探测跳过, 尊重用户在偏好设置里手改的路径。
//! - path 失效 (文件被删) 不自动 fallback ── 由 `executable_available` 判 false
//!   标红, 用户在偏好设置点"重新探测" (`redetect`) 触发重探。
//!
//! 结构与 `system_data::SystemData` 对齐: `RwLock` 内存镜像 + tmp+rename 原子写
//! + 0o600 权限。

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use serde::{Deserialize, Serialize};

use crate::agent_external::cli_resolver::{
    is_executable_file, set_external_cli_registry, update_external_cli_path,
};
use crate::agent_external::{claude, codex, hermes, simple_cli};

/// 5 个 external agent 的 binary_name (= AgentTypeKey = registry key)。
/// 顺序影响偏好设置列表呈现, 不影响逻辑。
pub const EXTERNAL_AGENT_KEYS: &[&str] = &["codex", "claude", "gemini", "hermes", "openclaw"];

pub struct AgentExternalConfig {
    path: PathBuf,
    data: RwLock<AgentExternalConfigFile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExternalConfigFile {
    #[serde(default)]
    pub agents: HashMap<String, AgentExternalEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExternalEntry {
    /// 探测到的执行路径; `None` = 未探测到 / 未配置。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    /// `auto` = 启动探测写入 (可被下次启动覆盖); `user` = 用户手改 (启动探测跳过)。
    #[serde(default = "default_source")]
    pub source: AgentExternalSource,
}

fn default_source() -> AgentExternalSource {
    AgentExternalSource::Auto
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentExternalSource {
    Auto,
    User,
}

impl Default for AgentExternalSource {
    fn default() -> Self {
        Self::Auto
    }
}

impl AgentExternalConfig {
    pub fn new(path: PathBuf) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = Self::read_from_disk(&path).unwrap_or_default();
        Ok(Self {
            path,
            data: RwLock::new(data),
        })
    }

    pub fn transient(path: PathBuf) -> Self {
        tracing::warn!(
            "agent external config is running in transient mode; writes to {} may fail",
            path.display()
        );
        Self {
            path,
            data: RwLock::new(AgentExternalConfigFile::default()),
        }
    }

    fn read_data(&self) -> RwLockReadGuard<'_, AgentExternalConfigFile> {
        self.data.read().unwrap_or_else(|poisoned| {
            tracing::error!("agent external config lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn write_data(&self) -> RwLockWriteGuard<'_, AgentExternalConfigFile> {
        self.data.write().unwrap_or_else(|poisoned| {
            tracing::error!("agent external config lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn read_from_disk(path: &Path) -> Option<AgentExternalConfigFile> {
        if !path.exists() {
            return None;
        }
        let content = fs::read_to_string(path).ok()?;
        match serde_json::from_str::<AgentExternalConfigFile>(&content) {
            Ok(data) => Some(data),
            Err(e) => {
                tracing::warn!(
                    "agent-external-config.json parse error: {e}, falling back to empty"
                );
                None
            }
        }
    }

    fn flush(&self, data: &AgentExternalConfigFile) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(data)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp)?;
            f.write_all(content.as_bytes())?;
            f.sync_all()?;
        }
        set_file_owner_only_perms(&tmp);
        fs::rename(&tmp, &self.path)?;
        set_file_owner_only_perms(&self.path);
        Ok(())
    }

    /// 读取某 agent 的当前条目 (path + source)。
    pub fn get_entry(&self, agent_key: &str) -> AgentExternalEntry {
        self.read_data()
            .agents
            .get(agent_key)
            .cloned()
            .unwrap_or_default()
    }

    /// 全量快照, 供偏好设置展示。
    pub fn snapshot(&self) -> HashMap<String, AgentExternalEntry> {
        self.read_data().agents.clone()
    }

    /// 用户手改 path: 写 `source = user`, flush, 同步注册表。返回更新后的条目。
    pub fn set_user_path(
        &self,
        agent_key: &str,
        path: PathBuf,
    ) -> std::io::Result<AgentExternalEntry> {
        let entry = AgentExternalEntry {
            path: Some(path.clone()),
            source: AgentExternalSource::User,
        };
        {
            let mut data = self.write_data();
            data.agents.insert(agent_key.to_string(), entry.clone());
            self.flush(&data)?;
        }
        update_external_cli_path(agent_key, Some(path));
        Ok(entry)
    }

    /// 启动探测: 对 `source = auto` 或缺失的 agent 跑探测链写入; `source = user`
    /// 跳过。探测完成后把全量 path 灌进注册表, 使 `resolve_external_cli` 命中即用。
    ///
    /// 此刻注册表尚未启用 (`REGISTRY = None`), 各 `resolve_*_binary` 会走原探测链
    /// (env > PATH > 候选 > shell), 与改造前行为一致。
    pub fn run_startup_detect(&self) {
        let mut changed = false;
        {
            let mut data = self.write_data();
            for &key in EXTERNAL_AGENT_KEYS {
                let current = data.agents.get(key).cloned().unwrap_or_default();
                if current.source == AgentExternalSource::User {
                    continue;
                }
                let detected = detect_external_binary(key);
                let entry = AgentExternalEntry {
                    path: detected,
                    source: AgentExternalSource::Auto,
                };
                data.agents.insert(key.to_string(), entry);
                changed = true;
            }
            if changed {
                let _ = self.flush(&data);
            }
        }
        self.load_into_registry();
    }

    /// 把当前 JSON 的 path 内存镜像灌进 `REGISTRY`。
    pub fn load_into_registry(&self) {
        let data = self.read_data();
        let mut map: HashMap<String, PathBuf> = HashMap::new();
        for &key in EXTERNAL_AGENT_KEYS {
            if let Some(p) = data.agents.get(key).and_then(|e| e.path.clone()) {
                map.insert(key.to_string(), p);
            }
        }
        set_external_cli_registry(map);
    }

    /// 重新探测单个 agent: 清注册表该项 -> 跑探测 -> 写 `source = auto` ->
    /// 更新注册表。返回探测到的 path (`None` = 没探测到)。
    pub fn redetect(&self, agent_key: &str) -> std::io::Result<Option<PathBuf>> {
        // 先从注册表移除该项, 使 `resolve_*_binary` 回退探测链而非命中旧 path。
        update_external_cli_path(agent_key, None);
        let detected = detect_external_binary(agent_key);
        {
            let mut data = self.write_data();
            data.agents.insert(
                agent_key.to_string(),
                AgentExternalEntry {
                    path: detected.clone(),
                    source: AgentExternalSource::Auto,
                },
            );
            self.flush(&data)?;
        }
        // 探测到才回填注册表; 没探测到保持移除状态 (该 agent 标 unavailable)。
        if let Some(p) = detected.clone() {
            update_external_cli_path(agent_key, Some(p));
        }
        Ok(detected)
    }
}

/// 跑某 agent 的探测链。此时该项已从注册表移除或注册表未启用, `resolve_*_binary`
/// 会回退到 env / PATH / 候选 / shell 探测。返回可执行路径或 `None`。
fn detect_external_binary(agent_key: &str) -> Option<PathBuf> {
    let path = match agent_key {
        "codex" => codex::cli::resolve_codex_binary(),
        "claude" => claude::cli::resolve_claude_binary(),
        "gemini" => simple_cli::resolve_simple_cli_binary(simple_cli::SimpleCliKind::Gemini),
        "openclaw" => simple_cli::resolve_simple_cli_binary(simple_cli::SimpleCliKind::OpenClaw),
        "hermes" => hermes::cli::resolve_hermes_binary(),
        other => {
            tracing::warn!("unknown external agent key: {other}");
            return None;
        }
    };
    // 探测链全未命中时返回裸名 (如 "codex"), 不算可用。
    if is_executable_file(&path) {
        Some(path)
    } else {
        None
    }
}

#[cfg(unix)]
fn set_file_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    let _ = std::fs::set_permissions(path, perms);
}

#[cfg(not(unix))]
fn set_file_owner_only_perms(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_external::acquire_test_env_lock as acquire_env_lock;

    fn temp_config() -> (tempfile::TempDir, AgentExternalConfig) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("agent-external-config.json");
        let cfg = AgentExternalConfig::new(path).expect("new config");
        (dir, cfg)
    }

    #[test]
    fn new_starts_empty() {
        let _guard = acquire_env_lock();
        let (_dir, cfg) = temp_config();
        assert!(cfg.snapshot().is_empty());
        assert_eq!(cfg.get_entry("codex").source, AgentExternalSource::Auto);
        assert!(cfg.get_entry("codex").path.is_none());
    }

    #[test]
    fn set_user_path_persists_and_marks_user_source() {
        let _guard = acquire_env_lock();
        let (_dir, cfg) = temp_config();
        let fake = std::env::temp_dir().join("flowix-aec-fake-codex");
        std::fs::write(&fake, "#!/bin/sh\n").ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&fake).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake, perms).unwrap();
        }

        let entry = cfg.set_user_path("codex", fake.clone()).expect("set");
        assert_eq!(entry.source, AgentExternalSource::User);
        assert_eq!(entry.path.as_deref(), Some(fake.as_path()));

        // 重新读盘验证持久化。
        let reloaded = AgentExternalConfig::new(cfg.path.clone()).expect("reload");
        let again = reloaded.get_entry("codex");
        assert_eq!(again.source, AgentExternalSource::User);
        assert_eq!(again.path.as_deref(), Some(fake.as_path()));

        let _ = std::fs::remove_file(&fake);
    }

    #[test]
    fn run_startup_detect_skips_user_source() {
        let _guard = acquire_env_lock();
        let (_dir, cfg) = temp_config();
        let sentinel = PathBuf::from("/definitely/not/a/real/path/codex");
        cfg.set_user_path("codex", sentinel.clone())
            .expect("set user");

        cfg.run_startup_detect();

        // user 条目不被覆盖。
        let entry = cfg.get_entry("codex");
        assert_eq!(entry.source, AgentExternalSource::User);
        assert_eq!(entry.path.as_deref(), Some(sentinel.as_path()));
    }

    #[test]
    fn redetect_overwrites_with_auto_source() {
        let _guard = acquire_env_lock();
        let (_dir, cfg) = temp_config();
        cfg.set_user_path("codex", PathBuf::from("/sentinel/user/path"))
            .expect("set user");

        // redetect 强制重探并写回 source=auto。
        let _ = cfg.redetect("codex").expect("redetect");
        let entry = cfg.get_entry("codex");
        assert_eq!(entry.source, AgentExternalSource::Auto);
        // 真实环境多半探测不到 codex -> None; 若探测到则必为可执行文件。
        if let Some(p) = entry.path.as_deref() {
            assert!(is_executable_file(p));
        }
    }

    #[test]
    fn load_into_registry_seeds_map() {
        let _guard = acquire_env_lock();
        let (_dir, cfg) = temp_config();
        cfg.set_user_path("codex", PathBuf::from("/some/codex"))
            .expect("set");
        cfg.load_into_registry();
        // resolve_external_cli 现在应命中注册表返回该路径。
        use crate::agent_external::cli_resolver::{
            reset_external_cli_registry_for_test, ExternalCliSpec,
        };
        // 临时构造一个 codex spec 验证 lookup; 直接走 resolve_external_cli。
        let spec = ExternalCliSpec {
            binary_name: "codex",
            #[cfg(windows)]
            windows_binary_name: "codex.cmd",
            env_vars: &["CODEX_CLI_PATH"],
            extra_unix_candidates: crate::agent_external::cli_resolver::no_extra_candidates,
            #[cfg(windows)]
            extra_windows_candidates: crate::agent_external::cli_resolver::no_extra_candidates,
        };
        let resolved = crate::agent_external::cli_resolver::resolve_external_cli(&spec);
        assert_eq!(resolved, PathBuf::from("/some/codex"));
        reset_external_cli_registry_for_test();
    }
}
