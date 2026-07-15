//! 首次启动时在 `~/.local/bin/` 建 `flowix` symlink,
//! 把内嵌 sidecar 暴露到用户 `$PATH`, 这样装完桌面应用后终端能直接
//! `flowix ...`。
//!
//! ## 设计
//!
//! - **幂等**: 每次启动都跑, 但只在 symlink 不存在 / 指向错误目标 /
//!   已损坏时实际写盘。 用户手动删了下次启动自动恢复 ── 比 "marker file
//!   只跑一次" 鲁棒。
//! - **失败宽容**: 任何 I/O 错误 (权限 / 磁盘满 / 只读 fs) 都只
//!   `tracing::warn!`, 不 panic / 不 propagate ── CLI 装不上不影响 GUI。
//! - **范围**: macOS + Linux 启动时建 symlink。 Windows 上的等效实现
//!   在 `app/flowix-desktop/nsis/flowix-cli-path.nsh` ── 装包时建 .cmd shim
//!   到 `$LOCALAPPDATA\Flowix\bin\`。
//!
//! ## 路径选择
//!
//! - **链接源 (target)**: `current_exe().parent().join("flowix-cli")` ──
//!   Tauri 2 的 `externalBin` 机制把 sidecar 放在主二进制旁边, dev
//!   (`app/target/<host>/debug/flowix-cli`) 跟 prod
//!   (`/Applications/Flowix.app/Contents/MacOS/flowix-cli`) 都是同
//!   layout。 跟 `commands::cli::resolve_sidecar_path` 的 prod 分支一致。
//! - **链接位置 (link)**: `$HOME/.local/bin/flowix` ── XDG
//!   用户级 bin 目录。 macOS / 多数 Linux 发行版的 zsh / bash **默认**
//!   不在 `$PATH`, 用户需要 `export PATH="$HOME/.local/bin:$PATH"` 加进
//!   `~/.zshrc`。 启动 hook 不自动改 shell config; 偏好设置里的显式
//!   "安装" 操作才会写入。
//!
//! ## 重名安全
//!
//! - macOS: 桌面 binary 装在 `.app` 包内 (`/Applications/Flowix.app/...`),
//!   **不在** `$PATH`, 所以 `~/.local/bin/flowix` 不会被它遮蔽。
//! - Linux: 若 `.deb` 把桌面 binary 装到 `/usr/bin/flowix`, 而用户
//!   `$PATH` 里 `~/.local/bin` 在 `/usr/bin` **之前** (多数发行版默认),
//!   symlink 胜出。 退一步说, 用户装我们这应用时, `/usr/bin/flowix` 八成
//!   就是我们装的同一个 sidecar ── 即便两个 entry 都在 PATH, 指向同一份
//!   inode 也无害。

use serde::Serialize;
use std::path::{Path, PathBuf};

const SH_PATH_EXPORT_LINE: &str = r#"export PATH="$HOME/.local/bin:$PATH""#;
const FISH_PATH_EXPORT_LINE: &str = "set -gx PATH $HOME/.local/bin $PATH";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLinkStatus {
    pub target_path: Option<String>,
    pub bin_dir: String,
    pub command_path: String,
    pub symlink_installed: bool,
    pub path_configured: bool,
    pub available_in_path: bool,
    pub shell_config_path: Option<String>,
    pub needs_install: bool,
    pub message: Option<String>,
}

/// 在用户级 bin 目录里建 `flowix` symlink。 任何步骤失败都 `warn!` 后返回,
/// 不 panic / 不 propagate 错误。
pub fn ensure_cli_symlink() {
    #[cfg(windows)]
    {
        tracing::debug!("[cli-link] Windows shim is managed by NSIS/install_cli_path");
        return;
    }

    let Some(home) = dirs::home_dir() else {
        tracing::warn!("[cli-link] home dir unavailable; skip symlink");
        return;
    };
    let bin_dir: PathBuf = home.join(".local").join("bin");

    let Some(target) = current_sidecar_path() else {
        tracing::debug!("[cli-link] sidecar not adjacent to current_exe; skip symlink");
        return;
    };

    if !target.exists() {
        tracing::debug!(
            "[cli-link] target {} does not exist; skip symlink",
            target.display()
        );
        return;
    }

    // 目录不存在就建。 `~/.local/bin` 在 macOS 默认不存在 ── 创了
    // 才能放 symlink。 建过一次失败就别重试, 后续 link 全部跳过。
    if !bin_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&bin_dir) {
            tracing::warn!(
                "[cli-link] failed to create {}: {e}; add ~/.local/bin to PATH manually",
                bin_dir.display()
            );
            return;
        }
    }

    ensure_one_symlink(&bin_dir, "flowix", &target);
}

