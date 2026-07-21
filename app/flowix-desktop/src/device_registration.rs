//! 鍚姩璁惧鐧昏 鈹€鈹€ 鎶?杩欏彴鏈哄櫒"鐨勮交閲忔寚绾逛笂鎶ュ埌 Supabase銆?//!
//! 璁捐瑕佺偣:
//! - 浠呭熀浜庢湰鍦板彲璇汇€佷笉闇€浠讳綍鏉冮檺鐨勫瓧娈?(`std::env::consts` / `gethostname` /
//!   `machine-uid` / `LANG` / `TZ`), 瑙?`collect_payload`銆?//! - 涓嶉樆濉炰富鍚姩: `bootstrap::run().setup()` 閲?`Arc::clone().spawn_startup_registration()`
//!   鍚庣珛鍒昏繑鍥? 缃戠粶璋冪敤鏄?fire-and-forget銆?//! - 鍚姩鍚庣瓑 `REGISTRATION_DELAY_SECS` 绉? 閬垮紑鍚姩鏃╂湡鐨勮祫婧愮珵浜?//!   (浜у搧鏇存柊妫€鏌ュ湪 7s 鏃舵墦, 鎴戜滑鎺掑湪 10s 鍚?銆?//! - 鏈湴鐘舵€佸啓鍦?`~/.flowix/boot/boot.json`, 涓?`system.json` (tag 甯冨眬) 骞崇骇浣?//!   鏂囦欢鐙珛, 鑱岃矗鏇存竻鏅般€?//! - 姣忔鍚姩閮戒笂鎶ヤ竴娆°€傝繙绔寜 `device_id` upsert: 棣栨鍚姩鎻掑叆鐧昏琛?
//!   鍚庣画鍚姩鍒锋柊鍚屼竴琛岀殑 `last_seen_at` / app_version / locale / timezone銆?//! - `registered=true` 鍙〃绀烘湰鏈鸿嚦灏戞垚鍔熺櫥璁拌繃涓€娆? 涓嶅啀浣滀负璺宠繃缃戠粶鐨?//!   fast-path銆?
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

use chrono::{DateTime, Utc};
use machine_uid::get as get_machine_uid;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// `~/.flowix/boot/` 鐩綍鍐呯殑鏂囦欢鍚? 涓?`system.json` 骞崇骇銆?
const BOOT_FILE_NAME: &str = "boot.json";
/// 褰撳墠鏂囦欢缁撴瀯鐗堟湰銆傝鍒颁笉鍖归厤灏卞綋鏃犳晥澶勭悊 (钀藉埌 `fresh()`)銆?
/// v2: 宓屽缁撴瀯 鈹€鈹€ 椤跺眰 `{schemaVersion, userInfo}`, `userInfo` 鍐呮斁鏈ā鍧?
/// 鐨勫叏閮ㄥ瓧娈点€?鍚庣画鑻ユ湁鏇村鍚姩鏈熷厓鏁版嵁, 鍔?sibling 鍗冲彲 (渚嬪
/// `featureFlags: {...}`), 涓嶄簰鐩歌鐩栥€?
const BOOT_SCHEMA_VERSION: u32 = 2;
/// 鍚姩鍚庣瓑澶氫箙鍐嶄笂鎶? 璁╁叾瀹冭祫婧?(鏃ュ織銆佺洰褰曞璐︺€乻idecar spawn) 鍏堢ǔ瀹氥€?
const REGISTRATION_DELAY_SECS: u64 = 10;
/// 鍗曟 HTTP 璇锋眰瓒呮椂銆?
const REQUEST_TIMEOUT_SECS: u64 = 8;
/// 榛樿 Supabase Edge Function URL (涓?`commands/product.rs` 鍚屼竴 project)銆?
/// 涓庝骇鍝佹洿鏂扮鐐逛竴鏍锋敮鎸?`FLOWIX_DEVICE_REGISTRATION_URL` env 瑕嗙洊銆?
const DEFAULT_REGISTRATION_ENDPOINT: &str =
    "https://fqvruyesgivjlwhojyya.supabase.co/functions/v1/register-device";
/// 榛樿 anon key銆?涓?`commands/product.rs::supabase_anon_key()` 鍚屾 鈹€鈹€
/// 鍚庣画鑻ユ娊鍒?`supabase.rs` 鍏叡妯″潡, 杩欒竟鐩存帴澶嶇敤鍗冲彲銆?
const DEFAULT_SUPABASE_ANON_KEY: &str = "sb_publishable_l6AmH0K0Uq8_roThQHSnnQ_2xxxl0o1";

