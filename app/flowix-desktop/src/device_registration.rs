//! 设备登记：使用应用首次安装时生成的随机 `device_id` 向 Supabase
//! 登记安装和刷新 `last_seen_at`。
//!
//! 这里只上报版本和平台所需的最小字段，不读取 hostname、系统 machine ID、
//! locale 或 timezone，也不构造稳定机器指纹。
//! - 本地状态写入 `~/.flowix/boot/boot.json`。
//! - 上报只由 `daily_activity` 的单条异步循环驱动：启动一次，运行中每次跨本地
//!   04:00 再报一次。`boot.json` 因此只有一个写者，不阻塞启动链。
//! - 每次按 `device_id` 登记：首次写入，后续只刷新
//!   `last_seen_at`、`app_version`、`os` 和 `arch`。
//! - payload 可附带 `activity`（当天活跃标记），服务端按
//!   `(device_id, activity_day)` 幂等 upsert；老服务端忽略该字段。
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};
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
    pub version_initialization: VersionInitializationState,
    /// Most recent app version whose one-time version initialization completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_successful_app_version: Option<String>,
    /// Version of the one-time on-disk storage reset already completed.
    /// This is separate from app-version initialization so later releases do
    /// not repeatedly discard derived indexes or user-created plugin files.
    #[serde(default)]
    pub notebook_storage_reset_version: u32,
    #[serde(default)]
    pub experimental: bool,
    #[serde(default)]
    pub user_info: UserInfo,
}

/// Completion state for the one-time initialization associated with an app version.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInitializationState {
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub completed: bool,
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
            let _ = flowix_core::memo_file::ensure_storage_directory(parent);
        }
        let loaded = Self::read_from_disk(&path);
        let mut save_defaults = loaded.is_none();
        let boot = loaded.unwrap_or_else(|| {
            if let Err(error) = flowix_core::memo_file::backup_storage_file(&path) {
                save_defaults = false;
                tracing::warn!(%error, "could not preserve invalid boot configuration");
            }
            tracing::info!(
                "[device-reg] no boot.json at {}; creating a fresh registration record",
                path.display()
            );
            Self::fresh()
        });
        let registry = Self {
            path,
            app_version,
            inner: RwLock::new(boot),
        };
        if save_defaults {
            if let Err(error) = registry.flush(&registry.read()) {
                tracing::warn!(%error, "could not persist boot configuration");
            }
        }
        registry
    }

    /// Whether this client exposes experimental product features.
    /// Missing `experimental` in an existing v2 boot.json deserializes as false.
    pub fn experimental(&self) -> bool {
        self.read().experimental
    }

    /// App version whose one-time version initialization most recently completed.
    pub fn last_successful_app_version(&self) -> Option<String> {
        self.read().last_successful_app_version.clone()
    }

    /// Whether the current app version has completed its one-time initialization.
    pub fn is_version_initialization_complete(&self) -> bool {
        let boot = self.read();
        // `last_successful_app_version` is the durable fallback if the in-flight
        // marker was restored from an older backup or otherwise became stale.
        // Once this version has completed successfully, do not replay one-time
        // initialization because the secondary progress flag disagrees.
        boot.last_successful_app_version.as_deref() == Some(self.app_version.as_str())
            || (boot.version_initialization.app_version.as_deref()
                == Some(self.app_version.as_str())
                && boot.version_initialization.completed)
    }

    /// Update the current app version's initialization flag from dev settings.
    pub fn set_version_initialization_completed(&self, completed: bool) -> Result<(), String> {
        let mut boot = self.write();
        boot.version_initialization.app_version = Some(self.app_version.clone());
        boot.version_initialization.completed = completed;
        if completed {
            boot.last_successful_app_version = Some(self.app_version.clone());
        } else if boot.last_successful_app_version.as_deref() == Some(self.app_version.as_str()) {
            // Preserve the explicit development setting that requests a rerun.
            boot.last_successful_app_version = None;
        }
        self.flush(&boot)
            .map_err(|error| format!("persist boot.json: {error}"))
    }

    /// Persist an incomplete marker before running version-specific migrations.
    pub fn begin_version_initialization(&self) -> Result<(), String> {
        let mut boot = self.write();
        boot.version_initialization.app_version = Some(self.app_version.clone());
        boot.version_initialization.completed = false;
        self.flush(&boot)
            .map_err(|error| format!("persist boot.json: {error}"))
    }

    /// Mark the current app version initialized after all one-time steps succeed.
    /// The same atomic boot.json write advances the previous successful version
    /// so it remains available until this initialization has fully completed.
    pub fn complete_version_initialization(&self) -> Result<(), String> {
        let mut boot = self.write();
        if boot.version_initialization.app_version.as_deref() != Some(self.app_version.as_str()) {
            return Err("version initialization marker changed while running".to_string());
        }
        boot.version_initialization.completed = true;
        boot.last_successful_app_version = Some(self.app_version.clone());
        self.flush(&boot)
            .map_err(|error| format!("persist boot.json: {error}"))
    }

    pub fn notebook_storage_reset_version(&self) -> u32 {
        self.read().notebook_storage_reset_version
    }

    pub fn complete_notebook_storage_reset_version(&self, version: u32) -> Result<(), String> {
        let mut boot = self.write();
        boot.notebook_storage_reset_version = boot.notebook_storage_reset_version.max(version);
        self.flush(&boot)
            .map_err(|error| format!("persist boot.json: {error}"))
    }

    /// 上报一次设备登记（可带日活）。
    ///
    /// 全进程只有 `daily_activity` 的循环调用它，`boot.json` 因此只有一个写者。
    /// 失败只记账并返回错误，重试节奏由调用方决定。
    pub(crate) async fn report(&self, activity: Option<ActivityPayload>) -> Result<(), String> {
        let payload = {
            let boot = self.read();
            collect_payload(&boot, &self.app_version, activity)
        };
        let client = build_http_client()?;
        let Some(endpoint) = registration_endpoint() else {
            tracing::debug!(
                "[device-reg] no registration endpoint configured; skipping (default endpoint overridden to empty)"
            );
            // 显式禁用视为「无需上报」而非失败：返回 Ok 让日活循环把今天记为已报，
            // 否则会按失败退避一直重试一个永远不存在的接口。
            return Ok(());
        };

        match post_registration(&client, &endpoint, &payload).await {
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
                Ok(())
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
                Err(err)
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
            version_initialization: VersionInitializationState::default(),
            last_successful_app_version: None,
            notebook_storage_reset_version: 0,
            experimental: false,
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

/// 上报 payload 结构 ── Edge Function 按这个 schema 反序列化。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicePayload {
    device_id: Uuid,
    os: String,
    arch: String,
    app_version: String,
    installed_at: DateTime<Utc>,
    /// 日活信息。为 `None` 时字段整体省略，payload 与旧版逐键同形。
    #[serde(skip_serializing_if = "Option::is_none")]
    activity: Option<ActivityPayload>,
}

/// 随设备登记一起上送的当天活跃标记。这是线上协议的一部分，故与
/// `DevicePayload` 同处；「何时上报」的决策全在 `daily_activity::DayState`。
///
/// `client_day` 是客户端按本地 04:00 边界算出的日 key；服务端以
/// `(device_id, activity_day)` 唯一约束 upsert，重复上报自然收敛成一行。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityPayload {
    pub client_day: String,
    /// `launch`（启动那次）/ `rollover`（运行中跨日）。
    /// 两个字面量的唯一来源是 `daily_activity::DayState::trigger`。
    pub trigger: &'static str,
}