pub fn cli_link_status() -> CliLinkStatus {
    #[cfg(windows)]
    {
        return windows_cli_link_status(false);
    }

    let Some(home) = dirs::home_dir() else {
        return CliLinkStatus {
            target_path: None,
            bin_dir: String::new(),
            command_path: String::new(),
            symlink_installed: false,
            path_configured: false,
            available_in_path: false,
            shell_config_path: None,
            needs_install: true,
            message: Some("home dir unavailable".into()),
        };
    };
    let bin_dir = home.join(".local").join("bin");
    let command_path = bin_dir.join("flowix");
    let target = current_sidecar_path();
    let symlink_installed = target
        .as_ref()
        .is_some_and(|target| link_points_to(&command_path, target));
    let path_configured = path_contains_dir(&bin_dir) || shell_config_contains_bin_dir(&home);
    let available_in_path = command_resolves_to("flowix", target.as_deref());
    // `available_in_path` reflects this GUI process environment. On macOS,
    // updating ~/.zshrc does not mutate the already-running Tauri process PATH,
    // so the install state should be based on durable config instead.
    let needs_install = !symlink_installed || !path_configured;

    CliLinkStatus {
        target_path: target.as_ref().map(|p| p.display().to_string()),
        bin_dir: bin_dir.display().to_string(),
        command_path: command_path.display().to_string(),
        symlink_installed,
        path_configured,
        available_in_path,
        shell_config_path: shell_config_path(&home).map(|p| p.display().to_string()),
        needs_install,
        message: target
            .is_none()
            .then(|| "flowix-cli sidecar not found".to_string()),
    }
}

pub fn install_cli_path() -> Result<CliLinkStatus, String> {
    #[cfg(windows)]
    {
        ensure_windows_cli_shim()?;
        return Ok(windows_cli_link_status(true));
    }

    ensure_cli_symlink();
    let home = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    let bin_dir = home.join(".local").join("bin");
    if !bin_dir.exists() {
        std::fs::create_dir_all(&bin_dir)
            .map_err(|e| format!("failed to create {}: {e}", bin_dir.display()))?;
    }
    ensure_shell_path_config(&home, &bin_dir)?;
    Ok(cli_link_status())
}

/// 单个 symlink 的幂等创建。 失败只 warn, 不影响其他 symlink。
fn ensure_one_symlink(bin_dir: &Path, name: &str, target: &Path) {
    let link = bin_dir.join(name);

    // 已有 symlink ── 看指向哪。
    match std::fs::read_link(&link) {
        Ok(existing) if paths_match(&existing, target) => {
            tracing::debug!("[cli-link] {} already points to sidecar", link.display());
            return;
        }
        Ok(existing) => {
            // 指向别处 ── 删掉重建。 用户手动改过 symlink 我们也尊重
            // (写到跟 Flowix 同步更新的真源), 但 log 一下。
            tracing::info!(
                "[cli-link] {} pointed to {}; rewriting to {}",
                link.display(),
                existing.display(),
                target.display()
            );
            if let Err(e) = std::fs::remove_file(&link) {
                tracing::warn!(
                    "[cli-link] failed to remove stale symlink {}: {e}",
                    link.display()
                );
                return;
            }
        }
        Err(_) => {
            // 不是 symlink (可能不存在, 也可能是普通文件) ── 落到下面的
            // is_file() 分支去判别。
        }
    }

    // 链接位置被一个普通文件占了 ── 不能覆盖, 怕把用户脚本删了。
    if link.is_file() {
        tracing::warn!(
            "[cli-link] {} exists and is a regular file; not overwriting. \
             remove it manually if you want the symlink.",
            link.display()
        );
        return;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        match symlink(target, &link) {
            Ok(()) => tracing::info!(
                "[cli-link] symlinked {} → {} (add ~/.local/bin to $PATH if not already)",
                link.display(),
                target.display()
            ),
            Err(e) => tracing::warn!("[cli-link] symlink {} failed: {e}", link.display()),
        }
    }

    // Windows 上不做事 ── `.cmd` shim 由 NSIS hook 处理
    // (`app/flowix-desktop/nsis/flowix-cli-path.nsh`)。
    #[cfg(not(unix))]
    {
        tracing::debug!(
            "[cli-link] unix-only; {} skipped on this platform",
            link.display()
        );
    }
}

