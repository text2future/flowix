use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::USER_CONFIG_DIR_NAME;
use flowix_core::secret::{entry_name, SecretStore};

/// AI 妯″瀷閰嶇疆鏂囦欢鍚?鈹€鈹€ TOML 鏍煎紡, 渚夸簬浜烘墜缂栬緫涓庢敞閲娿€?///
/// TOML 鏍煎紡渚夸簬鐢ㄦ埛鎵嬫敼纾佺洏閰嶇疆鏃跺啓娉ㄩ噴 (TOML 鍘熺敓 `# ...`), 閬垮厤璇垹瀛楁銆?/// 涓?Flowix 鐨勫叾瀹冮厤缃枃浠?(`boot/preference.json` /
///    `boot/system.json` / `index.db`) 鍖哄垎寰楁洿鏄剧溂
///    (TOML 鏍煎紡 + 鏄惧紡 `agent-` 鍓嶇紑, 涓嶄細鍑虹幇"鍝釜鏂囦欢璇ョ敤 JSON"鐨勬涔?
pub const AI_CONFIG_FILE_NAME: &str = "agent-config.toml";

const BOOT_DIR_NAME: &str = "boot";
const PREFERENCE_FILE_NAME: &str = "preference.json";
const DEFAULT_SECRET_DB_NAME: &str = "default.db";
const SECRET_ACCOUNT_NAME: &str = "default";

/// ~/.flowix/boot/preference.json 鈥?鐢ㄦ埛鍋忓ソ璁剧疆
/// 瀛楁鍏ㄩ儴 #[serde(default)], 鏂囦欢鎹熷潖鎴栫己澶辨椂鍥為€€鍒伴粯璁ゅ€笺€?
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
    /// 鏂囨。缂栬緫鍖烘渶澶у搴?(px) 鈥?搴旂敤浜?Tiptap ProseMirror max-width銆?
    /// 闀滃儚鍓嶇 `FormatConfig.documentWidth`, 鑰?preference.json 娌℃瀛楁
    /// 鏃剁敱 `#[serde(default)]` 鍏滃簳涓?0, 鍓嶇 sanitizeSettings 浼氱敤榛樿鍊艰鐩栥€?
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
    /// 甯哥敤璇垪琛?鈹€鈹€ 鐢ㄦ埛鍦ㄥ亸濂借缃?鈫?宸ュ叿 tab 閲岀淮鎶?
    /// 鍦ㄨ鑹查€夋嫨寮圭獥浣滀负蹇嵎杈撳叆鐗囨娉ㄥ叆 composer銆?
    /// 鑰?preference.json 娌℃湁姝ゅ瓧娈垫椂鐢?`#[serde(default)]` 鍏滃簳涓虹┖鏁扮粍銆?
    #[serde(default)]
    pub quick_phrases: Vec<QuickPhrase>,
}

/// 鍗曟潯甯哥敤璇?鈹€鈹€ 鏍囬 + 鎻愮ず璇嶃€?闀滃儚鍓嶇 `QuickPhrase` 鎺ュ彛銆?/// 鍚庣涓嶅仛鍐呭鏍￠獙 (闀垮害 / 瀛楁蹇呭～), 鐢卞墠绔?sanitizeSettings 鍏滃簳;
/// 鍚庣鍙礋璐ｆ寔涔呭寲, 淇濊瘉搴忓垪鍖栧瓧娈靛畬鏁淬€?
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

