//! 棣栨鍚姩鏃跺湪 `~/.local/bin/` 寤?`flowix` symlink,
//! 鎶婂唴宓?sidecar 鏆撮湶鍒扮敤鎴?`$PATH`, 杩欐牱瑁呭畬妗岄潰搴旂敤鍚庣粓绔兘鐩存帴
//! `flowix ...`銆?//!
//! ## 璁捐
//!
//! - **骞傜瓑**: 姣忔鍚姩閮借窇, 浣嗗彧鍦?symlink 涓嶅瓨鍦?/ 鎸囧悜閿欒鐩爣 /
//!   宸叉崯鍧忔椂瀹為檯鍐欑洏銆?鐢ㄦ埛鎵嬪姩鍒犱簡涓嬫鍚姩鑷姩鎭㈠ 鈹€鈹€ 姣?"marker file
//!   鍙窇涓€娆? 椴佹銆?//! - **澶辫触瀹藉**: 浠讳綍 I/O 閿欒 (鏉冮檺 / 纾佺洏婊?/ 鍙 fs) 閮藉彧
//!   `tracing::warn!`, 涓?panic / 涓?propagate 鈹€鈹€ CLI 瑁呬笉涓婁笉褰卞搷 GUI銆?//! - **鑼冨洿**: macOS + Linux 鍚姩鏃跺缓 symlink銆?Windows 涓婄殑绛夋晥瀹炵幇
//!   鍦?`app/flowix-desktop/nsis/flowix-cli-path.nsh` 鈹€鈹€ 瑁呭寘鏃跺缓 .cmd shim
//!   鍒?`$LOCALAPPDATA\Flowix\bin\`銆?//!
//! ## 璺緞閫夋嫨
//!
//! - **閾炬帴婧?(target)**: `current_exe().parent().join("flowix-cli")` 鈹€鈹€
//!   Tauri 2 鐨?`externalBin` 鏈哄埗鎶?sidecar 鏀惧湪涓讳簩杩涘埗鏃佽竟, dev
//!   (`app/target/<host>/debug/flowix-cli`) 璺?prod
//!   (`/Applications/Flowix.app/Contents/MacOS/flowix-cli`) 閮芥槸鍚?//!   layout銆?璺?`commands::cli::resolve_sidecar_path` 鐨?prod 鍒嗘敮涓€鑷淬€?//! - **閾炬帴浣嶇疆 (link)**: `$HOME/.local/bin/flowix` 鈹€鈹€ XDG
//!   鐢ㄦ埛绾?bin 鐩綍銆?macOS / 澶氭暟 Linux 鍙戣鐗堢殑 zsh / bash **榛樿**
//!   涓嶅湪 `$PATH`, 鐢ㄦ埛闇€瑕?`export PATH="$HOME/.local/bin:$PATH"` 鍔犺繘
//!   `~/.zshrc`銆?鍚姩 hook 涓嶈嚜鍔ㄦ敼 shell config; 鍋忓ソ璁剧疆閲岀殑鏄惧紡
//!   "瀹夎" 鎿嶄綔鎵嶄細鍐欏叆銆?//!
//! ## 閲嶅悕瀹夊叏
//!
//! - macOS: 妗岄潰 binary 瑁呭湪 `.app` 鍖呭唴 (`/Applications/Flowix.app/...`),
//!   **涓嶅湪** `$PATH`, 鎵€浠?`~/.local/bin/flowix` 涓嶄細琚畠閬斀銆?//! - Linux: 鑻?`.deb` 鎶婃闈?binary 瑁呭埌 `/usr/bin/flowix`, 鑰岀敤鎴?//!   `$PATH` 閲?`~/.local/bin` 鍦?`/usr/bin` **涔嬪墠** (澶氭暟鍙戣鐗堥粯璁?,
//!   symlink 鑳滃嚭銆?閫€涓€姝ヨ, 鐢ㄦ埛瑁呮垜浠繖搴旂敤鏃? `/usr/bin/flowix` 鍏垚
//!   灏辨槸鎴戜滑瑁呯殑鍚屼竴涓?sidecar 鈹€鈹€ 鍗充究涓や釜 entry 閮藉湪 PATH, 鎸囧悜鍚屼竴浠?//!   inode 涔熸棤瀹炽€?
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