fn link_points_to(link: &Path, target: &Path) -> bool {
    std::fs::read_link(link)
        .map(|existing| paths_match(&existing, target))
        .unwrap_or(false)
}

/// 跟 `commands::cli::resolve_sidecar_path` 对齐 ── 两条候选路径,
/// 命中任一即可。 Prod 优先 (跟主二进制同目录), 然后 dev fallback
/// (`CARGO_MANIFEST_DIR/binaries/flowix-cli`)。 后者让 dev 模式下
/// 也能验证 symlink 行为 ── 链接会指向用户 checkout 里的 cargo 产物,
/// 切回 prod 安装包时, 下次启动会被 `paths_match` 检测到错指并重建。
fn current_sidecar_path() -> Option<PathBuf> {
    // 1. prod: sidecar 跟主二进制同目录 (Tauri 2 `externalBin` 布局)。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let prod = parent.join("flowix-cli");
            if prod.exists() {
                return Some(prod);
            }
            #[cfg(windows)]
            {
                let prod_exe = prod.with_extension("exe");
                if prod_exe.exists() {
                    return Some(prod_exe);
                }
            }
        }
    }
    // 2. dev fallback: `app/flowix-desktop/binaries/flowix-cli` (构建时
    //    硬编码进二进制的 manifest 路径, build-cli.sh 维护的 symlink)。
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("flowix-cli");
    if dev.exists() {
        return Some(dev);
    }
    #[cfg(windows)]
    {
        let dev_exe = dev.with_extension("exe");
        if dev_exe.exists() {
            return Some(dev_exe);
        }
    }
    None
}

fn path_contains_dir(dir: &Path) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|entry| paths_match(&entry, dir))
}

fn command_resolves_to(command: &str, expected: Option<&Path>) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path) {
        for candidate in command_candidates(&dir, command) {
            if candidate.exists() {
                return expected
                    .map(|target| paths_match(&candidate, target))
                    .unwrap_or(true);
            }
        }
    }
    false
}

fn command_candidates(dir: &Path, command: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        vec![
            dir.join(command),
            dir.join(format!("{command}.cmd")),
            dir.join(format!("{command}.exe")),
            dir.join(format!("{command}.bat")),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![dir.join(command)]
    }
}

#[cfg(windows)]
fn windows_cli_bin_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join("Flowix").join("bin"))
}

#[cfg(windows)]
fn windows_cli_link_status(include_user_path: bool) -> CliLinkStatus {
    let Some(bin_dir) = windows_cli_bin_dir() else {
        return CliLinkStatus {
            target_path: None,
            bin_dir: String::new(),
            command_path: String::new(),
            symlink_installed: false,
            path_configured: false,
            available_in_path: false,
            shell_config_path: None,
            needs_install: true,
            message: Some("LOCALAPPDATA unavailable".into()),
        };
    };
    let command_path = bin_dir.join("flowix.cmd");
    let target = current_sidecar_path();
    let symlink_installed = target
        .as_ref()
        .is_some_and(|target| windows_shim_points_to(&command_path, target));
    let path_configured = path_contains_dir(&bin_dir)
        || (include_user_path && windows_user_path_contains_dir(&bin_dir).unwrap_or(false));
    let available_in_path = command_resolves_to("flowix", None) || path_configured;
    let needs_install = !symlink_installed || !path_configured;

    CliLinkStatus {
        target_path: target.as_ref().map(|p| p.display().to_string()),
        bin_dir: bin_dir.display().to_string(),
        command_path: command_path.display().to_string(),
        symlink_installed,
        path_configured,
        available_in_path,
        shell_config_path: None,
        needs_install,
        message: target
            .is_none()
            .then(|| "flowix-cli sidecar not found".to_string()),
    }
}