#[derive(Debug, Deserialize)]
struct RegistrationResponse {
    #[serde(default)]
    row_id: Option<String>,
    #[serde(default)]
    first_seen: Option<bool>,
}

fn collect_payload(
    boot: &BootFile,
    app_version: &str,
    activity: Option<ActivityPayload>,
) -> DevicePayload {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let app_version = app_version.to_string();
    DevicePayload {
        device_id: boot.user_info.device_id,
        os,
        arch,
        app_version,
        installed_at: boot.user_info.installed_at,
        activity,
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
        let v: BootFile = serde_json::from_str(&s).unwrap();
        assert!(v.experimental);
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
        let payload = collect_payload(&boot, "9.8.7", None);
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

        let payload = collect_payload(&boot, "2.0.0", None);

        assert_eq!(payload.device_id, original_device_id);
        assert_eq!(payload.app_version, "2.0.0");
        assert_eq!(payload.installed_at, boot.user_info.installed_at);
    }

    #[test]
    fn activity_is_additive_and_omitted_when_absent() {
        let boot = fresh_boot();
        let with_activity = collect_payload(
            &boot,
            "9.8.7",
            Some(ActivityPayload {
                client_day: "2026-11-07".into(),
                trigger: "rollover",
            }),
        );
        let json = serde_json::to_value(&with_activity).unwrap();
        assert_eq!(json["activity"]["clientDay"], "2026-11-07");
        assert_eq!(json["activity"]["trigger"], "rollover");

        // 不带日活时 payload 与旧版逐键同形：老 edge function 看不到新字段。
        let plain = serde_json::to_value(collect_payload(&boot, "9.8.7", None)).unwrap();
        assert!(plain.get("activity").is_none());
        assert_eq!(
            plain
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["appVersion", "arch", "deviceId", "installedAt", "os"]
        );
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