/// 鍦ㄧ敤鎴风骇 bin 鐩綍閲屽缓 `flowix` symlink銆?浠讳綍姝ラ澶辫触閮?`warn!` 鍚庤繑鍥?
/// 涓?panic / 涓?propagate 閿欒銆?
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

    // 鐩綍涓嶅瓨鍦ㄥ氨寤恒€?`~/.local/bin` 鍦?macOS 榛樿涓嶅瓨鍦?鈹€鈹€ 鍒涗簡
    // 鎵嶈兘鏀?symlink銆?寤鸿繃涓€娆″け璐ュ氨鍒噸璇? 鍚庣画 link 鍏ㄩ儴璺宠繃銆?
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

/// 鍗曚釜 symlink 鐨勫箓绛夊垱寤恒€?澶辫触鍙?warn, 涓嶅奖鍝嶅叾浠?symlink銆?
fn ensure_one_symlink(bin_dir: &Path, name: &str, target: &Path) {
    let link = bin_dir.join(name);

    // 宸叉湁 symlink 鈹€鈹€ 鐪嬫寚鍚戝摢銆?
    match std::fs::read_link(&link) {
        Ok(existing) if paths_match(&existing, target) => {
            tracing::debug!("[cli-link] {} already points to sidecar", link.display());
            return;
        }
        Ok(existing) => {
            // 鎸囧悜鍒 鈹€鈹€ 鍒犳帀閲嶅缓銆?鐢ㄦ埛鎵嬪姩鏀硅繃 symlink 鎴戜滑涔熷皧閲?
            // (鍐欏埌璺?Flowix 鍚屾鏇存柊鐨勭湡婧?, 浣?log 涓€涓嬨€?
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
            // 涓嶆槸 symlink (鍙兘涓嶅瓨鍦? 涔熷彲鑳芥槸鏅€氭枃浠? 鈹€鈹€ 钀藉埌涓嬮潰鐨?
            // is_file() 鍒嗘敮鍘诲垽鍒€?
        }
    }

    // 閾炬帴浣嶇疆琚竴涓櫘閫氭枃浠跺崰浜?鈹€鈹€ 涓嶈兘瑕嗙洊, 鎬曟妸鐢ㄦ埛鑴氭湰鍒犱簡銆?
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
                "[cli-link] symlinked {} 鈫?{} (add ~/.local/bin to $PATH if not already)",
                link.display(),
                target.display()
            ),
            Err(e) => tracing::warn!("[cli-link] symlink {} failed: {e}", link.display()),
        }
    }

    // Windows 涓婁笉鍋氫簨 鈹€鈹€ `.cmd` shim 鐢?NSIS hook 澶勭悊
    // (`app/flowix-desktop/nsis/flowix-cli-path.nsh`)銆?
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

/// 璺?`commands::cli::resolve_sidecar_path` 瀵归綈 鈹€鈹€ 涓ゆ潯鍊欓€夎矾寰?
/// 鍛戒腑浠讳竴鍗冲彲銆?Prod 浼樺厛 (璺熶富浜岃繘鍒跺悓鐩綍), 鐒跺悗 dev fallback
/// (`CARGO_MANIFEST_DIR/binaries/flowix-cli`)銆?鍚庤€呰 dev 妯″紡涓?/// 涔熻兘楠岃瘉 symlink 琛屼负 鈹€鈹€ 閾炬帴浼氭寚鍚戠敤鎴?checkout 閲岀殑 cargo 浜х墿,
/// 鍒囧洖 prod 瀹夎鍖呮椂, 涓嬫鍚姩浼氳 `paths_match` 妫€娴嬪埌閿欐寚骞堕噸寤恒€?
fn current_sidecar_path() -> Option<PathBuf> {
    // 1. prod: sidecar 璺熶富浜岃繘鍒跺悓鐩綍 (Tauri 2 `externalBin` 甯冨眬)銆?
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
    // 2. dev fallback: `app/flowix-desktop/binaries/flowix-cli` (鏋勫缓鏃?    //    纭紪鐮佽繘浜岃繘鍒剁殑 manifest 璺緞, build-cli.sh 缁存姢鐨?symlink)銆?
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

/// 姣斾袱涓矾寰勬槸鍚︽寚鍚戝悓涓€鏂囦欢銆?鐩存帴 `==` 涓嶉潬璋?(鐩稿 / 缁濆 / 涓棿
/// 娈?`./` 涔嬬被), 閫€鍒?`canonicalize` 鎷跨湡瀹炶矾寰勫啀姣?鈹€鈹€ 浠讳綍涓€杈?/// resolve 澶辫触 (broken symlink / 涓嶅瓨鍦? 閮藉綋 "涓嶅悓", 鐢?caller 鍐冲畾
/// 閲嶅啓銆?
fn paths_match(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    matches!(
        (std::fs::canonicalize(a), std::fs::canonicalize(b)),
        (Ok(ref x), Ok(ref y)) if x == y
    )
}
