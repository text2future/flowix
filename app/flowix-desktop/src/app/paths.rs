use std::path::PathBuf;

/// 鐢ㄦ埛閰嶇疆鐩綍鍚?(~/.<NAME>/ 涓嬫斁 index.db / boot/preference.json /
/// agent-config.toml / boot/system.json 绛?銆?
pub const USER_CONFIG_DIR_NAME: &str = ".flowix";

/// 妗岄潰搴旂敤鏁版嵁鐩綍鍚?(鍦?`dirs::data_dir()` 涔嬩笅, macOS:
/// `~/Library/Application Support/<NAME>/`)銆?
pub const APP_DATA_DIR_NAME: &str = "flowix";

pub fn get_app_data_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(APP_DATA_DIR_NAME)
}

pub fn get_user_config_dir(home_dir: &PathBuf) -> PathBuf {
    home_dir.join(USER_CONFIG_DIR_NAME)
}
