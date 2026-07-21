//! External CLI path config 鈹€鈹€ 鎸佷箙鍖栧湪 `~/.flowix/agent-external-config.json`銆?//!
//! 浣滀负鍚?external agent (codex / claude / gemini / hermes / openclaw) 鎵ц璺緞
//! 鐨?鍞竴鍙傜収":
//! - 鍚姩鏃舵帰娴嬩竴娆?(`run_startup_detect`), 鎶婂懡涓殑 path 鍐欏叆鏂囦欢骞剁亴杩?//!   `agent_external::cli_resolver::REGISTRY`; 姝ゅ悗杩愯鏃?`resolve_external_cli`
//!   鍛戒腑鍗崇敤, 涓嶅啀姣忔潯娑堟伅璺戞帰娴嬮摼銆?//! - `source = "user"` 鐨勬潯鐩惎鍔ㄦ帰娴嬭烦杩? 灏婇噸鐢ㄦ埛鍦ㄥ亸濂借缃噷鎵嬫敼鐨勮矾寰勩€?//! - path 澶辨晥 (鏂囦欢琚垹) 涓嶈嚜鍔?fallback 鈹€鈹€ 鐢?`executable_available` 鍒?false
//!   鏍囩孩, 鐢ㄦ埛鍦ㄥ亸濂借缃偣"閲嶆柊鎺㈡祴" (`redetect`) 瑙﹀彂閲嶆帰銆?//!
//! 缁撴瀯涓?`system_data::SystemData` 瀵归綈: `RwLock` 鍐呭瓨闀滃儚 + tmp+rename 鍘熷瓙鍐?//! + 0o600 鏉冮檺銆?
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

/// 5 涓?external agent 鐨?binary_name (= AgentTypeKey = registry key)銆?/// 椤哄簭褰卞搷鍋忓ソ璁剧疆鍒楄〃鍛堢幇, 涓嶅奖鍝嶉€昏緫銆?
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
    /// 鎺㈡祴鍒扮殑鎵ц璺緞; `None` = 鏈帰娴嬪埌 / 鏈厤缃€?
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    /// `auto` = 鍚姩鎺㈡祴鍐欏叆 (鍙涓嬫鍚姩瑕嗙洊); `user` = 鐢ㄦ埛鎵嬫敼 (鍚姩鎺㈡祴璺宠繃)銆?
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

    /// 璇诲彇鏌?agent 鐨勫綋鍓嶆潯鐩?(path + source)銆?
    pub fn get_entry(&self, agent_key: &str) -> AgentExternalEntry {
        self.read_data()
            .agents
            .get(agent_key)
            .cloned()
            .unwrap_or_default()
    }

    /// 鍏ㄩ噺蹇収, 渚涘亸濂借缃睍绀恒€?
    pub fn snapshot(&self) -> HashMap<String, AgentExternalEntry> {
        self.read_data().agents.clone()
    }

    /// 鐢ㄦ埛鎵嬫敼 path: 鍐?`source = user`, flush, 鍚屾娉ㄥ唽琛ㄣ€傝繑鍥炴洿鏂板悗鐨勬潯鐩€?
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

    /// 鍚姩鎺㈡祴: 瀵?`source = auto` 鎴栫己澶辩殑 agent 璺戞帰娴嬮摼鍐欏叆; `source = user`
    /// 璺宠繃銆傛帰娴嬪畬鎴愬悗鎶婂叏閲?path 鐏岃繘娉ㄥ唽琛? 浣?`resolve_external_cli` 鍛戒腑鍗崇敤銆?    ///
    /// 姝ゅ埢娉ㄥ唽琛ㄥ皻鏈惎鐢?(`REGISTRY = None`), 鍚?`resolve_*_binary` 浼氳蛋鍘熸帰娴嬮摼
    /// (env > PATH > 鍊欓€?> shell), 涓庢敼閫犲墠琛屼负涓€鑷淬€?
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

    /// 鎶婂綋鍓?JSON 鐨?path 鍐呭瓨闀滃儚鐏岃繘 `REGISTRY`銆?
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

    /// 閲嶆柊鎺㈡祴鍗曚釜 agent: 娓呮敞鍐岃〃璇ラ」 -> 璺戞帰娴?-> 鍐?`source = auto` ->
    /// 鏇存柊娉ㄥ唽琛ㄣ€傝繑鍥炴帰娴嬪埌鐨?path (`None` = 娌℃帰娴嬪埌)銆?
    pub fn redetect(&self, agent_key: &str) -> std::io::Result<Option<PathBuf>> {
        // 鍏堜粠娉ㄥ唽琛ㄧЩ闄よ椤? 浣?`resolve_*_binary` 鍥為€€鎺㈡祴閾捐€岄潪鍛戒腑鏃?path銆?        update_external_cli_path(agent_key, None);
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
        // 鎺㈡祴鍒版墠鍥炲～娉ㄥ唽琛? 娌℃帰娴嬪埌淇濇寔绉婚櫎鐘舵€?(璇?agent 鏍?unavailable)銆?
        if let Some(p) = detected.clone() {
            update_external_cli_path(agent_key, Some(p));
        }
        Ok(detected)
    }
}

/// 璺戞煇 agent 鐨勬帰娴嬮摼銆傛鏃惰椤瑰凡浠庢敞鍐岃〃绉婚櫎鎴栨敞鍐岃〃鏈惎鐢? `resolve_*_binary`
/// 浼氬洖閫€鍒?env / PATH / 鍊欓€?/ shell 鎺㈡祴銆傝繑鍥炲彲鎵ц璺緞鎴?`None`銆?
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
    // 鎺㈡祴閾惧叏鏈懡涓椂杩斿洖瑁稿悕 (濡?"codex"), 涓嶇畻鍙敤銆?
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

        // 閲嶆柊璇荤洏楠岃瘉鎸佷箙鍖栥€?
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

        // user 鏉＄洰涓嶈瑕嗙洊銆?
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

        // redetect 寮哄埗閲嶆帰骞跺啓鍥?source=auto銆?
        let _ = cfg.redetect("codex").expect("redetect");
        let entry = cfg.get_entry("codex");
        assert_eq!(entry.source, AgentExternalSource::Auto);
        // 鐪熷疄鐜澶氬崐鎺㈡祴涓嶅埌 codex -> None; 鑻ユ帰娴嬪埌鍒欏繀涓哄彲鎵ц鏂囦欢銆?
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
        // resolve_external_cli 鐜板湪搴斿懡涓敞鍐岃〃杩斿洖璇ヨ矾寰勩€?
        use crate::agent_external::cli_resolver::{
            reset_external_cli_registry_for_test, ExternalCliSpec,
        };
        // 涓存椂鏋勯€犱竴涓?codex spec 楠岃瘉 lookup; 鐩存帴璧?resolve_external_cli銆?
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