/// `~/.flowix/boot/boot.json` 椤跺眰缁撴瀯銆?///
/// 澶氶」骞跺瓨 鈹€鈹€ 鍚庣画鑻ユ湁鏇村鍚姩鏈熷厓鏁版嵁 (渚嬪 `featureFlags`銆乣firstRunHints`銆?/// 鏌愮鍚姩鏈?cache), 鍔?sibling 鍗冲彲, 涓嶄簰鐩歌鐩栥€?璁惧鐧昏鐨勬墍鏈夊瓧娈垫敹鏁?/// 鍒?`userInfo` 瀛愬璞￠噷銆?
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootFile {
    pub schema_version: u32,
    #[serde(default)]
    pub user_info: UserInfo,
}

/// 璁惧鐧昏瀛愬璞?鈹€鈹€ 鍚姩寮傛涓婃姤鐨勬湰鏈烘寚绾硅褰?+ 灏濊瘯鐘舵€併€?
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub device_id: Uuid,
    pub installed_at: DateTime<Utc>,
    pub registered: bool,
    #[serde(default)]
    pub registered_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub supabase_row_id: Option<String>,
    #[serde(default)]
    pub last_attempt_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_attempt_error: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    pub app_version_at_install: String,
}

/// 杩涚▼鍐呭崟渚? 鎸?`BootFile` 鐨?`RwLock` 鍓湰鍜岃矾寰勩€?
pub struct DeviceRegistry {
    path: PathBuf,
    app_version: String,
    inner: RwLock<BootFile>,
}

impl DeviceRegistry {
    /// 鍔犺浇鎴栨柊寤?boot.json銆傚鏋滄枃浠朵笉瀛樺湪鎴栬В鏋愬け璐? 鐩存帴钀藉洖 `fresh()`銆?    /// 涓嶈鍦ㄩ敊璇笂 panic 鈹€鈹€ 鍚姩澶辫触姣旂櫥璁板け璐ヤ弗閲嶅緱澶氥€?
    pub fn load(user_config_dir: &Path, app_version: impl Into<String>) -> Self {
        let path = user_config_dir.join("boot").join(BOOT_FILE_NAME);
        let app_version = app_version.into();
        if let Some(parent) = path.parent() {
            // best-effort, 鏂囦欢宸插瓨鍦ㄥ氨鑳芥甯歌鍒? 涓嶅瓨鍦ㄦ椂 `read_from_disk` 杩斿洖 None
            let _ = std::fs::create_dir_all(parent);
        }
        let boot = Self::read_from_disk(&path).unwrap_or_else(|| {
            tracing::info!(
                "[device-reg] no boot.json at {}; creating a fresh registration record",
                path.display()
            );
            Self::fresh()
        });
        Self {
            path,
            app_version,
            inner: RwLock::new(boot),
        }
    }

