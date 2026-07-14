//! 启动设备登记 ── 把"这台机器"的轻量指纹上报到 Supabase。
//!
//! 设计要点:
//! - 仅基于本地可读、不需任何权限的字段 (`std::env::consts` / `gethostname` /
//!   `machine-uid` / `LANG` / `TZ`), 见 `collect_payload`。
//! - 不阻塞主启动: `bootstrap::run().setup()` 里 `Arc::clone().spawn_startup_registration()`
//!   后立刻返回, 网络调用是 fire-and-forget。
//! - 启动后等 `REGISTRATION_DELAY_SECS` 秒, 避开启动早期的资源竞争
//!   (产品更新检查在 7s 时打, 我们排在 10s 后)。
//! - 本地状态写在 `~/.flowix/boot/boot.json`, 与 `system.json` (tag 布局) 平级但
//!   文件独立, 职责更清晰。
//! - 每次启动都上报一次。远端按 `device_id` upsert: 首次启动插入登记行,
//!   后续启动刷新同一行的 `last_seen_at` / app_version / locale / timezone。
//! - `registered=true` 只表示本机至少成功登记过一次, 不再作为跳过网络的
//!   fast-path。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

use chrono::{DateTime, Utc};
use machine_uid::get as get_machine_uid;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// `~/.flowix/boot/` 目录内的文件名, 与 `system.json` 平级。
const BOOT_FILE_NAME: &str = "boot.json";
/// 当前文件结构版本。读到不匹配就当无效处理 (落到 `fresh()`)。
/// v2: 嵌套结构 ── 顶层 `{schemaVersion, userInfo}`, `userInfo` 内放本模块
/// 的全部字段。 后续若有更多启动期元数据, 加 sibling 即可 (例如
/// `featureFlags: {...}`), 不互相覆盖。
const BOOT_SCHEMA_VERSION: u32 = 2;
/// 启动后等多久再上报, 让其它资源 (日志、目录对账、sidecar spawn) 先稳定。
const REGISTRATION_DELAY_SECS: u64 = 10;
/// 单次 HTTP 请求超时。
const REQUEST_TIMEOUT_SECS: u64 = 8;
/// 默认 Supabase Edge Function URL (与 `commands/product.rs` 同一 project)。
/// 与产品更新端点一样支持 `FLOWIX_DEVICE_REGISTRATION_URL` env 覆盖。
const DEFAULT_REGISTRATION_ENDPOINT: &str =
    "https://fqvruyesgivjlwhojyya.supabase.co/functions/v1/register-device";
/// 默认 anon key。 与 `commands/product.rs::supabase_anon_key()` 同步 ──
/// 后续若抽到 `supabase.rs` 公共模块, 这边直接复用即可。
const DEFAULT_SUPABASE_ANON_KEY: &str = "sb_publishable_l6AmH0K0Uq8_roThQHSnnQ_2xxxl0o1";

/// `~/.flowix/boot/boot.json` 顶层结构。
///
/// 多项并存 ── 后续若有更多启动期元数据 (例如 `featureFlags`、`firstRunHints`、
/// 某种启动期 cache), 加 sibling 即可, 不互相覆盖。 设备登记的所有字段收敛
/// 到 `userInfo` 子对象里。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootFile {
    pub schema_version: u32,
    #[serde(default)]
    pub user_info: UserInfo,
}

/// 设备登记子对象 ── 启动异步上报的本机指纹记录 + 尝试状态。
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

/// 进程内单例, 持 `BootFile` 的 `RwLock` 副本和路径。
pub struct DeviceRegistry {
    path: PathBuf,
    app_version: String,
    inner: RwLock<BootFile>,
}

impl DeviceRegistry {
    /// 加载或新建 boot.json。如果文件不存在或解析失败, 直接落回 `fresh()`。
    /// 不要在错误上 panic ── 启动失败比登记失败严重得多。
    pub fn load(user_config_dir: &Path, app_version: impl Into<String>) -> Self {
        let path = user_config_dir.join("boot").join(BOOT_FILE_NAME);
        let app_version = app_version.into();
        if let Some(parent) = path.parent() {
            // best-effort, 文件已存在就能正常读到, 不存在时 `read_from_disk` 返回 None
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

    /// 异步上报入口。 Fire-and-forget: 启动 `tauri::async_runtime::spawn`,
    /// 主线程继续。
    pub fn spawn_startup_registration(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(REGISTRATION_DELAY_SECS)).await;
            self.try_register_once().await;
        });
    }

    /// 真正的上报流程: 收集本机字段 → POST → 根据结果写回 boot.json。
    /// 失败只在日志 / boot.json 里留痕, 不抛回启动链。
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

    /// 原子写: tmp → fsync → rename → chmod 600。和 `system_data.rs` 一致。
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

    /// 全新首次启动的初始 record。`installed_at` 锁定为当下, 上报成功后
    /// 服务端 upsert 用它还原原始安装时间。
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

/// 上报 payload 结构 ── Edge Function 端按这个 schema 反序列化。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicePayload {
    device_id: Uuid,
    os: String,
    arch: String,
    /// FNV-1a 64-bit hash of hostname, 16 hex chars。仅指纹用途, 不落原始 hostname。
    hostname_hash: Option<String>,
    /// `machine_uid::get()` 的稳定 per-machine ID (macOS IOPlatformUUID /
    /// Windows MachineGuid / Linux /etc/machine-id)。失败时 None。
    machine_id: Option<String>,
    /// FNV-1a 64-bit hash of `os:arch:hostname`, 16 hex chars, 用于服务端跨字段去重。
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
        // 409 代表 device_id 重复, 等同成功。
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

/// `gethostname(2)` / `GetComputerNameEx` 包装。失败返回空串, 上报字段
/// 退化为 None。
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

/// `machine-uid` crate 在所有平台都返回稳定 per-machine ID; 但少数硬化镜像
/// 上可能 IO 失败, 这里用 `catch_unwind` 兜一下, 避免启动任务 panic。
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

/// FNV-1a 64-bit, 输出 16 hex 字符。零依赖、跨 Rust 版本稳定 ── 不需要
/// 密码学强度, 仅做服务端去重指纹。
fn fnv1a_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// (占位) ── 当前实际走 FNV-1a, 这里本来想用 `DefaultHasher` 但跨 Rust
/// 版本不稳定。 保留空行避免后续误改。
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
        // 旧版 flat 顶层字段结构 (v1) ── 升级到 v2 后旧文件应被拒, 走 fresh()。
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
        // 顶层必须是 schemaVersion + userInfo 嵌套, 字段不再 flat。
        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"userInfo\""));
        assert!(json.contains("\"deviceId\""));
        // 确认 userInfo 是嵌套对象, 字段不在顶层。
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