#[cfg(windows)]
fn ensure_windows_cli_shim() -> Result<(), String> {
    let target =
        current_sidecar_path().ok_or_else(|| "flowix-cli sidecar not found".to_string())?;
    let bin_dir = windows_cli_bin_dir().ok_or_else(|| "LOCALAPPDATA unavailable".to_string())?;
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("failed to create {}: {e}", bin_dir.display()))?;

    let command_path = bin_dir.join("flowix.cmd");
    std::fs::write(&command_path, windows_shim_content(&target))
        .map_err(|e| format!("failed to write {}: {e}", command_path.display()))?;
    let legacy_path = bin_dir.join("flowix-cli.cmd");
    if legacy_path.exists() {
        std::fs::remove_file(&legacy_path)
            .map_err(|e| format!("failed to remove {}: {e}", legacy_path.display()))?;
    }
    ensure_windows_user_path_config(&bin_dir)?;
    Ok(())
}

#[cfg(windows)]
fn windows_shim_points_to(shim: &Path, target: &Path) -> bool {
    std::fs::read_to_string(shim)
        .map(|content| {
            normalize_newlines(&content) == normalize_newlines(&windows_shim_content(target))
        })
        .unwrap_or(false)
}

#[cfg(windows)]
fn windows_shim_content(target: &Path) -> String {
    format!("@echo off\r\n\"{}\" %*\r\n", target.display())
}

#[cfg(windows)]
fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").trim().to_string()
}

#[cfg(windows)]
fn windows_user_path_contains_dir(dir: &Path) -> Result<bool, String> {
    match windows_user_path_registry_value() {
        Ok(Some(value)) => return Ok(path_value_contains_dir(&value, dir)),
        Ok(None) => return Ok(false),
        Err(err) => {
            tracing::warn!(
                "[cli-link] registry read of HKCU\\Environment\\Path failed, falling back to PowerShell: {err}"
            );
        }
    }

    let output = windows_hidden_command(
        "powershell.exe",
        &[
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "[Environment]::GetEnvironmentVariable('Path','User')",
        ],
    )?;
    Ok(path_value_contains_dir(&output, dir))
}

#[cfg(windows)]
fn ensure_windows_user_path_config(dir: &Path) -> Result<(), String> {
    if windows_user_path_contains_dir(dir).unwrap_or(false) {
        return Ok(());
    }
    match ensure_windows_user_path_config_registry(dir) {
        Ok(()) => return Ok(()),
        Err(err) => {
            tracing::warn!(
                "[cli-link] registry update of HKCU\\Environment\\Path failed, falling back to PowerShell: {err}"
            );
        }
    }

    let dir = powershell_single_quoted(&dir.display().to_string());
    let script = format!(
        "$p=[Environment]::GetEnvironmentVariable('Path','User');\
         if ([string]::IsNullOrEmpty($p)) {{$n={dir}}} else {{$n=$p+';'+{dir}}};\
         [Environment]::SetEnvironmentVariable('Path',$n,'User')"
    );
    let _ = windows_hidden_command(
        "powershell.exe",
        &[
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ],
    )?;
    Ok(())
}

#[cfg(windows)]
struct WindowsRegistryKey(windows::Win32::System::Registry::HKEY);

#[cfg(windows)]
impl Drop for WindowsRegistryKey {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::System::Registry::RegCloseKey(self.0);
        }
    }
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct RegistryStringType(windows::Win32::System::Registry::REG_VALUE_TYPE);

#[cfg(windows)]
impl RegistryStringType {
    fn fallback() -> Self {
        Self(windows::Win32::System::Registry::REG_EXPAND_SZ)
    }

    fn supported(self) -> bool {
        use windows::Win32::System::Registry::{REG_EXPAND_SZ, REG_SZ};
        self.0 == REG_SZ || self.0 == REG_EXPAND_SZ
    }
}

#[cfg(windows)]
fn open_windows_environment_key(
    access: windows::Win32::System::Registry::REG_SAM_FLAGS,
) -> Result<WindowsRegistryKey, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegOpenKeyExW, HKEY, HKEY_CURRENT_USER};

    let subkey = wide_null("Environment");
    let mut key = HKEY::default();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            None,
            access,
            &mut key,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "RegOpenKeyExW(HKCU\\Environment) failed: {}",
            status.0
        ));
    }
    Ok(WindowsRegistryKey(key))
}

