use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::agent_external::cli_resolver::{is_executable_file, which_in_path};

/// Resolve a Node.js binary for CLI runtimes that may be installed as JS
/// scripts. Resolution order:
/// 1. runtime-specific env var
/// 2. current PATH
/// 3. common Node manager / package manager install locations
pub(crate) fn resolve_node_binary(env_var: &str) -> Option<PathBuf> {
    if let Ok(path) = std::env::var(env_var) {
        let path = PathBuf::from(path);
        if is_executable_file(&path) {
            return Some(path);
        }
    }

    if let Some(found) = which_in_path("node", std::env::var_os("PATH").as_deref()) {
        return Some(found);
    }

    node_candidate_paths()
        .into_iter()
        .find(|candidate| is_executable_file(candidate))
}

pub(crate) fn ensure_node_on_path(cmd: &mut Command) {
    if which_in_path("node", std::env::var_os("PATH").as_deref()).is_some() {
        return;
    }

    let mut seen = std::collections::HashSet::new();
    let mut extra_dirs: Vec<PathBuf> = Vec::new();
    for node in node_candidate_paths() {
        if let Some(parent) = node.parent() {
            if seen.insert(parent.to_path_buf()) {
                extra_dirs.push(parent.to_path_buf());
            }
        }
    }

    let merged: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .chain(extra_dirs)
        .collect();

    match std::env::join_paths(&merged) {
        Ok(joined) => {
            cmd.env("PATH", joined);
        }
        Err(err) => {
            tracing::warn!(
                error = %err,
                "failed to join node candidate dirs into PATH; \
                 keeping parent's PATH for child process",
            );
        }
    }
}

pub(crate) fn node_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(unix)]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin/node"));
        paths.push(PathBuf::from("/usr/local/bin/node"));
        paths.push(PathBuf::from("/usr/bin/node"));
    }

    let Some(home) = dirs::home_dir() else {
        return paths;
    };

    paths.push(home.join(".npm-global/bin/node"));
    paths.push(home.join(".npm/bin/node"));

    if let Some(latest) = latest_versioned_subdir(&home.join(".nvm/versions/node")) {
        paths.push(latest.join("bin/node"));
    }
    if let Some(latest) = latest_versioned_subdir(&home.join(".local/share/fnm/node-versions")) {
        paths.push(latest.join("installation/bin/node"));
    }

    paths.push(home.join(".volta/tools/image/node/current/bin/node"));

    #[cfg(unix)]
    {
        if let Some(latest) = latest_versioned_subdir(&home.join(".asdf/installs/nodejs")) {
            paths.push(latest.join("bin/node"));
        }
        if let Some(latest) = latest_versioned_subdir(&home.join(".asdf/installs/node")) {
            paths.push(latest.join("bin/node"));
        }
        paths.push(home.join("n/bin/node"));
    }

    paths
}

/// Parse a directory name like `v18.19.0` (nvm/fnm) or `18.19.0` (asdf) into
/// a (major, minor, patch) tuple.
pub(crate) fn parse_node_version(dir_name: &str) -> Option<(u32, u32, u32)> {
    let head: &str = match dir_name
        .strip_prefix('v')
        .or_else(|| dir_name.strip_prefix('V'))
    {
        Some(rest) => rest,
        None => dir_name,
    };
    let head = head.split('-').next()?;
    let mut parts = head.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    let patch: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Pick the highest-versioned subdirectory under `root` by semantic version.
pub(crate) fn latest_versioned_subdir(root: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut parsed: Vec<((u32, u32, u32), PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let file_name = path.file_name()?;
            let file_name_str = file_name.to_str()?;
            let version = parse_node_version(file_name_str)?;
            Some((version, path))
        })
        .collect();
    if parsed.is_empty() {
        return None;
    }
    parsed.sort_by(|a, b| b.0.cmp(&a.0));
    Some(parsed.into_iter().next()?.1)
}
