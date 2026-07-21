use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::RwLock;

/// 杩涚▼绾?external CLI 璺緞娉ㄥ唽琛?鈹€鈹€ 鍚姩鏃剁敱 `agent_external_config` 妯″潡浠?/// `~/.flowix/agent-external-config.json` 鍔犺浇骞堕€氳繃 `set_external_cli_registry`
/// 鐏屽叆銆俙None` = 鏈惎鐢?(鍐峰惎鍔ㄥ皻鏈姞杞?/ 鍗曟祴), 姝ゆ椂 `resolve_external_cli`
/// 閫€鍖栦负鍘熸帰娴嬮摼鐨勭函鍑芥暟琛屼负, 淇濊瘉鐜版湁鍗曟祴闆舵敼鍔ㄣ€?///
/// "鍞竴鍙傜収"璇箟: 娉ㄥ唽琛ㄥ懡涓嵆鐢? 涓嶆牎楠屽彲鎵ц鎬с€佷笉鍥為€€鎺㈡祴銆俻ath 澶辨晥鐢?/// 涓婂眰 `executable_available` 鍒?false 鏍囩孩, 鐢卞亸濂借缃殑"閲嶆柊鎺㈡祴"鎸夐挳瑙﹀彂
/// 閲嶆帰 鈹€鈹€ 杩愯鏃剁粷涓嶈嚜鍔?fallback銆俴ey = `ExternalCliSpec::binary_name`銆?
static REGISTRY: RwLock<Option<HashMap<String, PathBuf>>> = RwLock::new(None);

pub(crate) struct ExternalCliSpec {
    pub binary_name: &'static str,
    #[cfg(windows)]
    pub windows_binary_name: &'static str,
    pub env_vars: &'static [&'static str],
    pub extra_unix_candidates: fn() -> Vec<PathBuf>,
    #[cfg(windows)]
    pub extra_windows_candidates: fn() -> Vec<PathBuf>,
}

pub(crate) fn no_extra_candidates() -> Vec<PathBuf> {
    Vec::new()
}

pub(crate) fn resolve_external_cli(spec: &ExternalCliSpec) -> PathBuf {
    // 鍞竴鍙傜収: 娉ㄥ唽琛ㄩ噷鏈夎 CLI 鐨勮褰曞氨鐩存帴鐢? 涓嶆牎楠屽彲鎵ц鎬с€佷笉鍥為€€鎺㈡祴銆?
    if let Some(path) = lookup_registry(spec.binary_name) {
        return path;
    }
    resolve_external_cli_uncached(spec)
}

/// 璺宠繃娉ㄥ唽琛ㄧ殑绾帰娴嬮摼 鈹€鈹€ 渚涘惎鍔ㄦ帰娴?/ 閲嶆柊鎺㈡祴 / 鍗曟祴浣跨敤銆?///
/// 浼樺厛绾? env var > PATH `which` > 鍥哄畾鍊欓€夌洰褰?> 鐧诲綍 shell `command -v`銆?
pub(crate) fn resolve_external_cli_uncached(spec: &ExternalCliSpec) -> PathBuf {
    for env_var in spec.env_vars {
        if let Ok(path) = std::env::var(env_var) {
            let path = PathBuf::from(path);
            if is_executable_file(&path) {
                return path;
            }
        }
    }

    #[cfg(windows)]
    {
        for candidate in external_cli_candidate_paths(spec) {
            if is_executable_file(&candidate) {
                return candidate;
            }
        }
        if let Some(found) = query_cli_binary_once(spec.windows_binary_name) {
            return found;
        }
        PathBuf::from(spec.windows_binary_name)
    }

    #[cfg(not(windows))]
    {
        if let Some(found) = which_in_path(spec.binary_name, std::env::var_os("PATH").as_deref()) {
            return found;
        }
        for candidate in external_cli_candidate_paths(spec) {
            if is_executable_file(&candidate) {
                return candidate;
            }
        }
        if let Some(found) = query_cli_binary_once(spec.binary_name) {
            return found;
        }
        PathBuf::from(spec.binary_name)
    }
}

fn lookup_registry(binary_name: &str) -> Option<PathBuf> {
    REGISTRY
        .read()
        .unwrap_or_else(|poisoned| {
            tracing::error!("external CLI registry lock poisoned, recovering");
            poisoned.into_inner()
        })
        .as_ref()
        .and_then(|map| map.get(binary_name).cloned())
}

/// 鍚姩鏃舵妸 JSON config 鐨勫唴瀛橀暅鍍忕亴杩涙敞鍐岃〃銆傛鍚?`resolve_external_cli`
/// 鍛戒腑鍗崇敤, 涓嶅啀姣忔潯娑堟伅璺戞帰娴嬮摼銆?
pub(crate) fn set_external_cli_registry(entries: HashMap<String, PathBuf>) {
    *REGISTRY.write().unwrap_or_else(|poisoned| {
        tracing::error!("external CLI registry lock poisoned, recovering");
        poisoned.into_inner()
    }) = Some(entries);
}

