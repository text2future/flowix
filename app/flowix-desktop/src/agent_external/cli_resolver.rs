use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::RwLock;

/// 进程级 external CLI 路径注册表 ── 启动时由 `agent_external_config` 模块从
/// `~/.flowix/agent-external-config.json` 加载并通过 `set_external_cli_registry`
/// 灌入。`None` = 未启用 (冷启动尚未加载 / 单测), 此时 `resolve_external_cli`
/// 退化为原探测链的纯函数行为, 保证现有单测零改动。
///
/// "唯一参照"语义: 注册表命中即用, 不校验可执行性、不回退探测。path 失效由
/// 上层 `executable_available` 判 false 标红, 由偏好设置的"重新探测"按钮触发
/// 重探 ── 运行时绝不自动 fallback。key = `ExternalCliSpec::binary_name`。
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
    // 唯一参照: 注册表里有该 CLI 的记录就直接用, 不校验可执行性、不回退探测。
    if let Some(path) = lookup_registry(spec.binary_name) {
        return path;
    }
    resolve_external_cli_uncached(spec)
}

/// 跳过注册表的纯探测链 ── 供启动探测 / 重新探测 / 单测使用。
///
/// 优先级: env var > PATH `which` > 固定候选目录 > 登录 shell `command -v`。
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

/// 启动时把 JSON config 的内存镜像灌进注册表。此后 `resolve_external_cli`
/// 命中即用, 不再每条消息跑探测链。
pub(crate) fn set_external_cli_registry(entries: HashMap<String, PathBuf>) {
    *REGISTRY.write().unwrap_or_else(|poisoned| {
        tracing::error!("external CLI registry lock poisoned, recovering");
        poisoned.into_inner()
    }) = Some(entries);
}

/// 更新注册表单项 ── 用户改 path / 重新探测后调用。
/// `path = None` 移除该项, 使 `resolve_external_cli` 回退探测 (重新探测用)。
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

/// 单测专用: 把注册表清回 `None`, 恢复纯函数探测行为, 隔离测试间副作用。
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
