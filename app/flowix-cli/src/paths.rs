//! CLI 路径解析 + 首次使用兜底。
//!
//! 解析流程:
//! 1. `FLOWIX_HOME` 环境变量优先, 否则走 `get_user_config_dir($HOME)`
//!
//! 该覆盖主要用于: 脚本 / CI / 集成测试切换数据目录。
//!
//! 路径常量属于应用入口职责，业务核心 (`flowix-core`) 不依赖这些目录约定。

use std::path::{Path, PathBuf};

use crate::errors::CliError;

/// 用户配置目录名 (~/.<NAME>/ 下放 db/local.db / boot/preference.json /
/// agent-config.toml / boot/system.json 等)。
pub const USER_CONFIG_DIR_NAME: &str = ".flowix";

/// 解析后的路径, 给 store.rs 用来构造 `MemoFile`。
pub struct Resolved {
    /// `~/.flowix/`. 笔记本注册表位于 `<config_dir>/db/local.db`.
    pub config_dir: PathBuf,
}

pub fn resolve() -> Result<Resolved, CliError> {
    let home = dirs::home_dir().ok_or_else(|| {
        CliError::Usage("cannot resolve home directory (no $HOME / $USERPROFILE)".into())
    })?;

    let config_dir = std::env::var("FLOWIX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| get_user_config_dir(&home));

    Ok(Resolved { config_dir })
}

pub fn get_user_config_dir(home_dir: &Path) -> PathBuf {
    home_dir.join(USER_CONFIG_DIR_NAME)
}