#[cfg(windows)]
fn windows_user_path_registry_value() -> Result<Option<String>, String> {
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegQueryValueExW, KEY_READ, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    };

    let key = open_windows_environment_key(KEY_READ)?;
    let value_name = wide_null("Path");
    let value_name = windows::core::PCWSTR(value_name.as_ptr());
    let mut value_type = REG_VALUE_TYPE(0);
    let mut byte_len = 0u32;
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            value_name,
            None,
            Some(&mut value_type),
            None,
            Some(&mut byte_len),
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS && status != ERROR_MORE_DATA {
        return Err(format!("RegQueryValueExW(Path size) failed: {}", status.0));
    }
    if value_type != REG_SZ && value_type != REG_EXPAND_SZ {
        return Err(format!(
            "HKCU\\Environment\\Path has unsupported registry type {}",
            value_type.0
        ));
    }
    if byte_len == 0 {
        return Ok(Some(String::new()));
    }

    let mut bytes = vec![0u8; byte_len as usize];
    let mut actual_type = REG_VALUE_TYPE(0);
    let mut actual_byte_len = byte_len;
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            value_name,
            None,
            Some(&mut actual_type),
            Some(bytes.as_mut_ptr()),
            Some(&mut actual_byte_len),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("RegQueryValueExW(Path data) failed: {}", status.0));
    }
    if actual_type != REG_SZ && actual_type != REG_EXPAND_SZ {
        return Err(format!(
            "HKCU\\Environment\\Path has unsupported registry type {}",
            actual_type.0
        ));
    }
    bytes.truncate(actual_byte_len as usize);
    Ok(Some(decode_registry_utf16_string(&bytes)))
}

#[cfg(windows)]
fn ensure_windows_user_path_config_registry(dir: &Path) -> Result<(), String> {
    use windows::Win32::System::Registry::{KEY_READ, KEY_SET_VALUE, REG_SAM_FLAGS};

    let current = windows_user_path_registry_value_with_type()?;
    let dir_text = dir.display().to_string();
    let (current_path, value_type) = current
        .map(|(value, value_type)| (value, value_type))
        .unwrap_or_else(|| (String::new(), RegistryStringType::fallback()));

    if path_value_contains_dir(&current_path, dir) {
        return Ok(());
    }

    let next_path = if current_path.trim().is_empty() {
        dir_text
    } else {
        format!("{};{}", current_path.trim_end_matches(';'), dir_text)
    };

    let access = REG_SAM_FLAGS(KEY_READ.0 | KEY_SET_VALUE.0);
    let key = open_windows_environment_key(access)?;
    set_windows_user_path_registry_value(&key, &next_path, value_type)?;
    broadcast_windows_environment_change();
    Ok(())
}

#[cfg(windows)]
fn windows_user_path_registry_value_with_type(
) -> Result<Option<(String, RegistryStringType)>, String> {
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{RegQueryValueExW, KEY_READ, REG_VALUE_TYPE};

    let key = open_windows_environment_key(KEY_READ)?;
    let value_name = wide_null("Path");
    let value_name = windows::core::PCWSTR(value_name.as_ptr());
    let mut value_type = REG_VALUE_TYPE(0);
    let mut byte_len = 0u32;
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            value_name,
            None,
            Some(&mut value_type),
            None,
            Some(&mut byte_len),
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS && status != ERROR_MORE_DATA {
        return Err(format!("RegQueryValueExW(Path size) failed: {}", status.0));
    }

    let value_type = RegistryStringType(value_type);
    if !value_type.supported() {
        return Err(format!(
            "HKCU\\Environment\\Path has unsupported registry type {}",
            value_type.0 .0
        ));
    }
    if byte_len == 0 {
        return Ok(Some((String::new(), value_type)));
    }

    let mut bytes = vec![0u8; byte_len as usize];
    let mut actual_type = REG_VALUE_TYPE(0);
    let mut actual_byte_len = byte_len;
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            value_name,
            None,
            Some(&mut actual_type),
            Some(bytes.as_mut_ptr()),
            Some(&mut actual_byte_len),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("RegQueryValueExW(Path data) failed: {}", status.0));
    }
    let actual_type = RegistryStringType(actual_type);
    if !actual_type.supported() {
        return Err(format!(
            "HKCU\\Environment\\Path has unsupported registry type {}",
            actual_type.0 .0
        ));
    }
    bytes.truncate(actual_byte_len as usize);
    Ok(Some((decode_registry_utf16_string(&bytes), actual_type)))
}