    /// 寮傛涓婃姤鍏ュ彛銆?Fire-and-forget: 鍚姩 `tauri::async_runtime::spawn`,
    /// 涓荤嚎绋嬬户缁€?
    pub fn spawn_startup_registration(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(REGISTRATION_DELAY_SECS)).await;
            self.try_register_once().await;
        });
    }

    /// 鐪熸鐨勪笂鎶ユ祦绋? 鏀堕泦鏈満瀛楁 鈫?POST 鈫?鏍规嵁缁撴灉鍐欏洖 boot.json銆?    /// 澶辫触鍙湪鏃ュ織 / boot.json 閲岀暀鐥? 涓嶆姏鍥炲惎鍔ㄩ摼銆?
    async fn try_register_once(&self) {
        let payload = {
            let boot = self.read();
            collect_payload(&boot, &self.app_version)
        };
        let client = match build_http_client() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("[device-reg] failed to build http client: {e}");
                return;
            }
        };
        let endpoint = match registration_endpoint() {
            Some(url) => url,
            None => {
                tracing::debug!(
                    "[device-reg] no registration endpoint configured; skipping (default endpoint overridden to empty)"
                );
                return;
            }
        };

        let result = post_registration(&client, &endpoint, &payload).await;
        match result {
            Ok(resp) => {
                let snapshot = {
                    let mut boot = self.write();
                    let info = &mut boot.user_info;
                    let now = Utc::now();
                    info.registered = true;
                    if info.registered_at.is_none() {
                        info.registered_at = Some(now);
                    }
                    info.supabase_row_id = resp.row_id.clone();
                    info.last_attempt_at = Some(now);
                    info.last_attempt_error = None;
                    info.attempts = info.attempts.saturating_add(1);
                    let device_id = info.device_id;
                    let attempts = info.attempts;
                    if let Err(e) = self.flush(&boot) {
                        tracing::error!(
                            "[device-reg] succeeded but failed to persist boot.json: {e}"
                        );
                        return;
                    }
                    (device_id, attempts, resp.first_seen.unwrap_or(false))
                };
                tracing::info!(
                    "[device-reg] registered device {} (firstSeen={}, attempts={})",
                    snapshot.0,
                    snapshot.2,
                    snapshot.1
                );
                crate::runtime_log::record_event(
                    "info",
                    "device.registered",
                    format!(
                        "device {} registered (firstSeen={}, attempts={})",
                        snapshot.0, snapshot.2, snapshot.1
                    ),
                );
            }
            Err(err) => {
                let attempts = {
                    let mut boot = self.write();
                    let info = &mut boot.user_info;
                    info.last_attempt_at = Some(Utc::now());
                    info.last_attempt_error = Some(err.clone());
                    info.attempts = info.attempts.saturating_add(1);
                    let attempts = info.attempts;
                    let _ = self.flush(&boot);
                    attempts
                };
                tracing::warn!("[device-reg] attempt {attempts} failed: {err}");
            }
        }
    }

    fn read(&self) -> RwLockReadGuard<'_, BootFile> {
        self.inner.read().unwrap_or_else(|poisoned| {
            tracing::error!("[device-reg] boot.json lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn write(&self) -> RwLockWriteGuard<'_, BootFile> {
        self.inner.write().unwrap_or_else(|poisoned| {
            tracing::error!("[device-reg] boot.json lock poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn read_from_disk(path: &Path) -> Option<BootFile> {
        let content = std::fs::read_to_string(path).ok()?;
        let boot: BootFile = match serde_json::from_str(&content) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(
                    "[device-reg] boot.json parse error at {}: {e}; falling back to fresh record",
                    path.display()
                );
                return None;
            }
        };
        if boot.schema_version != BOOT_SCHEMA_VERSION {
            tracing::warn!(
                "[device-reg] boot.json schema_version mismatch (got {}, expected {}); falling back to fresh record",
                boot.schema_version,
                BOOT_SCHEMA_VERSION
            );
            return None;
        }
        Some(boot)
    }

    /// 鍘熷瓙鍐? tmp 鈫?fsync 鈫?rename 鈫?chmod 600銆傚拰 `system_data.rs` 涓€鑷淬€?
    fn flush(&self, boot: &BootFile) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(boot)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp)?;
            f.write_all(content.as_bytes())?;
            f.sync_all()?;
        }
        set_file_owner_only_perms(&tmp);
        std::fs::rename(&tmp, &self.path)?;
        set_file_owner_only_perms(&self.path);
        Ok(())
    }

    /// 鍏ㄦ柊棣栨鍚姩鐨勫垵濮?record銆俙installed_at` 閿佸畾涓哄綋涓? 涓婃姤鎴愬姛鍚?    /// 鏈嶅姟绔?upsert 鐢ㄥ畠杩樺師鍘熷瀹夎鏃堕棿銆?
    fn fresh() -> BootFile {
        BootFile {
            schema_version: BOOT_SCHEMA_VERSION,
            user_info: UserInfo {
                device_id: Uuid::new_v4(),
                installed_at: Utc::now(),
                registered: false,
                registered_at: None,
                supabase_row_id: None,
                last_attempt_at: None,
                last_attempt_error: None,
                attempts: 0,
                app_version_at_install: env!("CARGO_PKG_VERSION").to_string(),
            },
        }
    }
}

/// 涓婃姤 payload 缁撴瀯 鈹€鈹€ Edge Function 绔寜杩欎釜 schema 鍙嶅簭鍒楀寲銆?
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicePayload {
    device_id: Uuid,
    os: String,
    arch: String,
    /// FNV-1a 64-bit hash of hostname, 16 hex chars銆備粎鎸囩汗鐢ㄩ€? 涓嶈惤鍘熷 hostname銆?
    hostname_hash: Option<String>,
    /// `machine_uid::get()` 鐨勭ǔ瀹?per-machine ID (macOS IOPlatformUUID /
    /// Windows MachineGuid / Linux /etc/machine-id)銆傚け璐ユ椂 None銆?
    machine_id: Option<String>,
    /// FNV-1a 64-bit hash of `os:arch:hostname`, 16 hex chars, 鐢ㄤ簬鏈嶅姟绔法瀛楁鍘婚噸銆?
    machine_fingerprint: String,
    app_version: String,
    locale: Option<String>,
    timezone: Option<String>,
    installed_at: DateTime<Utc>,
    app_user_agent: String,
}