/// 鍚堟硶涓婚鏋氫妇 鈥?鏇夸唬鍘熸潵鐨勮８ `String`, 鍦?serde 杈圭晫涓婄害鏉熷彇鍊笺€?///
/// 搴忓垪鍖栧舰寮忔槸灏忓啓瀛楃涓?(`"system"` / `"light"` / ...), 涓庡墠绔?`ThemeId` 鑱斿悎
/// 绫诲瀷瀛楅潰閲忎竴涓€瀵瑰簲; 鑰佺殑 preference.json (瀛楃涓? 浠嶇劧鍏煎璇诲彇銆?/// 浠讳綍涓嶅湪 6 涓彉浣撻噷鐨勫瓧绗︿覆 (渚嬪鐢ㄦ埛鎵嬫敼纾佺洏 / 鏈潵瀹㈡埛绔姞鏂颁富棰? 浼氬湪
/// 鍙嶅簭鍒楀寲闃舵鐩存帴鎶ラ敊, 涓嶄細鍐欏洖鍐呭瓨 鈥?鍏滃簳鐢卞墠绔殑 sanitizeTheme 鍏滃簳鎴?"system"銆?
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
    Rock,
    Mist,
    /// 鏆栫背绾搁潰 + 鐝婄憵姗欑劍鐐?(涓昏壊 #FB6A42), 涓?rock/mist 鍗犳嵁鍚屼竴"鍏嬪埗鍗?
    /// 鑹?+ 鍗曡壊閿?妲戒綅浣嗚蛋鏆栬壊璺嚎銆?鍓嶇 css/theme/ember.css 鎻愪緵鑹叉澘銆?
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
    /// Installation region detected by the frontend on first launch.
    #[serde(default)]
    pub region: String,
    /// Memo list card presentation ("detailed" | "compact").
    #[serde(default)]
    pub memo_card_variant: String,
    /// User shortcut overrides keyed by action id.
    #[serde(default)]
    pub shortcuts: HashMap<String, String>,
    /// 鐢ㄦ埛涓诲姩閰嶇疆杩囩殑鑷畾涔夊睘鎬у瓧娈靛畾涔夈€傚墠绔敤浜庡睘鎬у脊绐楀洖鏄俱€?
    #[serde(default)]
    pub properties: PropertiesConfig,
    /// Agent visibility preferences. Missing values default to enabled in the frontend.
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default)]
    pub product_updates: ProductUpdatesConfig,
    /// 鏂囦欢鐩戝惉鐧?榛戝悕鍗?(skip_dirs / skip_files / allowed_extensions /
    /// max_file_size / watch_hidden)銆侾R2: 鎸佷箙鍖栧埌 preference.json,
    /// PR3 鎺ュ叆 IPC 鐑洿鏂般€?
    #[serde(default)]
    pub watcher: crate::watcher::WhitelistConfig,
}

/// AI 妯″瀷閰嶇疆鐪熸簮 `~/.flowix/agent-config.toml`銆?///
/// `PartialEq` / `Eq` 娲剧敓鐢ㄤ簬 `AgentManager` 鐨勭紦瀛樺懡涓垽瀹?(`agent.rs`
/// 閲?`ensure_instance` 浼氱敤 `cached.config == config` 姣旇緝)銆傜粨鏋勪綋鍙湁
/// `String` 瀛楁, 娲剧敓鐨?derive 瓒冲銆?///
/// 瀛楁鍚? 淇濈暀 `#[serde(rename_all = "camelCase")]` 鈹€鈹€
///
/// - IPC (Tauri) 杈圭晫璧?JSON, camelCase 涓庡墠绔?`AgentConfig` 瀵归綈
/// - TOML 鏂囦欢閲?camelCase 浠嶇劧鍚堟硶 (TOML 涓嶅己鍒?snake_case), 涓嶇牬鍧?///   浠讳綍鎸佷箙鍖栧舰鎬? 涔熶笉璁?`get_ai_config` / `set_ai_config` 鍦?JSON
///   涓?TOML 涔嬮棿璧颁袱濂?rename 瑙勫垯
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfig {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_url: String,
    /// 鎸?provider 闅旂鐨?key 妗? `provider -> apiKey`銆?    /// 鍓嶇鍒囨崲渚涘簲鍟嗘椂鐩存帴璇昏繖妗? 浜掔浉涓嶄覆銆?
    #[serde(default)]
    pub api_keys: HashMap<String, String>,
    /// 鍗曟 `chat_stream` 璋冪敤璺ㄦ墍鏈?cycle 鐨?token 绱涓婇檺銆俙Usage` 鐢?    /// provider 鍦ㄦ瘡涓祦鐨勬湯灏惧崟鐙?push 涓€娆? agent 璺?cycle 绱姞 `total_tokens`,
    /// 瓒呭嚭鍗崇啍鏂苟浠?`AgentError::TokenBudget` 鏀跺彛銆俙0` 琛ㄧず涓嶉檺鍒?(淇濈暀
    /// 鍘嗗彶琛屼负, 涔熸柟渚垮崟娴?銆傞粯璁?180_000 鈹€鈹€ 100 cycle 脳 1.8k token,
    /// 鐣欏嚭 reasoning + system_prompt 浣欓噺, 鍚屾椂鎸′綇"宸ュ叿缁撴灉瓒婂杺瓒婅儢"鍨?    /// wallet drain銆?
    #[serde(default = "default_max_total_tokens")]
    pub max_total_tokens: u32,
}

