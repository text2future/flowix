use std::path::PathBuf;

/// 用户配置目录名 (~/.<NAME>/ 下放 boot/preference.json / agent-config.toml /
/// notebook.json / boot/system.json)。
pub const USER_CONFIG_DIR_NAME: &str = ".flowix";

/// 桌面应用数据目录名 (在 `dirs::data_dir()` 之下, macOS:
/// `~/Library/Application Support/<NAME>/`)。
pub const APP_DATA_DIR_NAME: &str = "flowix";

pub fn get_app_data_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(APP_DATA_DIR_NAME)
}

pub fn get_user_config_dir(home_dir: &PathBuf) -> PathBuf {
    home_dir.join(USER_CONFIG_DIR_NAME)
}
