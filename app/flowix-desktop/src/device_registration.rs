//! 设备登记：使用应用首次安装时生成的随机 `device_id` 向 Supabase
//! 登记安装和刷新 `last_seen_at`。
//!
//! 这里只上报版本和平台所需的最小字段，不读取 hostname、系统 machine ID、
//! locale 或 timezone，也不构造稳定机器指纹。
//! - 启动登记使用 fire-and-forget 异步任务，不阻塞主线程。
//! - 启动后等待 `REGISTRATION_DELAY_SECS`，避开启动早期资源竞争。
//! - 本地状态写入 `~/.flowix/boot/boot.json`。
//! - 每次启动按 `device_id` 登记：首次写入，后续只刷新
//!   `last_seen_at`、`app_version`、`os` 和 `arch`。
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// `~/.flowix/boot/` �?��内的文件�? �?`system.json` 平级�?
const BOOT_FILE_NAME: &str = "boot.json";
/// 当前文件结构版本。�?到不匹配就当无效处理 (落到 `fresh()`)�?
/// v2: 嵌�?结构 ── 顶层 `{schemaVersion, userInfo}`, `userInfo` 内放�?���?
/// 的全部字段�?后续若有更�?�?��期元数据, �?sibling 即可 (例�?
/// `featureFlags: {...}`), 涓嶄簰鐩歌鐩栥€?
const BOOT_SCHEMA_VERSION: u32 = 2;
/// �?��后等多久再上�? 让其它资�?(日志、目录�?账、sidecar spawn) 先稳定�?
const REGISTRATION_DELAY_SECS: u64 = 10;
/// 单�? HTTP 请求超时�?
const REQUEST_TIMEOUT_SECS: u64 = 8;
/// 默�? Supabase Edge Function URL (�?`commands/product.rs` 同一 project)�?
/// 与产品更新�?点一样支�?`FLOWIX_DEVICE_REGISTRATION_URL` env 覆盖�?
const DEFAULT_REGISTRATION_ENDPOINT: &str =
    "https://fqvruyesgivjlwhojyya.supabase.co/functions/v1/register-device";
/// 默�? anon key�?�?`commands/product.rs::supabase_anon_key()` 同�? ──
/// 后续若抽�?`supabase.rs` �?��模块, 这边直接复用即可�?
const DEFAULT_SUPABASE_ANON_KEY: &str = "sb_publishable_l6AmH0K0Uq8_roThQHSnnQ_2xxxl0o1";

/// `~/.flowix/boot/boot.json` 顶层结构�?///
/// 多项并存 ── 后续若有更�?�?��期元数据 (例�? `featureFlags`、`firstRunHints`�?/// 某�?�?���?cache), �?sibling 即可, 不互相�?盖�?设�?登�?的所有字段收�?/// �?`userInfo` 子�?象里�?
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootFile {
    pub schema_version: u32,
    #[serde(default)]
    pub experimental: bool,
    /// Whether the first-run DeepSeek Harness introduction has been shown.
    /// Keep the on-disk key in snake_case for the boot.json contract.
    #[serde(default, rename = "is_introduct_displayed")]
    pub is_introduct_displayed: bool,
    /// Whether the first-run workspace onboarding has been completed.
    /// Development builds intentionally keep this false so the flow can be
    /// exercised on every launch.
    #[serde(default, rename = "is_onboarding_completed")]
    pub is_onboarding_completed: bool,
    #[serde(default)]
    pub user_info: UserInfo,
}

/// 设备登记子对象：保存随机设备 ID 和登记尝试状态。
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

/// 进程内单�? �?`BootFile` �?`RwLock` �?��和路径�?
pub struct DeviceRegistry {
    path: PathBuf,
    app_version: String,
    inner: RwLock<BootFile>,
}