fn default_max_total_tokens() -> u32 {
    180_000
}

// 鎵嬪啓 Default 鑰岄潪 `#[derive(Default)]`: 娲剧敓瀹炵幇璧?`<u32 as Default>::default()`
// 缁欏埌 0, 涓嶈 `default_max_total_tokens()` 鈹€鈹€ 閭ｆ潯鍑芥暟鍙鍙嶅簭鍒楀寲
// (`#[serde(default = "...")]`) 鐢熸晥銆備袱鏉¤矾寰勫繀椤荤粰鍒板悓涓€涓厹搴曞€? 鍚﹀垯
// "鍒氬惎鍔ㄦ湭璇荤洏" 涓?"鑰?config 缂哄瓧娈? 琛屼负鍒嗚 鈹€鈹€ 鍓嶈€呬細鎷垮埌 budget=0
// 绛変簬涓嶉檺, 鍚庤€呬細鎷垮埌 180_000銆?
impl Default for AiModelConfig {
    fn default() -> Self {
        Self {
            provider: String::new(),
            model: String::new(),
            api_url: String::new(),
            api_keys: HashMap::new(),
            max_total_tokens: default_max_total_tokens(),
        }
    }
}

impl AiModelConfig {
    /// 鍙栧綋鍓?provider 鐨勬湁鏁?key, 璧?`api_keys[provider]`銆?    /// 娌℃壘鍒拌繑鍥炵┖涓? 璋冪敤鏂硅嚜宸卞喅瀹氭槸鍚︽姤閿欍€?
    pub fn effective_api_key(&self, provider: &str) -> &str {
        self.api_keys
            .get(provider)
            .filter(|k| !k.trim().is_empty())
            .map(String::as_str)
            .unwrap_or("")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigFile {
    #[serde(default)]
    pub model: AiModelConfig,
}

/// 鍏ㄥ眬鐢ㄦ埛閰嶇疆瀛樺偍銆傚惎鍔ㄦ椂涓€娆℃€т粠纾佺洏璇诲叆鍐呭瓨, 鍐欐搷浣滃厛钀界洏鍐嶆洿鍐呭瓨銆?
pub struct UserConfigStore {
    config_dir: PathBuf,
    preference: RwLock<PreferenceFile>,
    ai_config: RwLock<AiConfigFile>,
    secrets: SecretStore,
}

/// 鐢ㄦ埛閰嶇疆 (boot/preference.json / agent-config.toml) 鍐欑洏閿欒銆俙Io` 鑷姩浠?/// `std::io::Error` 杞? `Json` 浠?`serde_json::Error` 杞?(preference.json
/// 浠嶈蛋 JSON), `Toml` 浠?`toml::ser::Error` 杞?(ai_config.toml 璧?TOML)銆?/// 涔嬪墠鐢?`io::Error::new(io::ErrorKind::Other, e)` 鎵嬪姩鍖呰鐨勫啓娉曞彲浠ュ垹鎺?
/// 璁?`?` 涓€姝ュ埌浣嶃€?
#[derive(Debug, thiserror::Error)]
pub enum UserConfigError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("toml serialization error: {0}")]
    Toml(#[from] toml::ser::Error),
    #[error("secret store error: {0}")]
    SecretStore(String),
}

impl UserConfigStore {
    /// 鎸侀攣澶辫触鐨勫厹搴? 閿佷腑姣?(panic held it) 鏃朵粛杩斿洖 guard, 涓嶈鍗曠偣 panic
    /// 鎷栧灝鏁翠釜 Tauri 杩涚▼銆備腑姣掓剰鍛崇潃 in-memory 鐘舵€佸彲鑳藉浜庝笉涓€鑷? 浣?    /// 鎴戜滑鐨?setter 鍐欏叆椤哄簭 (disk-first, 鐒跺悗鏁翠綋璧嬪€? 璁╄繖绉嶆儏鍐垫瀬灏戙€?
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
        // 鍑嵁 db 钀藉湪 config_dir/default.db (鐢熶骇鐜 ~/.flowix/default.db),
        // 涓?index.db 鍚岀洰褰?鈹€鈹€ 鍙?0o700 鐩綍 + 0o600 鏂囦欢鏉冮檺淇濇姢銆?
        let db_path = home_dir
            .join(USER_CONFIG_DIR_NAME)
            .join(DEFAULT_SECRET_DB_NAME);
        Self::new_with_secret_store(home_dir, SecretStore::new(db_path))
    }