#[cfg(windows)]
fn set_windows_user_path_registry_value(
    key: &WindowsRegistryKey,
    value: &str,
    value_type: RegistryStringType,
) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::RegSetValueExW;

    let value_name = wide_null("Path");
    let encoded = wide_null(value);
    let bytes = unsafe {
        std::slice::from_raw_parts(
            encoded.as_ptr().cast::<u8>(),
            encoded.len() * std::mem::size_of::<u16>(),
        )
    };
    let status = unsafe {
        RegSetValueExW(
            key.0,
            PCWSTR(value_name.as_ptr()),
            None,
            value_type.0,
            Some(bytes),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("RegSetValueExW(Path) failed: {}", status.0));
    }
    Ok(())
}

#[cfg(windows)]
fn broadcast_windows_environment_change() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    let environment = wide_null("Environment");
    let mut result = 0usize;
    let sent = unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(environment.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            5_000,
            Some(&mut result),
        )
    };
    if sent.0 == 0 {
        tracing::warn!("[cli-link] WM_SETTINGCHANGE broadcast for Environment did not complete");
    }
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn decode_registry_utf16_string(bytes: &[u8]) -> String {
    let mut units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    while units.last().copied() == Some(0) {
        units.pop();
    }
    String::from_utf16_lossy(&units)
}

#[cfg(windows)]
fn windows_hidden_command(program: &str, args: &[&str]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = std::process::Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
fn path_value_contains_dir(path_value: &str, dir: &Path) -> bool {
    let expected = normalize_path_text(&dir.display().to_string());
    path_value
        .split(';')
        .map(normalize_path_text)
        .any(|entry| entry == expected)
}

#[cfg(windows)]
fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn normalize_path_text(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_end_matches('\\')
        .to_lowercase()
}

fn shell_config_path(home: &Path) -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_default();
    let name = Path::new(&shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("zsh");
    match name {
        "bash" => Some(home.join(".bashrc")),
        "fish" => Some(home.join(".config").join("fish").join("config.fish")),
        _ => Some(home.join(".zshrc")),
    }
}

fn shell_config_contains_bin_dir(home: &Path) -> bool {
    let candidates = [
        home.join(".zshrc"),
        home.join(".zprofile"),
        home.join(".bashrc"),
        home.join(".bash_profile"),
        home.join(".profile"),
        home.join(".config").join("fish").join("config.fish"),
    ];
    candidates.iter().any(|path| {
        std::fs::read_to_string(path)
            .map(|content| {
                content.contains("$HOME/.local/bin")
                    || content.contains("~/.local/bin")
                    || content.contains(&home.join(".local").join("bin").display().to_string())
            })
            .unwrap_or(false)
    })
}

fn ensure_shell_path_config(home: &Path, bin_dir: &Path) -> Result<(), String> {
    if path_contains_dir(bin_dir) || shell_config_contains_bin_dir(home) {
        return Ok(());
    }
    let Some(path) = shell_config_path(home) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    let mut prefix = String::new();
    if path.exists() {
        let existing = std::fs::read_to_string(&path)
            .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
        if !existing.ends_with('\n') && !existing.is_empty() {
            prefix.push('\n');
        }
    }
    let line = if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "config.fish")
    {
        FISH_PATH_EXPORT_LINE
    } else {
        SH_PATH_EXPORT_LINE
    };
    let block = format!("{prefix}\n# Flowix CLI\n{line}\n");
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(block.as_bytes())
        })
        .map_err(|e| format!("failed to update {}: {e}", path.display()))
}

/// 比两个路径是否指向同一文件。 直接 `==` 不靠谱 (相对 / 绝对 / 中间
/// 段 `./` 之类), 退到 `canonicalize` 拿真实路径再比 ── 任何一边
/// resolve 失败 (broken symlink / 不存在) 都当 "不同", 由 caller 决定
/// 重写。
fn paths_match(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    matches!(
        (std::fs::canonicalize(a), std::fs::canonicalize(b)),
        (Ok(ref x), Ok(ref y)) if x == y
    )
}
