use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::USER_CONFIG_DIR_NAME;

/// AI 模型配置文件名 ── TOML 格式, 便于人手编辑与注释。
///
/// TOML 格式便于用户手改磁盘配置时写注释 (TOML 原生 `# ...`), 避免误删字段。
/// 与 Flowix 的其它配置文件 (`boot/preference.json` /
///    `notebook.json` / `boot/system.json`) 区分得更显眼
///    (TOML 格式 + 显式 `agent-` 前缀, 不会出现"哪个文件该用 JSON"的歧义)
pub const AI_CONFIG_FILE_NAME: &str = "agent-config.toml";

const BOOT_DIR_NAME: &str = "boot";
const PREFERENCE_FILE_NAME: &str = "preference.json";

/// ~/.flowix/boot/preference.json — 用户偏好设置
/// 字段全部 #[serde(default)], 文件损坏或缺失时回退到默认值。

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizeConfig {
    #[serde(default)]
    pub custom_instruction: String,
    #[serde(default)]
    pub response_length: String,
    #[serde(default)]
    pub preferred_language: String,
    #[serde(default)]
    pub selected_tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatConfig {
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_id: Option<String>,
    #[serde(default)]
    pub font_size: f64,
    #[serde(default)]
    pub line_height: f64,
    /// 文档编辑区最大宽度 (px) — 应用于 Tiptap ProseMirror max-width。
    /// 镜像前端 `FormatConfig.documentWidth`, 老 preference.json 没此字段
    /// 时由 `#[serde(default)]` 兜底为 0, 前端 sanitizeSettings 会用默认值覆盖。
    #[serde(default)]
    pub document_width: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyFieldConfig {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertiesConfig {
    #[serde(default)]
    pub fields: Vec<PropertyFieldConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsConfig {
    #[serde(default)]
    pub enabled_by_type: HashMap<String, bool>,
    /// 常用语列表 ── 用户在偏好设置 → 工具 tab 里维护,
    /// 在角色选择弹窗作为快捷输入片段注入 composer。
    /// 老 preference.json 没有此字段时由 #[serde(default)] 兜底为空数组。
    #[serde(default)]
    pub quick_phrases: Vec<QuickPhrase>,
}

/// 单条常用语 ── 标题 + 提示词。 镜像前端 `QuickPhrase` 接口。
/// 后端不做内容校验 (长度 / 字段必填), 由前端 sanitizeSettings 兜底;
/// 后端只负责持久化, 保证序列化字段完整。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickPhrase {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub prompt: String,
}

fn default_product_updates_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductUpdatesConfig {
    #[serde(default = "default_product_updates_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub last_checked_at: i64,
    #[serde(default)]
    pub dismissed_notice_ids: Vec<String>,
    #[serde(default)]
    pub remind_later: HashMap<String, i64>,
}

impl Default for ProductUpdatesConfig {
    fn default() -> Self {
        Self {
            enabled: default_product_updates_enabled(),
            last_checked_at: 0,
            dismissed_notice_ids: Vec::new(),
            remind_later: HashMap::new(),
        }
    }
}

/// 合法主题枚举 — 替代原来的裸 `String`, 在 serde 边界上约束取值。
///
/// 序列化形式是小写字符串 (`"system"` / `"light"` / ...), 与前端 `ThemeId` 联合
/// 类型字面量一一对应; 老的 preference.json (字符串) 仍然兼容读取。
/// 任何不在 6 个变体里的字符串 (例如用户手改磁盘 / 未来客户端加新主题) 会在
/// 反序列化阶段直接报错, 不会写回内存 — 兜底由前端的 sanitizeTheme 兜底成 "system"。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
    Rock,
    Mist,
    /// 暖米纸面 + 珊瑚橙焦点 (主色 #FB6A42), 与 rock/mist 占据同一"克制单
    /// 色 + 单色锚"槽位但走暖色路线。 前端 css/theme/ember.css 提供色板。
    Ember,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceFile {
    #[serde(default)]
    pub personalize: PersonalizeConfig,
    #[serde(default)]
    pub format: FormatConfig,
    #[serde(default)]
    pub theme: Theme,
    /// UI display language. Separate from `personalize.preferred_language`,
    /// which only guides AI replies.
    #[serde(default)]
    pub language: String,
    /// 安装时基于系统语言/时区识别的地区 ("mainland" | "overseas")。
    /// 由前端 loadInitial 首次启动时写入, 老 preference.json 没这个字段
    /// 时由 `#[serde(default)]` 兜底空串, 前端 sanitizeRegion 会回退到
    /// detectRegion() 重新识别。
    #[serde(default)]
    pub region: String,
    /// Memo list card presentation ("detailed" | "compact").
    #[serde(default)]
    pub memo_card_variant: String,
    /// 快捷键用户覆盖层 — actionId → chord 字符串 (e.g. "Mod+Shift+K")。
    /// 镜像前端 `UserSettings.shortcuts`, 缺省走空 HashMap (即全部 action
    /// 走 `ActionDefinition::defaultBinding`)。老 preference.json 没此字段
    /// 时由 `#[serde(default)]` 兜底为空, 不抛错。
    #[serde(default)]
    pub shortcuts: HashMap<String, String>,
    /// 用户主动配置过的自定义属性字段定义。前端用于属性弹窗回显。
    #[serde(default)]
    pub properties: PropertiesConfig,
    /// Agent visibility preferences. Missing values default to enabled in the frontend.
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default)]
    pub product_updates: ProductUpdatesConfig,
    /// 文件监听白/黑名单 (skip_dirs / skip_files / allowed_extensions /
    /// max_file_size / watch_hidden)。PR2: 持久化到 preference.json,
    /// PR3 接入 IPC 热更新。
    #[serde(default)]
    pub watcher: crate::watcher::WhitelistConfig,
}

/// AI 模型配置真源 `~/.flowix/agent-config.toml`。
///
/// `PartialEq` / `Eq` 派生用于 `AgentManager` 的缓存命中判定 (`agent.rs`
/// 里 `ensure_instance` 会用 `cached.config == config` 比较)。结构体只有
/// `String` 字段, 派生的 derive 足够。
///
/// 字段名: 保留 `#[serde(rename_all = "camelCase")]` ──
///
/// - IPC (Tauri) 边界走 JSON, camelCase 与前端 `AgentConfig` 对齐
/// - TOML 文件里 camelCase 仍然合法 (TOML 不强制 snake_case), 不破坏
///   任何持久化形态, 也不让 `get_ai_config` / `set_ai_config` 在 JSON
///   与 TOML 之间走两套 rename 规则
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfig {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_url: String,
    /// 旧版单 key 字段 ── 保留以兼容已经存盘的 `apiKey = "sk-..."`。
    /// 读取时通过 `effective_api_key(provider)` 兜底; 写入时新数据
    /// 一律走 `api_keys` map, 落盘时把它清空, 老字段不再被填回。
    #[serde(default)]
    pub api_key: String,
    /// 按 provider 隔离的 key 桶: `provider -> apiKey`。
    /// 前端切换供应商时直接读这桶, 互相不串。
    #[serde(default)]
    pub api_keys: HashMap<String, String>,
    /// 单次 `chat_stream` 调用跨所有 cycle 的 token 累计上限。`Usage` 由
    /// provider 在每个流的末尾单独 push 一次, agent 跨 cycle 累加 `total_tokens`,
    /// 超出即熔断并以 `AgentError::TokenBudget` 收口。`0` 表示不限制 (保留
    /// 历史行为, 也方便单测)。默认 180_000 ── 100 cycle × 1.8k token,
    /// 留出 reasoning + system_prompt 余量, 同时挡住"工具结果越喂越胖"型
    /// wallet drain。
    #[serde(default = "default_max_total_tokens")]
    pub max_total_tokens: u32,
}

fn default_max_total_tokens() -> u32 {
    180_000
}

// 手写 Default 而非 `#[derive(Default)]`: 派生实现走 `<u32 as Default>::default()`
// 给到 0, 不读 `default_max_total_tokens()` ── 那条函数只对反序列化
// (`#[serde(default = "...")]`) 生效。两条路径必须给到同一个兜底值, 否则
// "刚启动未读盘" 与 "老 config 缺字段" 行为分裂 ── 前者会拿到 budget=0
// 等于不限, 后者会拿到 180_000。
impl Default for AiModelConfig {
    fn default() -> Self {
        Self {
            provider: String::new(),
            model: String::new(),
            api_url: String::new(),
            api_key: String::new(),
            api_keys: HashMap::new(),
            max_total_tokens: default_max_total_tokens(),
        }
    }
}

impl AiModelConfig {
    /// 取当前 provider 的有效 key:
    /// 1. `api_keys[provider]` 优先 (新格式, 按 provider 隔离)
    /// 2. 否则回落到旧版 `api_key` (老 toml 的兜底, 保证存量用户不丢 key)
    ///
    /// 旧版字段会在第一次 `set_ai_config` 写入新格式时被自动清空 ── 不需要
    /// 显式 migration, 读路径就能完成迁移。
    pub fn effective_api_key(&self, provider: &str) -> &str {
        if let Some(k) = self.api_keys.get(provider) {
            return k.as_str();
        }
        self.api_key.as_str()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigFile {
    #[serde(default)]
    pub model: AiModelConfig,
}

/// 全局用户配置存储。启动时一次性从磁盘读入内存, 写操作先落盘再更内存。
pub struct UserConfigStore {
    config_dir: PathBuf,
    preference: RwLock<PreferenceFile>,
    ai_config: RwLock<AiConfigFile>,
}

/// 用户配置 (boot/preference.json / agent-config.toml) 写盘错误。`Io` 自动从
/// `std::io::Error` 转, `Json` 从 `serde_json::Error` 转 (preference.json
/// 仍走 JSON), `Toml` 从 `toml::ser::Error` 转 (ai_config.toml 走 TOML)。
/// 之前用 `io::Error::new(io::ErrorKind::Other, e)` 手动包装的写法可以删掉,
/// 让 `?` 一步到位。
#[derive(Debug, thiserror::Error)]
pub enum UserConfigError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("toml serialization error: {0}")]
    Toml(#[from] toml::ser::Error),
}

impl UserConfigStore {
    /// 持锁失败的兜底: 锁中毒 (panic held it) 时仍返回 guard, 不让单点 panic
    /// 拖垮整个 Tauri 进程。中毒意味着 in-memory 状态可能处于不一致, 但
    /// 我们的 setter 写入顺序 (disk-first, 然后整体赋值) 让这种情况极少。
    fn read_preference(&self) -> std::sync::RwLockReadGuard<'_, PreferenceFile> {
        self.preference.read().unwrap_or_else(|poisoned| {
            tracing::error!("preference lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn write_preference(&self) -> std::sync::RwLockWriteGuard<'_, PreferenceFile> {
        self.preference.write().unwrap_or_else(|poisoned| {
            tracing::error!("preference lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn read_ai_config(&self) -> std::sync::RwLockReadGuard<'_, AiConfigFile> {
        self.ai_config.read().unwrap_or_else(|poisoned| {
            tracing::error!("ai_config lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn write_ai_config(&self) -> std::sync::RwLockWriteGuard<'_, AiConfigFile> {
        self.ai_config.write().unwrap_or_else(|poisoned| {
            tracing::error!("ai_config lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    pub fn new(home_dir: PathBuf) -> Self {
        let config_dir = home_dir.join(USER_CONFIG_DIR_NAME);
        let _ = fs::create_dir_all(&config_dir);
        // ~/.flowix 目录收紧到 0o700, 同机器其他用户进不来, 文件权限才有意义。
        set_dir_owner_only_perms(&config_dir);

        let preference = Self::read_preference_from_disk(&config_dir).unwrap_or_default();
        let ai_config = Self::read_ai_config_from_disk(&config_dir).unwrap_or_default();
        Self {
            config_dir,
            preference: RwLock::new(preference),
            ai_config: RwLock::new(ai_config),
        }
    }

    #[allow(dead_code)]
    pub fn config_dir(&self) -> &PathBuf {
        &self.config_dir
    }

    pub fn get_preference(&self) -> PreferenceFile {
        self.read_preference().clone()
    }

    /// 先把 JSON 落盘 (tmp + fsync + rename, 0o600), 成功后才更新内存。
    /// 任一写步骤失败 → 内存保持旧值, 磁盘保持旧文件, 不出现"内存新磁盘旧"或
    /// "半写截断"的损坏状态。
    pub fn set_preference(&self, p: PreferenceFile) -> Result<(), UserConfigError> {
        let content = serde_json::to_string_pretty(&p)?;
        let path = preference_file_path(&self.config_dir);
        atomic_write_json(&path, &content)?;
        *self.write_preference() = p;
        Ok(())
    }

    pub fn get_ai_config(&self) -> AiConfigFile {
        self.read_ai_config().clone()
    }

    /// 先把 TOML 落盘 (tmp + fsync + rename, 0o600), 成功后才更新内存。
    /// 任一写步骤失败 → 内存保持旧值, 磁盘保持旧文件, 不出现"内存新磁盘旧"或
    /// "半写截断"的损坏状态。Tauri IPC 边界把 `UserConfigError` `.map_err` 成
    /// `String` 后返回给前端 (`commands/settings.rs`)。
    pub fn set_ai_config(&self, c: AiConfigFile) -> Result<(), UserConfigError> {
        let content = toml::to_string_pretty(&c)?;
        let path = self.config_dir.join(AI_CONFIG_FILE_NAME);
        atomic_write_toml(&path, &content)?;
        *self.write_ai_config() = c;
        Ok(())
    }

    fn read_preference_from_disk(dir: &PathBuf) -> Option<PreferenceFile> {
        let path = preference_file_path(dir);
        if !path.exists() {
            return None;
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    }

    fn read_ai_config_from_disk(dir: &PathBuf) -> Option<AiConfigFile> {
        let path = dir.join(AI_CONFIG_FILE_NAME);
        if !path.exists() {
            return None;
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| toml::from_str(&s).ok())
    }
}

fn preference_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(BOOT_DIR_NAME).join(PREFERENCE_FILE_NAME)
}

/// 原子写 JSON: 写 .tmp → fsync → 0o600 → rename 到目标。
/// 失败时 .tmp 残留由下次启动覆盖, 不影响主文件。
///
/// `pub(crate)` — `agent_access` 等同形态的 JSON 配置文件 (含 boot/preference.json)
/// 同目录) 复用这个落盘逻辑, 不复制第二份。
pub(crate) fn atomic_write_json(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        set_dir_owner_only_perms(parent);
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    // 写完即设 0o600, 避免 rename 过程中出现"世界可读"的中间态
    set_file_owner_only_perms(&tmp);
    fs::rename(&tmp, path)?;
    // rename 之后再 chmod 一次, 覆盖目标文件权限 (POSIX rename 保留 source 权限)
    set_file_owner_only_perms(path);
    Ok(())
}

/// 原子写 TOML: 写 .tmp → fsync → 0o600 → rename 到目标。
/// 与 `atomic_write_json` 同等保证, 仅 .tmp 后缀从 `.json.tmp` 换成 `.toml.tmp`
/// 以方便人工排查磁盘残留。
pub(crate) fn atomic_write_toml(path: &Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("toml.tmp");
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
    fs::rename(&tmp, path)?;
    set_file_owner_only_perms(path);
    Ok(())
}

#[cfg(unix)]
fn set_file_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    let _ = std::fs::set_permissions(path, perms);
}

#[cfg(not(unix))]
fn set_file_owner_only_perms(_path: &Path) {}

#[cfg(unix)]
fn set_dir_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.is_dir() {
            let perms = std::fs::Permissions::from_mode(0o700);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
}

#[cfg(not(unix))]
fn set_dir_owner_only_perms(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_total_tokens_default_is_180k() {
        // 默认 180k ── 100 cycle × 1.8k token, 留出 reasoning + system_prompt
        // 余量。改默认值时这条单测必须同步改。
        let cfg = AiModelConfig::default();
        assert_eq!(cfg.max_total_tokens, 180_000);
    }

    #[test]
    fn max_total_tokens_round_trips_through_toml() {
        let cfg = AiModelConfig {
            provider: "openai".into(),
            model: "gpt-4o".into(),
            api_url: "https://x".into(),
            api_key: "k".into(),
            api_keys: HashMap::new(),
            max_total_tokens: 50_000,
        };
        let s = toml::to_string(&cfg).unwrap();
        // camelCase 形状 ── 与前端 AiModelConfig / IPC payload 对齐。
        assert!(s.contains("maxTotalTokens = 50000"), "got: {s}");
        let back: AiModelConfig = toml::from_str(&s).unwrap();
        assert_eq!(back.max_total_tokens, 50_000);
        assert_eq!(back.model, "gpt-4o");
    }

    #[test]
    fn ai_config_file_round_trips_through_toml() {
        // 真源是 AiConfigFile (包一层 model), 整份走 TOML 序列化。
        let cfg = AiConfigFile {
            model: AiModelConfig {
                provider: "anthropic".into(),
                model: "claude-3".into(),
                api_url: "https://api.anthropic.com".into(),
                api_key: "sk-...".into(),
                api_keys: HashMap::new(),
                max_total_tokens: 90_000,
            },
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        // 顶层 [model] 表, 字段保持 camelCase ── 与 IPC JSON 形状一致。
        assert!(s.contains("[model]"), "got: {s}");
        assert!(s.contains("apiKey"), "got: {s}");
        let back: AiConfigFile = toml::from_str(&s).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn json_model_without_max_total_tokens_loads_with_default() {
        // 缺少 maxTotalTokens 字段时必须能反序列化, 落到
        // 默认 180_000, 不能让用户首启后突然多了一个 None / 0 熔断。
        // 走 JSON 反序列化 (迁移路径 / 老文件直接走读盘), 验证 `#[serde(default = ...)]` 生效。
        let json = r#"{
            "provider": "openai",
            "model": "gpt-4o",
            "apiUrl": "https://x",
            "apiKey": "k"
        }"#;
        let cfg: AiModelConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.max_total_tokens, 180_000);
    }

    #[test]
    fn toml_config_without_max_total_tokens_loads_with_default() {
        // 手写的 TOML (用户直接编辑) 缺字段时也走 serde default ── 跟 JSON 同语义。
        let toml_content = r#"
[model]
provider = "openai"
model = "gpt-4o"
apiUrl = "https://x"
apiKey = "k"
"#;
        let cfg: AiConfigFile = toml::from_str(toml_content).unwrap();
        assert_eq!(cfg.model.max_total_tokens, 180_000);
        assert_eq!(cfg.model.model, "gpt-4o");
    }

    #[test]
    fn effective_api_key_prefers_api_keys_map_over_legacy_api_key() {
        // 新字段优先: 即便老字段还残留 (例如新代码与老 toml 并存), 只要
        // `api_keys[provider]` 有值就以它为准, 避免老 key 串到新 provider。
        let mut cfg = AiModelConfig {
            provider: "Anthropic".into(),
            api_key: "old-sk-...".into(),
            api_keys: HashMap::from([("Anthropic".to_string(), "new-sk-...".to_string())]),
            ..AiModelConfig::default()
        };
        assert_eq!(cfg.effective_api_key(&cfg.provider), "new-sk-...");

        // 当新字段没存这个 provider 时, 回落老字段, 保证存量用户不丢 key。
        cfg.api_keys.clear();
        assert_eq!(cfg.effective_api_key(&cfg.provider), "old-sk-...");
    }

    #[test]
    fn legacy_toml_with_only_api_key_loads_with_fallback() {
        // 老 toml 只有 `apiKey`, 没有 `apiKeys` map ── 反序列化时 `api_keys`
        // 走 `#[serde(default)]` 落到空 HashMap, `effective_api_key` 自动
        // 回落老字段。无需显式 migration。
        let toml_content = r#"
[model]
provider = "Anthropic"
apiKey = "sk-ant-..."
"#;
        let cfg: AiConfigFile = toml::from_str(toml_content).unwrap();
        assert!(cfg.model.api_keys.is_empty());
        assert_eq!(
            cfg.model.effective_api_key(&cfg.model.provider),
            "sk-ant-..."
        );
    }

    #[test]
    fn set_preference_writes_to_boot_dir() {
        let home = tempfile::tempdir().unwrap();
        let store = UserConfigStore::new(home.path().to_path_buf());
        let mut pref = PreferenceFile::default();
        pref.language = "en".to_string();

        store.set_preference(pref).unwrap();

        let config_dir = home.path().join(USER_CONFIG_DIR_NAME);
        let new_path = preference_file_path(&config_dir);
        assert!(
            new_path.exists(),
            "preference should be written under boot/"
        );
        let content = std::fs::read_to_string(new_path).unwrap();
        let saved: PreferenceFile = serde_json::from_str(&content).unwrap();
        assert_eq!(saved.language, "en");
    }
}