    fn new_with_secret_store(home_dir: PathBuf, secrets: SecretStore) -> Self {
        let config_dir = home_dir.join(USER_CONFIG_DIR_NAME);
        let _ = fs::create_dir_all(&config_dir);
        // ~/.flowix 鐩綍鏀剁揣鍒?0o700, 鍚屾満鍣ㄥ叾浠栫敤鎴疯繘涓嶆潵, 鏂囦欢鏉冮檺鎵嶆湁鎰忎箟銆?        set_dir_owner_only_perms(&config_dir);

        let preference = Self::read_preference_from_disk(&config_dir).unwrap_or_default();
        let ai_config = Self::read_ai_config_from_disk(&config_dir).unwrap_or_default();
        Self {
            config_dir,
            preference: RwLock::new(preference),
            ai_config: RwLock::new(ai_config),
            secrets,
        }
    }

    #[allow(dead_code)]
    pub fn config_dir(&self) -> &PathBuf {
        &self.config_dir
    }

    pub fn get_preference(&self) -> PreferenceFile {
        self.read_preference().clone()
    }

    /// 鍏堟妸 JSON 钀界洏 (tmp + fsync + rename, 0o600), 鎴愬姛鍚庢墠鏇存柊鍐呭瓨銆?    /// 浠讳竴鍐欐楠ゅけ璐?鈫?鍐呭瓨淇濇寔鏃у€? 纾佺洏淇濇寔鏃ф枃浠? 涓嶅嚭鐜?鍐呭瓨鏂扮鐩樻棫"鎴?    /// "鍗婂啓鎴柇"鐨勬崯鍧忕姸鎬併€?
    pub fn set_preference(&self, p: PreferenceFile) -> Result<(), UserConfigError> {
        let content = serde_json::to_string_pretty(&p)?;
        let path = preference_file_path(&self.config_dir);
        atomic_write_json(&path, &content)?;
        *self.write_preference() = p;
        Ok(())
    }

    pub fn get_ai_config(&self) -> AiConfigFile {
        let mut config = self.read_ai_config().clone();
        self.hydrate_ai_config_secrets(&mut config);
        config
    }

    /// 鍏堟妸 secrets 钀?db (涓诲瓨鍌?, 鍐嶆妸 **涓嶅惈鏄庢枃 key** 鐨?TOML 钀界洏
    /// (tmp + fsync + rename, 0o600), 鎴愬姛鍚庢墠鏇存柊鍐呭瓨銆?    ///
    /// **榛樿娓呯┖ TOML 閲岀殑 plaintext** 鈹€鈹€ 涓嶆妸妯″瀷 key 鍐欒繘
    /// `agent-config.toml`銆俧allback 浠呴拡瀵瑰巻鍙茬増鏈凡鍐欏叆鐨?plaintext:
    /// [`Self::get_ai_config`] 鐨?hydrate 鍦?db 娌″懡涓?(`None` / `Err`)
    /// 鏃朵繚鎸佸唴瀛樺€? 鑰屽唴瀛樺€煎湪鍚姩鏃剁敱 `read_ai_config_from_disk` 浠?    /// 纾佺洏璇诲叆 鈹€鈹€ 鑰佺敤鎴?TOML 鑻ュ甫鍘嗗彶 plaintext, 姝ゅ鑳藉厹浣? 涓€鏃﹁蛋杩?    /// 鏈嚱鏁板啓鐩? TOML 鍗充笉鍐嶅惈鏄庢枃, 鍚庣画 fallback 渚濊禆 db銆?    ///
    /// 浠讳竴鍐欐楠ゅけ璐?-> 鍐呭瓨淇濇寔鏃у€? 纾佺洏淇濇寔鏃ф枃浠? 涓嶅嚭鐜板唴瀛樻柊纾佺洏鏃ф垨
    /// 鍗婂啓鎴柇鐨勬崯鍧忕姸鎬併€俆auri IPC 杈圭晫鎶?`UserConfigError` `.map_err` 鎴?    /// `String` 鍚庤繑鍥炵粰鍓嶇 (`commands/settings.rs`)銆?
    pub fn set_ai_config(&self, mut c: AiConfigFile) -> Result<(), UserConfigError> {
        self.persist_ai_config_secrets(&c)?;
        clear_ai_config_plaintext_secrets(&mut c);
        let content = toml::to_string_pretty(&c)?;
        let path = self.config_dir.join(AI_CONFIG_FILE_NAME);
        atomic_write_toml(&path, &content)?;
        *self.write_ai_config() = c;
        Ok(())
    }