#[derive(Debug, Deserialize)]
struct RegistrationResponse {
    #[serde(default)]
    row_id: Option<String>,
    #[serde(default)]
    first_seen: Option<bool>,
}

fn collect_payload(boot: &BootFile, app_version: &str) -> DevicePayload {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let hostname = get_hostname().unwrap_or_default();
    let hostname_hash = if hostname.is_empty() {
        None
    } else {
        Some(fnv1a_hex(&hostname))
    };
    let machine_id = get_machine_id_safe();
    let machine_fingerprint = fnv1a_hex(&format!("{os}:{arch}:{hostname}"));
    let app_version = app_version.to_string();
    let locale = std::env::var("LANG")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let timezone = std::env::var("TZ")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let app_user_agent = format!("Flowix/{app_version} ({os}/{arch})");
    DevicePayload {
        device_id: boot.user_info.device_id,
        os,
        arch,
        hostname_hash,
        machine_id,
        machine_fingerprint,
        app_version,
        locale,
        timezone,
        installed_at: boot.user_info.installed_at,
        app_user_agent,
    }
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

fn registration_endpoint() -> Option<String> {
    std::env::var("FLOWIX_DEVICE_REGISTRATION_URL")
        .ok()
        .or_else(|| option_env!("FLOWIX_DEVICE_REGISTRATION_URL").map(str::to_string))
        .or_else(|| Some(DEFAULT_REGISTRATION_ENDPOINT.to_string()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[allow(dead_code)]
fn supabase_anon_key() -> Option<String> {
    std::env::var("FLOWIX_SUPABASE_ANON_KEY")
        .ok()
        .or_else(|| option_env!("FLOWIX_SUPABASE_ANON_KEY").map(str::to_string))
        .or_else(|| Some(DEFAULT_SUPABASE_ANON_KEY.to_string()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn post_registration(
    client: &reqwest::Client,
    endpoint: &str,
    payload: &DevicePayload,
) -> Result<RegistrationResponse, String> {
    let mut request = client
        .post(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(key) = supabase_anon_key() {
        request = request.header("apikey", key.as_str()).bearer_auth(key);
    }
    let response = request
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        // 409 浠ｈ〃 device_id 閲嶅, 绛夊悓鎴愬姛銆?
        if status.as_u16() == 409 {
            return Ok(RegistrationResponse {
                row_id: None,
                first_seen: Some(false),
            });
        }
        return Err(format!("http {status}: {body}"));
    }
    response
        .json::<RegistrationResponse>()
        .await
        .map_err(|e| format!("parse: {e}"))
}

/// `gethostname(2)` / `GetComputerNameEx` 鍖呰銆傚け璐ヨ繑鍥炵┖涓? 涓婃姤瀛楁
/// 閫€鍖栦负 None銆?
fn get_hostname() -> Option<String> {
    let raw = match hostname::get() {
        Ok(name) => name,
        Err(_) => return None,
    };
    let s = raw.into_string().ok()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// `machine-uid` crate 鍦ㄦ墍鏈夊钩鍙伴兘杩斿洖绋冲畾 per-machine ID; 浣嗗皯鏁扮‖鍖栭暅鍍?/// 涓婂彲鑳?IO 澶辫触, 杩欓噷鐢?`catch_unwind` 鍏滀竴涓? 閬垮厤鍚姩浠诲姟 panic銆?
fn get_machine_id_safe() -> Option<String> {
    let result = std::panic::catch_unwind(|| get_machine_uid().ok().map(|s| s.trim().to_string()));
    match result {
        Ok(Some(s)) if !s.is_empty() => Some(s),
        Ok(_) => None,
        Err(_) => {
            tracing::warn!("[device-reg] machine-uid panicked; falling back to None");
            None
        }
    }
}

/// FNV-1a 64-bit, 杈撳嚭 16 hex 瀛楃銆傞浂渚濊禆銆佽法 Rust 鐗堟湰绋冲畾 鈹€鈹€ 涓嶉渶瑕?/// 瀵嗙爜瀛﹀己搴? 浠呭仛鏈嶅姟绔幓閲嶆寚绾广€?
fn fnv1a_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// (鍗犱綅) 鈹€鈹€ 褰撳墠瀹為檯璧?FNV-1a, 杩欓噷鏈潵鎯崇敤 `DefaultHasher` 浣嗚法 Rust
/// 鐗堟湰涓嶇ǔ瀹氥€?淇濈暀绌鸿閬垮厤鍚庣画璇敼銆?
#[allow(dead_code)]
fn _placeholder() {}

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

    fn fresh_boot() -> BootFile {
        DeviceRegistry::fresh()
    }

    #[test]
    fn fresh_has_valid_defaults() {
        let b = fresh_boot();
        assert_eq!(b.schema_version, BOOT_SCHEMA_VERSION);
        assert!(!b.user_info.registered);
        assert_eq!(b.user_info.attempts, 0);
        assert!(b.user_info.registered_at.is_none());
        assert!(b.user_info.last_attempt_error.is_none());
    }

    #[test]
    fn roundtrip_serde() {
        let b = fresh_boot();
        let s = serde_json::to_string(&b).unwrap();
        let v: BootFile = serde_json::from_str(&s).unwrap();
        assert_eq!(b.user_info.device_id, v.user_info.device_id);
        assert_eq!(b.user_info.installed_at, v.user_info.installed_at);
        assert_eq!(
            b.user_info.app_version_at_install,
            v.user_info.app_version_at_install
        );
    }

    #[test]
    fn schema_mismatch_falls_back_to_fresh() {
        let tmp = tempdir_path();
        std::fs::write(
            &tmp,
            r#"{"schemaVersion":999,"userInfo":{"deviceId":"00000000-0000-0000-0000-000000000000","installedAt":"2026-01-01T00:00:00Z","registered":true,"appVersionAtInstall":"1.0.0"}}"#,
        )
        .unwrap();
        let direct = DeviceRegistry::read_from_disk(&tmp);
        assert!(
            direct.is_none(),
            "schemaVersion mismatch should produce None"
        );
    }

    #[test]
    fn old_v1_flat_schema_is_rejected() {
        // 鏃х増 flat 椤跺眰瀛楁缁撴瀯 (v1) 鈹€鈹€ 鍗囩骇鍒?v2 鍚庢棫鏂囦欢搴旇鎷? 璧?fresh()銆?
        let tmp = tempdir_path();
        std::fs::write(
            &tmp,
            r#"{"schemaVersion":1,"deviceId":"00000000-0000-0000-0000-000000000000","installedAt":"2026-01-01T00:00:00Z","registered":true,"appVersionAtInstall":"1.0.0"}"#,
        )
        .unwrap();
        assert!(
            DeviceRegistry::read_from_disk(&tmp).is_none(),
            "v1 flat schema must be rejected (schemaVersion mismatch)"
        );
    }

    #[test]
    fn nested_user_info_roundtrips_via_json() {
        let b = fresh_boot();
        let json = serde_json::to_string(&b).unwrap();
        // 椤跺眰蹇呴』鏄?schemaVersion + userInfo 宓屽, 瀛楁涓嶅啀 flat銆?        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"userInfo\""));
        assert!(json.contains("\"deviceId\""));
        // 纭 userInfo 鏄祵濂楀璞? 瀛楁涓嶅湪椤跺眰銆?
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            parsed.get("deviceId").is_none(),
            "deviceId must be nested under userInfo, not top-level"
        );
        assert!(parsed["userInfo"].get("deviceId").is_some());
    }

    #[test]
    fn fnv1a_is_stable() {
        let a = fnv1a_hex("macbook");
        let b = fnv1a_hex("macbook");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        let c = fnv1a_hex("macbooK");
        assert_ne!(a, c, "FNV-1a should distinguish case");
    }

    #[test]
    fn collect_payload_uses_local_env() {
        let boot = fresh_boot();
        let payload = collect_payload(&boot, "9.8.7");
        assert_eq!(payload.os, std::env::consts::OS);
        assert_eq!(payload.arch, std::env::consts::ARCH);
        assert_eq!(payload.device_id, boot.user_info.device_id);
        assert_eq!(payload.installed_at, boot.user_info.installed_at);
        assert_eq!(payload.app_version, "9.8.7");
        assert!(payload.app_user_agent.starts_with("Flowix/9.8.7"));
    }

    #[test]
    fn registered_boot_still_builds_payload_for_same_device() {
        let mut boot = fresh_boot();
        let original_device_id = boot.user_info.device_id;
        boot.user_info.registered = true;
        boot.user_info.registered_at = Some(Utc::now());

        let payload = collect_payload(&boot, "2.0.0");

        assert_eq!(payload.device_id, original_device_id);
        assert_eq!(payload.app_version, "2.0.0");
        assert_eq!(payload.installed_at, boot.user_info.installed_at);
    }

    fn tempdir_path() -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "flowix-device-reg-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = std::fs::remove_file(&dir);
        dir
    }
}
