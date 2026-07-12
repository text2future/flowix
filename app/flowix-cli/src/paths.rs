//! CLI 路径解析 + 首次使用兜底。
//!
//! 解析流程:
//! 1. `FLOWIX_DATA` 环境变量优先, 否则走 `get_app_data_path()`
//! 2. `FLOWIX_HOME` 环境变量优先, 否则走 `get_user_config_dir($HOME)`
//!
//! 两个 env 覆盖主要用于: 脚本 / CI / 集成测试切换数据目录。
//!
//! 路径常量属于应用入口职责，业务核心 (`flowix-core`) 不依赖这些目录约定。

use std::path::PathBuf;

use crate::errors::CliError;

/// 用户配置目录名 (~/.<NAME>/ 下放 preference.json / flowix-ai-config.toml /
/// notebook.json / global_meta_data.json)。
pub const USER_CONFIG_DIR_NAME: &str = ".flowix";

/// 桌面应用数据目录名 (在 `dirs::data_dir()` 之下, macOS:
/// `~/Library/Application Support/<NAME>/`)。
pub const APP_DATA_DIR_NAME: &str = "flowix";

/// 解析后的三组路径, 给 store.rs 用来构造 `MemoFile`。
pub struct Resolved {
    /// `~/Library/Application Support/flowix` (macOS)
    /// 或 `$XDG_DATA_HOME/flowix` (Linux)
    #[allow(dead_code)]
    pub app_data: PathBuf,
    /// `~/.flowix/`
    #[allow(dead_code)]
    pub config_dir: PathBuf,
    /// `~/.flowix/notebook.json`
    pub notebook_file: PathBuf,
}

pub fn resolve() -> Result<Resolved, CliError> {
    let home = dirs::home_dir().ok_or_else(|| {
        CliError::Usage("cannot resolve home directory (no $HOME / $USERPROFILE)".into())
    })?;

    let app_data = std::env::var("FLOWIX_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| get_app_data_path());

    let config_dir = std::env::var("FLOWIX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| get_user_config_dir(&home));

    let notebook_file = config_dir.join("notebook.json");

    Ok(Resolved {
        app_data,
        config_dir,
        notebook_file,
    })
}

pub fn get_app_data_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(APP_DATA_DIR_NAME)
}

pub fn get_user_config_dir(home_dir: &PathBuf) -> PathBuf {
    home_dir.join(USER_CONFIG_DIR_NAME)
}