    fn persist_ai_config_secrets(&self, config: &AiConfigFile) -> Result<(), UserConfigError> {
        let model = &config.model;

        for (provider, secret) in &model.api_keys {
            if provider.trim().is_empty() {
                continue;
            }
            if secret.trim().is_empty() {
                self.delete_provider_secret(provider)?;
            } else {
                self.save_provider_secret(provider, secret)?;
            }
        }

        Ok(())
    }

    /// 鎶?db 閲岀殑 secret 濉洖 `api_keys` 鈹€鈹€ **db 浼樺厛, 缂哄け鍒?fallback
    /// 鍒?TOML plaintext**銆?    ///
    /// - `Ok(Some)` -> 鐢?db 鐨勫€艰鐩?(db 鏄富瀛樺偍)
    /// - `Ok(None)` / `Err` -> 淇濇寔 `config` 閲屽凡鏈夌殑鍊? 鍗崇鐩?TOML 鐨?    ///   plaintext (鍚姩鏃剁敱 `read_ai_config_from_disk` 璇诲叆)銆傝繖鏄?    ///   `agent-config.toml` 鍏滃簳璺緞: db 鎹熷潖 / 琚垹 / 杩佺Щ鏈熻€侀厤缃?    ///   閮借兘浠庤繖閲岃鍒?key, 涓嶉樆濉?agent銆?
    fn hydrate_ai_config_secrets(&self, config: &mut AiConfigFile) {
        let providers: Vec<String> = config.model.api_keys.keys().cloned().collect();

        for provider in providers {
            let account = entry_name(&provider, SECRET_ACCOUNT_NAME);
            match self.secrets.load(&account) {
                Ok(Some(secret)) => {
                    config.model.api_keys.insert(provider, secret.into_inner());
                }
                Ok(None) => {}
                Err(err) => {
                    tracing::warn!(
                        "failed to load api key from db for provider `{provider}`: {err}"
                    );
                }
            }
        }
    }

    fn save_provider_secret(&self, provider: &str, secret: &str) -> Result<(), UserConfigError> {
        let account = entry_name(provider, SECRET_ACCOUNT_NAME);
        self.secrets
            .save(&account, secret.trim())
            .map_err(|err| UserConfigError::SecretStore(err.to_string()))
    }

    fn delete_provider_secret(&self, provider: &str) -> Result<(), UserConfigError> {
        let account = entry_name(provider, SECRET_ACCOUNT_NAME);
        self.secrets
            .delete(&account)
            .map(|_| ())
            .map_err(|err| UserConfigError::SecretStore(err.to_string()))
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

fn clear_ai_config_plaintext_secrets(config: &mut AiConfigFile) {
    for value in config.model.api_keys.values_mut() {
        value.clear();
    }
}

fn preference_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(BOOT_DIR_NAME).join(PREFERENCE_FILE_NAME)
}

/// 鍘熷瓙鍐?JSON: 鍐?.tmp 鈫?fsync 鈫?0o600 鈫?rename 鍒扮洰鏍囥€?/// 澶辫触鏃?.tmp 娈嬬暀鐢变笅娆″惎鍔ㄨ鐩? 涓嶅奖鍝嶄富鏂囦欢銆?///
/// `pub(crate)` 鈥?`agent_access` 绛夊悓褰㈡€佺殑 JSON 閰嶇疆鏂囦欢 (鍚?boot/preference.json)
/// 鍚岀洰褰? 澶嶇敤杩欎釜钀界洏閫昏緫, 涓嶅鍒剁浜屼唤銆?
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
    // 鍐欏畬鍗宠 0o600, 閬垮厤 rename 杩囩▼涓嚭鐜?涓栫晫鍙"鐨勪腑闂存€?    set_file_owner_only_perms(&tmp);
    fs::rename(&tmp, path)?;
    // rename 涔嬪悗鍐?chmod 涓€娆? 瑕嗙洊鐩爣鏂囦欢鏉冮檺 (POSIX rename 淇濈暀 source 鏉冮檺)
    set_file_owner_only_perms(path);
    Ok(())
}