impl DeviceRegistry {
    /// 加载或新�?boot.json。�?果文件不存在或解析失�? 直接落回 `fresh()`�?    /// 不�?在错�?�� panic ── �?��失败比登记失败严重得多�?
    pub fn load(user_config_dir: &Path, app_version: impl Into<String>) -> Self {
        let path = user_config_dir.join("boot").join(BOOT_FILE_NAME);
        let app_version = app_version.into();
        if let Some(parent) = path.parent() {
            // best-effort, 文件已存在就能�?常�?�? 不存在时 `read_from_disk` 返回 None
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

    /// 异�?上报入口�?Fire-and-forget: �?�� `tauri::async_runtime::spawn`,
    /// 涓荤嚎绋嬬户缁€?
    pub fn spawn_startup_registration(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(REGISTRATION_DELAY_SECS)).await;
            self.try_register_once().await;
        });
    }

    /// Whether this client exposes experimental product features.
    /// Missing `experimental` in an existing v2 boot.json deserializes as false.
    pub fn experimental(&self) -> bool {
        self.read().experimental
    }

    /// Whether the DeepSeek Harness introduction has already been displayed.
    pub fn is_introduct_displayed(&self) -> bool {
        self.read().is_introduct_displayed
    }

    /// Persist the DeepSeek Harness introduction display state.
    pub fn set_introduct_displayed(&self, displayed: bool) -> Result<(), String> {
        let mut boot = self.write();
        boot.is_introduct_displayed = displayed;
        self.flush(&boot)
            .map_err(|error| format!("persist boot.json: {error}"))
    }

    /// Whether the first-run workspace onboarding has been completed.
    /// Keep development builds repeatable while still exercising the durable
    /// release behavior.
    pub fn is_onboarding_completed(&self) -> bool {
        if cfg!(debug_assertions) {
            return false;
        }
        self.read().is_onboarding_completed
    }

    /// Persist onboarding completion. Debug builds deliberately write false so
    /// every development launch remains a first-run launch.
    pub fn set_onboarding_completed(&self, completed: bool) -> Result<(), String> {
        let mut boot = self.write();
        boot.is_onboarding_completed = if cfg!(debug_assertions) { false } else { completed };
        self.flush(&boot)
            .map_err(|error| format!("persist boot.json: {error}"))
    }

    /// 真�?的上报流�? 收集�?��字�? �?POST �?根据结果写回 boot.json�?    /// 失败�?��日志 / boot.json 里留�? 不抛回启动链�?
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

    /// 原子�? tmp �?fsync �?rename �?chmod 600。和 `system_data.rs` 一致�?
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

    /// 全新首�?�?��的初�?record。`installed_at` 锁定为当�? 上报成功�?    /// 服务�?upsert 用它还原原�?安�?时间�?
    fn fresh() -> BootFile {
        BootFile {
            schema_version: BOOT_SCHEMA_VERSION,
            experimental: false,
            is_introduct_displayed: false,
            is_onboarding_completed: false,
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

/// 上报 payload 结构 ── Edge Function �?��这个 schema 反序列化�?
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicePayload {
    device_id: Uuid,
    os: String,
    arch: String,
    app_version: String,
    installed_at: DateTime<Utc>,
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
    let app_version = app_version.to_string();
    DevicePayload {
        device_id: boot.user_info.device_id,
        os,
        arch,
        app_version,
        installed_at: boot.user_info.installed_at,
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
        // 409 代表 device_id 重�?, 等同成功�?
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
        assert!(!b.experimental);
        assert!(!b.is_introduct_displayed);
        assert!(!b.is_onboarding_completed);
        assert!(!b.user_info.registered);
        assert_eq!(b.user_info.attempts, 0);
        assert!(b.user_info.registered_at.is_none());
        assert!(b.user_info.last_attempt_error.is_none());
    }

    #[test]
    fn roundtrip_serde() {
        let mut b = fresh_boot();
        b.experimental = true;
        let s = serde_json::to_string(&b).unwrap();
        assert!(s.contains("\"is_introduct_displayed\":false"));
        assert!(s.contains("\"is_onboarding_completed\":false"));
        let v: BootFile = serde_json::from_str(&s).unwrap();
        assert!(v.experimental);
        assert!(!v.is_introduct_displayed);
        assert!(!v.is_onboarding_completed);
        assert_eq!(b.user_info.device_id, v.user_info.device_id);
        assert_eq!(b.user_info.installed_at, v.user_info.installed_at);
        assert_eq!(
            b.user_info.app_version_at_install,
            v.user_info.app_version_at_install
        );
    }

    #[test]
    fn missing_experimental_defaults_to_false() {
        let mut value = serde_json::to_value(fresh_boot()).unwrap();
        value.as_object_mut().unwrap().remove("experimental");
        let boot: BootFile = serde_json::from_value(value).unwrap();
        assert!(!boot.experimental);
    }

    #[test]
    fn missing_intro_displayed_defaults_to_false() {
        let mut value = serde_json::to_value(fresh_boot()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("is_introduct_displayed");
        let boot: BootFile = serde_json::from_value(value).unwrap();
        assert!(!boot.is_introduct_displayed);
    }

    #[test]
    fn missing_onboarding_completed_defaults_to_false() {
        let mut value = serde_json::to_value(fresh_boot()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("is_onboarding_completed");
        let boot: BootFile = serde_json::from_value(value).unwrap();
        assert!(!boot.is_onboarding_completed);
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
        // 旧版 flat 顶层字�?结构 (v1) ── 升级�?v2 后旧文件应�?�? �?fresh()�?
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
        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"userInfo\""));
        assert!(json.contains("\"deviceId\""));
        // �?? userInfo �?��套�?�? 字�?不在顶层�?
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            parsed.get("deviceId").is_none(),
            "deviceId must be nested under userInfo, not top-level"
        );
        assert!(parsed["userInfo"].get("deviceId").is_some());
    }

    #[test]
    fn collect_payload_contains_only_random_id_and_platform_fields() {
        let boot = fresh_boot();
        let payload = collect_payload(&boot, "9.8.7");
        assert_eq!(payload.os, std::env::consts::OS);
        assert_eq!(payload.arch, std::env::consts::ARCH);
        assert_eq!(payload.device_id, boot.user_info.device_id);
        assert_eq!(payload.installed_at, boot.user_info.installed_at);
        assert_eq!(payload.app_version, "9.8.7");

        let json = serde_json::to_value(payload).unwrap();
        let keys = json
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            vec!["appVersion", "arch", "deviceId", "installedAt", "os"]
        );
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