/// 鏇存柊娉ㄥ唽琛ㄥ崟椤?鈹€鈹€ 鐢ㄦ埛鏀?path / 閲嶆柊鎺㈡祴鍚庤皟鐢ㄣ€?/// `path = None` 绉婚櫎璇ラ」, 浣?`resolve_external_cli` 鍥為€€鎺㈡祴 (閲嶆柊鎺㈡祴鐢?銆?
pub(crate) fn update_external_cli_path(binary_name: &str, path: Option<PathBuf>) {
    let mut guard = REGISTRY.write().unwrap_or_else(|poisoned| {
        tracing::error!("external CLI registry lock poisoned, recovering");
        poisoned.into_inner()
    });
    match (guard.as_mut(), path) {
        (Some(map), Some(p)) => {
            map.insert(binary_name.to_string(), p);
        }
        (Some(map), None) => {
            map.remove(binary_name);
        }
        (None, Some(p)) => {
            let mut map = HashMap::new();
            map.insert(binary_name.to_string(), p);
            *guard = Some(map);
        }
        (None, None) => {}
    }
}

/// 鍗曟祴涓撶敤: 鎶婃敞鍐岃〃娓呭洖 `None`, 鎭㈠绾嚱鏁版帰娴嬭涓? 闅旂娴嬭瘯闂村壇浣滅敤銆?
#[cfg(test)]
pub(crate) fn reset_external_cli_registry_for_test() {
    *REGISTRY
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

pub(crate) fn external_cli_candidate_paths(spec: &ExternalCliSpec) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut candidates = windows_common_cli_candidate_paths(spec.windows_binary_name);
        candidates.extend((spec.extra_windows_candidates)());
        candidates
    }

    #[cfg(not(windows))]
    {
        let mut candidates = unix_common_cli_candidate_paths(spec.binary_name);
        candidates.extend((spec.extra_unix_candidates)());
        candidates
    }
}

#[cfg(not(windows))]
fn unix_common_cli_candidate_paths(binary_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".npm-global/bin").join(binary_name));
        candidates.push(home.join(".npm/bin").join(binary_name));
        candidates.push(home.join(".local/bin").join(binary_name));
        candidates.push(home.join(".cargo/bin").join(binary_name));
        candidates.push(home.join(".bun/bin").join(binary_name));
        candidates.push(home.join(".volta/bin").join(binary_name));
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin").join(binary_name));
    candidates.push(PathBuf::from("/usr/local/bin").join(binary_name));
    candidates
}

#[cfg(windows)]
fn windows_common_cli_candidate_paths(windows_binary_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join("AppData")
                .join("Roaming")
                .join("npm")
                .join(windows_binary_name),
        );
    }
    candidates
}

/// Returns true iff `path` is a regular file the OS would actually execute.
pub(crate) fn is_executable_file(path: &Path) -> bool {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

pub(crate) fn which_in_path(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let path = path?;
    for dir in std::env::split_paths(path) {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn query_cli_binary_once(binary_name: &str) -> Option<PathBuf> {
    if !is_safe_binary_name(binary_name) {
        return None;
    }

    #[cfg(windows)]
    {
        query_cli_binary_with_where(binary_name)
    }

    #[cfg(not(windows))]
    {
        query_cli_binary_with_shell(binary_name)
    }
}

fn is_safe_binary_name(binary_name: &str) -> bool {
    !binary_name.is_empty()
        && binary_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

#[cfg(not(windows))]
fn query_cli_binary_with_shell(binary_name: &str) -> Option<PathBuf> {
    let shell = resolve_query_shell()?;
    let output = Command::new(shell)
        .args(["-lc", &format!("command -v {binary_name}")])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    first_executable_line(&output.stdout)
}

#[cfg(not(windows))]
fn resolve_query_shell() -> Option<PathBuf> {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| is_executable_file(path))
        .or_else(|| {
            ["/bin/zsh", "/bin/bash", "/bin/sh"]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| is_executable_file(path))
        })
}

#[cfg(windows)]
fn query_cli_binary_with_where(binary_name: &str) -> Option<PathBuf> {
    let mut cmd = Command::new("where.exe");
    crate::process_window::hide_std_command_window(&mut cmd);
    let output = cmd.arg(binary_name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    first_executable_line(&output.stdout)
}

fn first_executable_line(stdout: &[u8]) -> Option<PathBuf> {
    let text = String::from_utf8_lossy(stdout);
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| is_executable_file(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_external::acquire_test_env_lock as acquire_env_lock;

    #[test]
    fn rejects_unsafe_binary_names_for_query() {
        assert!(is_safe_binary_name("codex"));
        assert!(is_safe_binary_name("codex.cmd"));
        assert!(!is_safe_binary_name(""));
        assert!(!is_safe_binary_name("codex;rm"));
        assert!(!is_safe_binary_name("codex $(oops)"));
        assert!(!is_safe_binary_name("../codex"));
    }

    #[cfg(not(windows))]
    #[test]
    fn query_cli_binary_with_shell_finds_path_once() {
        let _guard = acquire_env_lock();
        let dir = std::env::temp_dir().join(format!(
            "flowix-cli-query-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let fake = dir.join("flowix-query-cli");
        std::fs::write(&fake, "#!/bin/sh\nexit 0\n").expect("write fake cli");
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&fake).expect("stat fake").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake, perms).expect("chmod fake cli");
        }

        let original_path = std::env::var_os("PATH");
        let original_shell = std::env::var_os("SHELL");
        std::env::set_var("PATH", &dir);
        std::env::set_var("SHELL", "/bin/sh");

        let found = query_cli_binary_once("flowix-query-cli");

        match original_path {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
        match original_shell {
            Some(value) => std::env::set_var("SHELL", value),
            None => std::env::remove_var("SHELL"),
        }
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(found, Some(fake));
    }
}