/// 鍘熷瓙鍐?TOML: 鍐?.tmp 鈫?fsync 鈫?0o600 鈫?rename 鍒扮洰鏍囥€?/// 涓?`atomic_write_json` 鍚岀瓑淇濊瘉, 浠?.tmp 鍚庣紑浠?`.json.tmp` 鎹㈡垚 `.toml.tmp`
/// 浠ユ柟渚夸汉宸ユ帓鏌ョ鐩樻畫鐣欍€?
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
    use flowix_core::secret::{KeyBackend, SecretBackend, SecretStoreError, SecretString};
    use std::sync::Mutex;

    struct TestSecretBackend {
        store: Mutex<HashMap<String, String>>,
    }

    impl TestSecretBackend {
        fn new() -> Self {
            Self {
                store: Mutex::new(HashMap::new()),
            }
        }
    }

    impl SecretBackend for TestSecretBackend {
        fn save(&self, account: &str, secret: &str) -> Result<(), SecretStoreError> {
            self.store
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }

        fn load(&self, account: &str) -> Result<Option<SecretString>, SecretStoreError> {
            Ok(self
                .store
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .map(SecretString::new))
        }

        fn delete(&self, account: &str) -> Result<bool, SecretStoreError> {
            Ok(self.store.lock().unwrap().remove(account).is_some())
        }

        fn backend_name(&self) -> KeyBackend {
            KeyBackend::Database
        }
    }

    fn test_user_config_store(home: PathBuf) -> UserConfigStore {
        UserConfigStore::new_with_secret_store(
            home,
            SecretStore::with_backend(Box::new(TestSecretBackend::new())),
        )
    }

    #[test]
    fn max_total_tokens_default_is_180k() {
        // 榛樿 180k 鈹€鈹€ 100 cycle 脳 1.8k token, 鐣欏嚭 reasoning + system_prompt
        // 浣欓噺銆傛敼榛樿鍊兼椂杩欐潯鍗曟祴蹇呴』鍚屾鏀广€?
        let cfg = AiModelConfig::default();
        assert_eq!(cfg.max_total_tokens, 180_000);
    }

    #[test]
    fn max_total_tokens_round_trips_through_toml() {
        let cfg = AiModelConfig {
            provider: "openai".into(),
            model: "gpt-4o".into(),
            api_url: "https://x".into(),
            api_keys: HashMap::new(),
            max_total_tokens: 50_000,
        };
        let s = toml::to_string(&cfg).unwrap();
        // camelCase 褰㈢姸 鈹€鈹€ 涓庡墠绔?AiModelConfig / IPC payload 瀵归綈銆?        assert!(s.contains("maxTotalTokens = 50000"), "got: {s}");
        let back: AiModelConfig = toml::from_str(&s).unwrap();
        assert_eq!(back.max_total_tokens, 50_000);
        assert_eq!(back.model, "gpt-4o");
    }

    #[test]
    fn ai_config_file_round_trips_through_toml() {
        // 鐪熸簮鏄?AiConfigFile (鍖呬竴灞?model), 鏁翠唤璧?TOML 搴忓垪鍖栥€?
        let cfg = AiConfigFile {
            model: AiModelConfig {
                provider: "anthropic".into(),
                model: "claude-3".into(),
                api_url: "https://api.anthropic.com".into(),
                api_keys: HashMap::new(),
                max_total_tokens: 90_000,
            },
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        // 椤跺眰 [model] 琛? 瀛楁淇濇寔 camelCase 鈹€鈹€ 涓?IPC JSON 褰㈢姸涓€鑷淬€?        assert!(s.contains("[model]"), "got: {s}");
        let back: AiConfigFile = toml::from_str(&s).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn json_model_without_max_total_tokens_loads_with_default() {
        // 缂哄皯 maxTotalTokens 瀛楁鏃跺繀椤昏兘鍙嶅簭鍒楀寲, 钀藉埌
        // 榛樿 180_000, 涓嶈兘璁╃敤鎴烽鍚悗绐佺劧澶氫簡涓€涓?None / 0 鐔旀柇銆?        // 璧?JSON 鍙嶅簭鍒楀寲 (杩佺Щ璺緞 / 鑰佹枃浠剁洿鎺ヨ蛋璇荤洏), 楠岃瘉 `#[serde(default = ...)]` 鐢熸晥銆?
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
        // 鎵嬪啓鐨?TOML (鐢ㄦ埛鐩存帴缂栬緫) 缂哄瓧娈垫椂涔熻蛋 serde default 鈹€鈹€ 璺?JSON 鍚岃涔夈€?
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

    #[test]
    fn set_ai_config_redacts_plaintext_from_toml_and_persists_to_db() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());
        let cfg = AiConfigFile {
            model: AiModelConfig {
                provider: "OpenAI Responses API".into(),
                model: "gpt-5.5".into(),
                api_url: "https://api.openai.com/v1".into(),
                api_keys: HashMap::from([
                    ("OpenAI Responses API".to_string(), "sk-openai".to_string()),
                    ("Anthropic".to_string(), "sk-ant".to_string()),
                ]),
                max_total_tokens: 50_000,
            },
        };

        store.set_ai_config(cfg).unwrap();

        // db 鏄富瀛樺偍; TOML 榛樿涓嶅惈鏄庢枃 key (redact, 涓嶅啓 plaintext)銆?
        let path = home
            .path()
            .join(USER_CONFIG_DIR_NAME)
            .join(AI_CONFIG_FILE_NAME);
        let content = std::fs::read_to_string(path).unwrap();
        assert!(!content.contains("sk-openai"), "got: {content}");
        assert!(!content.contains("sk-ant"), "got: {content}");

        // get 浠?db 璇诲洖 (db 鍛戒腑)
        let loaded = store.get_ai_config();
        assert_eq!(
            loaded
                .model
                .api_keys
                .get("OpenAI Responses API")
                .map(String::as_str),
            Some("sk-openai")
        );
        assert_eq!(
            loaded.model.api_keys.get("Anthropic").map(String::as_str),
            Some("sk-ant")
        );
    }

    #[test]
    fn get_ai_config_falls_back_to_toml_plaintext_when_db_misses() {
        let home = tempfile::tempdir().unwrap();
        let config_dir = home.path().join(USER_CONFIG_DIR_NAME);
        std::fs::create_dir_all(&config_dir).unwrap();
        // 棰勭疆涓€浠藉惈 plaintext 鐨?TOML 鈹€鈹€ 妯℃嫙 db 鏈懡涓?/ 杩佺Щ鍓嶈€侀厤缃€?        // 鐢?to_string_pretty 鐢熸垚, 淇濊瘉 from_str 鑳藉師鏍疯В鏋愩€?
        let seed = AiConfigFile {
            model: AiModelConfig {
                provider: "Anthropic".into(),
                model: "claude-3".into(),
                api_url: "https://api.anthropic.com".into(),
                api_keys: HashMap::from([(
                    "Anthropic".to_string(),
                    "sk-ant-from-toml".to_string(),
                )]),
                max_total_tokens: 50_000,
            },
        };
        std::fs::write(
            config_dir.join(AI_CONFIG_FILE_NAME),
            toml::to_string_pretty(&seed).unwrap(),
        )
        .unwrap();

        // TestSecretBackend 鏄┖鍐呭瓨 鈹€鈹€ db 娌℃壘鍒?key -> fallback 璇?TOML plaintext
        let store = test_user_config_store(home.path().to_path_buf());
        let loaded = store.get_ai_config();
        assert_eq!(
            loaded.model.api_keys.get("Anthropic").map(String::as_str),
            Some("sk-ant-from-toml"),
            "should fall back to toml plaintext when db misses"
        );
        assert_eq!(
            loaded.model.effective_api_key("Anthropic"),
            "sk-ant-from-toml"
        );
    }

    #[test]
    fn set_ai_config_deletes_empty_provider_secret() {
        let home = tempfile::tempdir().unwrap();
        let store = test_user_config_store(home.path().to_path_buf());

        store
            .set_ai_config(AiConfigFile {
                model: AiModelConfig {
                    provider: "Anthropic".into(),
                    api_keys: HashMap::from([("Anthropic".to_string(), "sk-ant".to_string())]),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();
        assert_eq!(
            store
                .get_ai_config()
                .model
                .api_keys
                .get("Anthropic")
                .map(String::as_str),
            Some("sk-ant")
        );

        store
            .set_ai_config(AiConfigFile {
                model: AiModelConfig {
                    provider: "Anthropic".into(),
                    api_keys: HashMap::from([("Anthropic".to_string(), String::new())]),
                    ..AiModelConfig::default()
                },
            })
            .unwrap();

        assert_eq!(
            store
                .get_ai_config()
                .model
                .api_keys
                .get("Anthropic")
                .map(String::as_str),
            Some("")
        );
    }
}
